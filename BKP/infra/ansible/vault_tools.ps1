param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Info', 'ListKeys', 'ListRedacted', 'RenameKeys', 'MigrateTaskyCreds')]
  [string]$Action,

  [string]$VaultPath = 'infra/ansible/vault/secrets.yml',
  [string]$VaultPassPath = 'infra/ansible/.vault_pass',

  [string]$MapJson = '{}'
  ,
  [string]$EnsureJson = '{}'
)

$ErrorActionPreference = 'Stop'

function Convert-HexToBytes([string]$hex) {
  $clean = ($hex -replace '\s', '').ToLowerInvariant()
  if (($clean.Length % 2) -ne 0) { throw 'Invalid hex length' }
  $bytes = New-Object byte[] ($clean.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($clean.Substring($i * 2, 2), 16)
  }
  return $bytes
}

function Convert-BytesToHex([byte[]]$bytes) {
  return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Test-BytesEqual([byte[]]$a, [byte[]]$b) {
  if ($null -eq $a -or $null -eq $b) { return $false }
  if ($a.Length -ne $b.Length) { return $false }
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ($a[$i] -ne $b[$i]) { return $false }
  }
  return $true
}

function Read-VaultFile([string]$path) {
  $lines = @(Get-Content -LiteralPath $path)
  if ($lines.Count -lt 1) { throw "Empty vault file: $path" }

  $header = '$ANSIBLE_VAULT;1.1;AES256'
  $first = $lines[0]
  if (-not $first.StartsWith($header)) {
    throw "Unsupported vault header in $path"
  }

  $hexLines = @()
  if ($first.Length -gt $header.Length) {
    $hexLines += $first.Substring($header.Length)
  }
  if ($lines.Count -gt 1) {
    $hexLines += ($lines | Select-Object -Skip 1)
  }
  $hex = ($hexLines) -join ''
  return Convert-HexToBytes $hex
}

function Split-VaultPayload([byte[]]$vaultBytes) {
  $vaultText = [Text.Encoding]::UTF8.GetString($vaultBytes)
  $parts = $vaultText -split "`n"
  if ($parts.Count -lt 3) { throw 'Unexpected vault payload format' }
  $saltHex = $parts[0].Trim()
  $hmacHex = $parts[1].Trim()
  $cipherHex = ($parts[2..($parts.Count - 1)] -join "`n").Trim()
  return @{
    SaltHex   = $saltHex
    HmacHex   = $hmacHex
    CipherHex = $cipherHex
  }
}

function Derive-Keys([string]$password, [byte[]]$salt, [int]$iterations = 10000) {
  $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
    [Text.Encoding]::UTF8.GetBytes($password),
    $salt,
    $iterations,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  $material = $kdf.GetBytes(80)
  return @{
    EncKey  = $material[0..31]
    HmacKey = $material[32..63]
    IV      = $material[64..79]
  }
}

function Add-Pkcs7Padding([byte[]]$data, [int]$blockSize = 16) {
  $padLen = $blockSize - ($data.Length % $blockSize)
  if ($padLen -eq 0) { $padLen = $blockSize }
  $out = New-Object byte[] ($data.Length + $padLen)
  [Array]::Copy($data, 0, $out, 0, $data.Length)
  for ($i = $data.Length; $i -lt $out.Length; $i++) { $out[$i] = [byte]$padLen }
  return $out
}

function Remove-Pkcs7Padding([byte[]]$data, [int]$blockSize = 16) {
  if ($data.Length -eq 0 -or ($data.Length % $blockSize) -ne 0) { throw 'Invalid padded data length' }
  $padLen = [int]$data[$data.Length - 1]
  if ($padLen -lt 1 -or $padLen -gt $blockSize) { throw 'Invalid padding length' }
  for ($i = $data.Length - $padLen; $i -lt $data.Length; $i++) {
    if ([int]$data[$i] -ne $padLen) { throw 'Invalid padding bytes' }
  }
  $out = New-Object byte[] ($data.Length - $padLen)
  [Array]::Copy($data, 0, $out, 0, $out.Length)
  return $out
}

function Increment-Counter([byte[]]$counter) {
  for ($i = $counter.Length - 1; $i -ge 0; $i--) {
    $v = ($counter[$i] + 1) % 256
    $counter[$i] = [byte]$v
    if ($v -ne 0) { break }
  }
}

