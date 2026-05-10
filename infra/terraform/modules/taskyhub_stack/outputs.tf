output "instance_public_ip" {
  value = aws_instance.tasky_server.public_ip
}

output "instance_id" {
  value = aws_instance.tasky_server.id
}

output "security_group_id" {
  value = aws_security_group.tasky_sg.id
}

output "instance_name" {
  value = aws_instance.tasky_server.tags["Name"]
}

