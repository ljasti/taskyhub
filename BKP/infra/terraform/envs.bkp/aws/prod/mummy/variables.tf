variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t2.micro"
}

variable "ami_id" {
  type = string
}

variable "key_pair_name" {
  type = string
}

variable "ssh_private_key_path" {
  type = string
}

variable "customer_name" {
  type = string
}

variable "ui_domain" {
  type = string
}

variable "ui_port" {
  type    = number
  default = 8080
}

variable "api_domain" {
  type = string
}

variable "api_port" {
  type    = number
  default = 4000
}

