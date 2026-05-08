# Generate Ansible inventory automatically
output "ansible_inventory" {
  value = templatefile("${path.module}/templates/inventory.tpl", {
    hosts = [
      {
        name         = aws_instance.tasky_server.tags["Name"]
        ansible_host = aws_instance.tasky_server.public_ip
        customer     = aws_instance.tasky_server.tags["Customer"]
      }
    ]
  })
  description = "Dynamic Ansible inventory"
}

# Write inventory to file
resource "local_file" "ansible_inventory" {
  content = templatefile("${path.module}/templates/inventory.tpl", {
    hosts = [
      {
        name         = aws_instance.tasky_server.tags["Name"]
        ansible_host = aws_instance.tasky_server.public_ip
        customer     = aws_instance.tasky_server.tags["Customer"]
      }
    ]
  })
  filename = "${path.module}/../ansible/inventory/terraform_inventory.yml"
}
