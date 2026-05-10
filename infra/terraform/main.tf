terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "taskyhub_stack" {
  source = "./modules/taskyhub_stack"

  aws_region           = var.aws_region
  customer_name        = var.customer_name
  ami_id               = var.ami_id
  instance_type        = var.instance_type
  key_pair_name        = var.key_pair_name
  ssh_private_key_path = var.ssh_private_key_path
  ui_domain            = var.ui_domain
  ui_port              = var.ui_port
  api_domain           = var.api_domain
  api_port             = var.api_port
}

resource "null_resource" "ansible_hardening" {
  triggers = {
    instance_id = module.taskyhub_stack.instance_id
  }

  provisioner "local-exec" {
    on_failure = continue
    command    = <<-EOT
      sleep 30
      cd ${path.module}/../ansible
      ANSIBLE_HOST_KEY_CHECKING=False \
      ANSIBLE_ROLES_PATH="${path.module}/../ansible/roles" \
      ansible-playbook -i inventory/terraform_inventory.yml playbooks/01-hardening.yml --limit ${module.taskyhub_stack.instance_name}
    EOT
  }

  depends_on = [local_file.ansible_inventory]
}