function Invoke-AesCtr([byte[]]$key, [byte[]]$iv, [byte[]]$data) {
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.Mode = [System.Security.Cryptography.CipherMode]::ECB
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::None
  $aes.Key = $key

  $encryptor = $aes.CreateEncryptor()
  $counter = New-Object byte[] 16
  [Array]::Copy($iv, 0, $counter, 0, 16)

  $out = New-Object byte[] $data.Length
  $block = New-Object byte[] 16
  $keystream = New-Object byte[] 16

  for ($offset = 0; $offset -lt $data.Length; $offset += 16) {
    [Array]::Clear($block, 0, 16)
    [Array]::Copy($counter, 0, $block, 0, 16)
    $encryptor.TransformBlock($block, 0, 16, $keystream, 0) | Out-Null

    $take = [Math]::Min(16, $data.Length - $offset)
    for ($i = 0; $i -lt $take; $i++) {
      $out[$offset + $i] = $data[$offset + $i] -bxor $keystream[$i]
    }

    Increment-Counter $counter
  }

  $aes.Dispose()
  return $out
}

function Get-PlaintextFromVault([string]$vaultPath, [string]$vaultPassPath) {
  $password = (Get-Content -LiteralPath $vaultPassPath -Raw).Trim()
  $vaultBytes = Read-VaultFile $vaultPath
  $payload = Split-VaultPayload $vaultBytes

  $salt = Convert-HexToBytes $payload.SaltHex
  $hmacExpected = Convert-HexToBytes $payload.HmacHex
  $ciphertext = Convert-HexToBytes $payload.CipherHex

  $keys = Derive-Keys -password $password -salt $salt

  $hmac = [System.Security.Cryptography.HMACSHA256]::new($keys.HmacKey)
  $hmacActual = $hmac.ComputeHash($ciphertext)
  if (-not (Test-BytesEqual $hmacActual $hmacExpected)) {
    throw 'HMAC mismatch (wrong password or corrupted vault file)'
  }

  $paddedPlain = Invoke-AesCtr -key $keys.EncKey -iv $keys.IV -data $ciphertext
  $plainBytes = Remove-Pkcs7Padding -data $paddedPlain
  return [Text.Encoding]::UTF8.GetString($plainBytes)
}

function Write-VaultFile([string]$vaultPath, [string]$vaultPassPath, [string]$plaintext) {
  $password = (Get-Content -LiteralPath $vaultPassPath -Raw).Trim()

  $salt = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($salt)
  $keys = Derive-Keys -password $password -salt $salt

  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plaintext)
  $padded = Add-Pkcs7Padding -data $plainBytes
  $ciphertext = Invoke-AesCtr -key $keys.EncKey -iv $keys.IV -data $padded

  $hmac = [System.Security.Cryptography.HMACSHA256]::new($keys.HmacKey)
  $hmacBytes = $hmac.ComputeHash($ciphertext)

  $payloadText = (Convert-BytesToHex $salt) + "`n" + (Convert-BytesToHex $hmacBytes) + "`n" + (Convert-BytesToHex $ciphertext)
  $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payloadText)
  $vaultHex = Convert-BytesToHex $payloadBytes

  $wrapped = ($vaultHex -split '(.{1,80})' | Where-Object { $_ -ne '' })
  $outLines = @('$ANSIBLE_VAULT;1.1;AES256') + $wrapped

  Set-Content -LiteralPath $vaultPath -Value $outLines
}

function Get-TopLevelKeys([string]$plaintext) {
  $keys = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($plaintext -split "`n")) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#') -or $t -eq '---') { continue }
    if ($t -match '^(?<k>[A-Za-z0-9_]+)\s*:') {
      $keys.Add($Matches.k)
    }
  }
  return $keys
}

function Convert-JsonObjectToHashtable($obj) {
  $ht = @{}
  if ($null -eq $obj) { return $ht }
  foreach ($p in $obj.PSObject.Properties) {
    $ht[$p.Name] = $p.Value
  }
  return $ht
}

function Apply-RenameMap([System.Collections.Generic.List[string]]$lines, [hashtable]$map) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match '^(?<indent>\s*)(?<k>[A-Za-z0-9_]+)(?<rest>\s*:.*)$') {
      $k = $Matches.k
      if ($map.ContainsKey($k)) {
        $mapped = $map[$k]
        if ($mapped -eq '__DELETE__') { continue }
        if ($mapped) {
          $newKey = [string]$mapped
          $out.Add("$($Matches.indent)$newKey$($Matches.rest)")
          continue
        }
      }
    }
    $out.Add($line)
  }
  return $out
}

