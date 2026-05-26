#!/bin/bash
sudo apt update -y
sudo apt upgrade -y
sudo apt install -y curl git nginx certbot python3-certbot-nginx

curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ubuntu
newgrp docker
sudo apt install -y docker-compose-plugin

sudo mkdir -p /opt/${customer_name}/{ae,ui,data}
sudo chown -R ubuntu:ubuntu /opt/${customer_name}
chmod -R 755 /opt/${customer_name}