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
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_security_group" "tasky_sg" {
  name_prefix = "${var.customer_name}-sg"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 5678
    to_port     = 5678
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.customer_name}-sg"
  }
}

resource "aws_instance" "tasky_server" {
  ami           = var.ami_id
  instance_type = var.instance_type
  key_name      = var.key_pair_name

  vpc_security_group_ids = [aws_security_group.tasky_sg.id]

  root_block_device {
    volume_size           = 30   # increase to 40/50 for Docker-heavy workloads
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name     = "tasky-${var.customer_name}"
    Customer = var.customer_name
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    customer_name = var.customer_name
  }))

  # Automatic provisioning after instance creation
  provisioner "local-exec" {
    on_failure = continue
    command = <<-EOT
      # Wait for SSH to be available
      sleep 30

      # Update dynamic inventory and run hardening
      cd ${path.module}/../ansible
      cat > inventory/terraform_inventory.yml <<'INVENTORY'
      all:
        children:
          tasky_servers:
            hosts:
              ${self.tags["Name"]}:
                ansible_host: ${self.public_ip}
                ansible_user: ubuntu
                ansible_ssh_private_key_file: ${var.ssh_private_key_path}
                ansible_become: yes
                ansible_ssh_common_args: '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
                customer_name: ${self.tags["Customer"]}
      INVENTORY
      ANSIBLE_HOST_KEY_CHECKING=False \
      ANSIBLE_ROLES_PATH="${path.module}/../ansible/roles" \
      ansible-playbook -i inventory/terraform_inventory.yml playbooks/01-hardening.yml --limit ${self.tags["Name"]}
    EOT
  }
}

output "instance_public_ip" {
  value       = aws_instance.tasky_server.public_ip
  description = "Public IP of the TaskyHub server"
}

output "instance_id" {
  value       = aws_instance.tasky_server.id
}

output "security_group_id" {
  value       = aws_security_group.tasky_sg.id
}