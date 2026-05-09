variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t2.micro"
}

variable "ami_id" {
  description = "Ubuntu 22.04 LTS AMI ID"
  type        = string
  default     = "ami-0c7217cdde317cfec"
}

variable "key_pair_name" {
  description = "AWS EC2 Key Pair name"
  type        = string
}

variable "ssh_private_key_path" {
  description = "Path to SSH private key file used by Ansible"
  type        = string
}

variable "customer_name" {
  description = "Customer name (e.g., tasky, acme, customer)"
  type        = string
}

variable "ui_domain" {
  description = "UI domain name (e.g., taskyhub.xyz)"
  type        = string
}

variable "ui_port" {
  description = "UI host port"
  type        = number
  default     = 8080
}

variable "api_domain" {
  description = "API domain name (e.g., taskyhub.xyz)"
  type        = string
}

variable "api_port" {
  description = "API host port"
  type        = number
  default     = 4000
}

variable "ae_admin_user" {
  description = "automation engine admin username"
  type        = string
  default     = "admin"
}

variable "ae_admin_password" {
  description = "automation engine admin password"
  type        = string
  sensitive   = true
}

variable "admin_username" {
  description = "Dashboard admin username"
  type        = string
  default     = "admin"
}

variable "admin_password" {
  description = "Dashboard admin password"
  type        = string
  sensitive   = true
}

variable "user_username" {
  description = "Dashboard user username"
  type        = string
  default     = "user"
}

variable "user_password" {
  description = "Dashboard user password"
  type        = string
  sensitive   = true
}