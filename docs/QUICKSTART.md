# TaskyHub Quickstart

## ⚡ Quick Start (3 Steps)

### Step 1: Prepare Configuration
```bash
cp config/config.env.example .env
# Edit .env with your AWS credentials and domain
```

### Step 2: Configure AWS
```bash
aws configure
# Enter your AWS credentials
```

### Step 3: Provision + Hardening (recommended)
```bash
chmod +x scripts/spinup.sh
./scripts/spinup.sh
```

**PowerShell Alternative (Windows):**
```powershell
.\scripts\spinup.ps1
```

## What this does now
- Runs **Terraform** to provision the EC2 instance.
- Runs **Ansible hardening + user management** to create `supertasky` / `tasky` and disable `ubuntu`.
- Does **not** auto-deploy the application (run that manually after hardening).

## Next step (manual app deployment)
See `docs/RUNBOOK.md` for the canonical procedure.

---

## 🔑 config.env Template

Create `.env` with these values:

```env
# AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=us-east-1

# EC2 Configuration
KEY_PAIR_NAME=your-key-pair-name
INSTANCE_TYPE=t2.micro

# Customer & Domain
CUSTOMER_NAME=tasky
DOMAIN_NAME=tasky.amroth.life

# SSH Key Path (Linux/Mac: /home/user/.ssh/key.pem)
SSH_KEY_PATH=/home/username/.ssh/your-key-pair.pem

# Automation Engine password (AE)
N8N_PASSWORD=StrongPassword123!
ADMIN_PASSWORD=AdminPass123!
USER_PASSWORD=UserPass123!
```

---

## 📊 Deployment Output

After `.\spinup.ps1` completes, you'll see:

```
========================================
Deployment Complete!
========================================

Instance IP: 54.123.456.789
Access Application: https://tasky.amroth.life

Credentials:
  Admin: admin / AdminPass123!
  User: user / UserPass123!

n8n Access:
  URL: https://tasky.amroth.life/n8n
  User: admin / StrongN8nPassword123!

IMPORTANT: Update your Namecheap DNS to point to 54.123.456.789
```

---

## 🔗 Next Steps After Deployment

### 1. Update Namecheap DNS (Within 30 minutes)

1. Go to Namecheap Dashboard
2. Select your domain (amroth.life)
3. Go to Advanced DNS
4. Add A Record:
   - Host: `@` (or subdomain name)
   - Type: `A`
   - Value: `54.123.456.789` (your instance IP)
5. Save and wait 5-10 minutes

### 2. Access Your Application

Once DNS propagates:
- Visit `https://tasky.amroth.life`
- Login with credentials from deployment output

### 3. Create n8n Workflows

- Access `https://tasky.amroth.life/n8n`
- Login with admin credentials
- Build your automation workflows

---

## 🔄 Adding a New Customer

To add customer "acme" with domain "acme.amroth.life":

```bash
# Copy existing config as template
cp .env .env-acme

# Edit the new config
# Change:
# CUSTOMER_NAME=acme
# DOMAIN_NAME=acme.amroth.life
# [other credentials]

# Deploy
./spinup.sh .env-acme
```

**PowerShell Alternative:**
```powershell
Copy-Item .env .env-acme
# Edit .env-acme

.\spinup.ps1 -ConfigFile .env-acme
```

Each customer gets their own infrastructure automatically!

---

## Canonical docs
- `docs/RUNBOOK.md` is the single source of truth for operations.

---

## 📱 Environment Variables Explained

```env
# AWS Account credentials (get from IAM console)
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY

# AWS Region for EC2 (us-east-1 is default and cheap)
AWS_REGION

# EC2 Key Pair (must exist in your AWS account)
KEY_PAIR_NAME

# Instance size (t2.micro/t3.micro are common free-tier options)
INSTANCE_TYPE

# Customer identifier (becomes part of domain and service names)
CUSTOMER_NAME

# Full domain name (where users access your app)
DOMAIN_NAME

# Local path to SSH private key (.pem file)
# Linux/Mac: /home/username/.ssh/key.pem
# Windows: C:\Users\Username\.ssh\key.pem
SSH_KEY_PATH

# Passwords for services (change these!)
N8N_PASSWORD      # n8n automation engine
ADMIN_PASSWORD    # Dashboard admin user
USER_PASSWORD     # Dashboard regular user
```

---

## ✅ Verification Checklist

- [ ] AWS account with credentials
- [ ] EC2 key pair created and .pem file downloaded
- [ ] Terraform installed
- [ ] Ansible installed
- [ ] AWS CLI configured (`aws configure`)
- [ ] config.env created and filled with your values
- [ ] Namecheap domain purchased
- [ ] Ready to run `.\spinup.ps1`

---

## 🎯 Time Estimates

| Step | Duration |
|------|----------|
| Config setup | 5 minutes |
| AWS initialization | 2 minutes |
| Terraform provisioning | 5-7 minutes |
| Instance boot wait | 1 minute |
| Ansible configuration | 8-10 minutes |
| **Total** | **20-25 minutes** |
| DNS propagation | 5-10 minutes |
| **Time to access app** | **30-35 minutes** |

---

## 💾 Files Generated During Deployment

After running `spinup.ps1`:

```
infra/
├── terraform/
│   ├── terraform.auto.tfvars    # ← Generated from config.env
│   ├── .terraform/              # ← Generated
│   └── tfplan                   # ← Generated (binary)
├── ansible/
│   ├── inventory.ini            # ← Updated with instance IP
│   └── vars.yml                 # ← Generated from config.env
├── INSTANCE_IP.txt              # ← Contains instance IP for reference
└── config.env                   # ← Your configuration
```

Save `INSTANCE_IP.txt` for future reference - it contains your instance's public IP.

---

## 🔐 Post-Deployment Security

1. **Change all passwords** to strong values
2. **Restrict SSH access** in AWS Security Group (add only your IP)
3. **Enable 2FA** on AWS and Namecheap accounts
4. **Backup n8n data** regularly
5. **Monitor instance** for unauthorized access
6. **Update Docker images** regularly

---

## 📚 Additional Resources

- Full setup guide: [SETUP.md](SETUP.md)
- Terraform documentation: https://developer.hashicorp.com/terraform
- Ansible documentation: https://docs.ansible.com/ansible/
- n8n documentation: https://docs.n8n.io/
- Namecheap DNS help: https://www.namecheap.com/support/