# Generate Ansible inventory automatically
output "ansible_inventory" {
  value = templatefile("${path.module}/templates/inventory.tpl", {
    hosts = [
      {
        name                         = module.taskyhub_stack.instance_name
        ansible_host                 = module.taskyhub_stack.instance_public_ip
        customer_name                = var.customer_name
        ansible_user                 = "ubuntu"
        ansible_ssh_private_key_file = var.ssh_private_key_path
        ansible_become               = true
        ansible_ssh_common_args      = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
        ui_domain                    = var.ui_domain
        ui_port                      = var.ui_port
        api_domain                   = var.api_domain
        api_port                     = var.api_port
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
        name                         = module.taskyhub_stack.instance_name
        ansible_host                 = module.taskyhub_stack.instance_public_ip
        customer_name                = var.customer_name
        ansible_user                 = "ubuntu"
        ansible_ssh_private_key_file = var.ssh_private_key_path
        ansible_become               = true
        ansible_ssh_common_args      = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
        ui_domain                    = var.ui_domain
        ui_port                      = var.ui_port
        api_domain                   = var.api_domain
        api_port                     = var.api_port
      }
    ]
  })
  filename = "${path.module}/../ansible/inventory/terraform_inventory.yml"
}

output "instance_public_ip" {
  value       = module.taskyhub_stack.instance_public_ip
  description = "Public IP of the TaskyHub server"
}

output "instance_id" {
  value = module.taskyhub_stack.instance_id
}

output "security_group_id" {
  value = module.taskyhub_stack.security_group_id
}