function Build-ExistingMap([System.Collections.Generic.List[string]]$lines) {
  $existing = @{}
  foreach ($line in $lines) {
    if ($line -match '^(?<k>[A-Za-z0-9_]+)\s*:(?<v>.*)$') {
      $existing[$Matches.k] = $Matches.v
    }
  }
  return $existing
}

function Ensure-Copies([System.Collections.Generic.List[string]]$lines, [hashtable]$ensure, [hashtable]$existing) {
  foreach ($targetKey in $ensure.Keys) {
    if ($existing.ContainsKey($targetKey)) { continue }
    $spec = [string]$ensure[$targetKey]
    if ($spec -match '^copy:(?<src>[A-Za-z0-9_]+)$') {
      $srcKey = $Matches.src
      if (-not $existing.ContainsKey($srcKey)) { throw "Ensure requested $targetKey copy from missing $srcKey" }
      $srcValue = $existing[$srcKey]

      $inserted = $false
      for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^(?<k>$([Regex]::Escape($srcKey)))\\s*:") {
          $lines.Insert($i + 1, "${targetKey}:$srcValue")
          $inserted = $true
          break
        }
      }
      if (-not $inserted) {
        $lines.Add("${targetKey}:$srcValue")
      }
      $existing[$targetKey] = $srcValue
      continue
    }
    throw "Unsupported EnsureJson value for $targetKey. Use copy:<sourceKey>."
  }
  return $lines
}

switch ($Action) {
  'Info' {
    $vaultBytes = Read-VaultFile $VaultPath
    $payload = Split-VaultPayload $vaultBytes
    $salt = Convert-HexToBytes $payload.SaltHex
    $hmacExpected = Convert-HexToBytes $payload.HmacHex
    $cipher = Convert-HexToBytes $payload.CipherHex
    "SaltBytes=$($salt.Length)"
    "HmacBytes=$($hmacExpected.Length)"
    "CipherBytes=$($cipher.Length)"
    "CipherMod16=$($cipher.Length % 16)"
  }
  'ListKeys' {
    $plain = Get-PlaintextFromVault -vaultPath $VaultPath -vaultPassPath $VaultPassPath
    Get-TopLevelKeys $plain | Sort-Object | Get-Unique | ForEach-Object { $_ }
  }
  'ListRedacted' {
    $plain = Get-PlaintextFromVault -vaultPath $VaultPath -vaultPassPath $VaultPassPath
    Get-TopLevelKeys $plain | Sort-Object | Get-Unique | ForEach-Object { "${_}: REDACTED" }
  }
  'RenameKeys' {
    $plain = Get-PlaintextFromVault -vaultPath $VaultPath -vaultPassPath $VaultPassPath
    $map = Convert-JsonObjectToHashtable (ConvertFrom-Json -InputObject $MapJson)
    $ensure = Convert-JsonObjectToHashtable (ConvertFrom-Json -InputObject $EnsureJson)

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($plain -split "`n")) { $lines.Add($l) }

    $out = Apply-RenameMap -lines $lines -map $map
    $existing = Build-ExistingMap -lines $out
    $out = Ensure-Copies -lines $out -ensure $ensure -existing $existing

    Write-VaultFile -vaultPath $VaultPath -vaultPassPath $VaultPassPath -plaintext ($out -join "`n")
    'OK'
  }
  'MigrateTaskyCreds' {
    $plain = Get-PlaintextFromVault -vaultPath $VaultPath -vaultPassPath $VaultPassPath
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($plain -split "`n")) { $lines.Add($l) }

    $map = @{
      postgres_password       = 'tasky_db_super_password'
      taskyhub_db_password    = 'tasky_db_main_password'
      ae_db_password          = 'tasky_db_ae_password'
      grafana_db_password     = 'tasky_db_grafana_password'
      jwt_secret              = 'tasky_app_jwt_secret'
      grafana_admin_user      = 'tasky_grafana_admin_user'
      grafana_admin_password  = 'tasky_grafana_admin_password'
      tasky_admin_email       = 'tasky_app_admin_email'
      tasky_admin_password    = 'tasky_app_admin_password'
      admin_password_hash     = '__DELETE__'
      user_password_hash      = '__DELETE__'
    }
    $ensure = @{
      tasky_app_user_password = 'copy:tasky_app_admin_password'
    }

    $out = Apply-RenameMap -lines $lines -map $map
    $existing = Build-ExistingMap -lines $out
    $out = Ensure-Copies -lines $out -ensure $ensure -existing $existing

    Write-VaultFile -vaultPath $VaultPath -vaultPassPath $VaultPassPath -plaintext ($out -join "`n")
    'OK'
  }
}
