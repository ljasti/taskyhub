variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
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

variable "customer_name" {
  description = "Customer name (e.g., tasky, acme, customer)"
  type        = string
}

variable "domain_name" {
  description = "Full domain name (e.g., tasky.amroth.life)"
  type        = string
}

variable "n8n_admin_user" {
  description = "n8n admin username"
  type        = string
  default     = "admin"
}

variable "n8n_admin_password" {
  description = "n8n admin password"
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