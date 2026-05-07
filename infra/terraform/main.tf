terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
    cidr_blocks = ["0.0.0.0/0"]  # Restrict to your IP in production
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

  security_groups = [aws_security_group.tasky_sg.name]

  tags = {
    Name = "${var.customer_name}-server"
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    customer_name = var.customer_name
  }))
}

output "instance_public_ip" {
  value       = aws_instance.tasky_server.public_ip
  description = "Public IP of the TaskyHub server"
}

output "instance_id" {
  value       = aws_instance.tasky_server.id
  description = "EC2 Instance ID"
}

output "security_group_id" {
  value       = aws_security_group.tasky_sg.id
  description = "Security Group ID"
}