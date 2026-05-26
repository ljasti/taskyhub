# TaskyHub - Infrastructure Architecture
This document covers TaskyHub's infrastructure, both **local (Docker Compose) and cloud (AWS Terraform).

---

## Table of Contents
1. [Local Development Environment (Docker Compose)](#local-development-environment-docker-compose)
2. [AWS Cloud Environment (Terraform)](#aws-cloud-environment-terraform)

---

## Local Development Environment (Docker Compose)

```mermaid
graph TD
    subgraph "Docker Network: taskyhub_network"
        A[TaskyHub API<br/>Port: 4000]
        B[TaskyHub UI<br/>Port: 8080]
        C[n8n<br/>Port: 5678]
        D[(PostgreSQL<br/>Port: 5432)]
        E[Grafana<br/>Port: 3000]
        F[Nginx<br/>Port: 80]
    end

    F -->|/api/*| A
    F -->|/ui/*| B
    F -->|/n8n/*| C
    F -->|/grafana/*| E
    A --> D
    C --> D
    E --> D
```

### Docker Services
All services run in a single Docker network named `taskyhub_network`:
1. **TaskyHub API**: Node.js Express server, exposes port 4000
2. **TaskyHub UI**: Static HTML/JS/CSS, served via Nginx or static server, exposes port 8080
3. **n8n**: Workflow engine, exposes port 5678
4. **PostgreSQL**: Single database instance for n8n, TaskyHub, and Grafana, exposes port 5432
5. **Grafana**: Visualization dashboards, exposes port 3000
6. **Nginx**: Reverse proxy, exposes port 80 and routes traffic to correct services

---

## AWS Cloud Environment (Terraform)

### High-Level Architecture
```mermaid
graph TD
    subgraph "AWS VPC"
        A[Internet Gateway]
        subgraph "Public Subnet"
            B[Security Group<br/>TaskyHub SG<br/>Ports: 22,80,443]
            C[EC2 Instance<br/>TaskyHub Server]
        end
    end

    A <-->|Internet Traffic| B
    B <-->|Allow Ports| C
    
    subgraph "EC2 Instance"
        D[Docker Compose<br/>All Services]
    end
    
    C --> D
```

### Terraform Resources
Defined in `infra/terraform/main.tf`:
1. **aws_security_group.tasky_sg**: Security group allowing:
   - Port 22 (SSH, 0.0.0.0/0 - restrict in production!)
   - Port 80 (HTTP)
   - Port 443 (HTTPS)
   - All outbound traffic
2. **aws_instance.tasky_server**: EC2 instance running Amazon Linux 2, with user_data script that:
   - Installs Docker
   - Installs Docker Compose
   - Copies TaskyHub code
   - Starts all services with docker-compose up -d

### Outputs
Terraform outputs:
1. `instance_public_ip`: Public IP of the EC2 instance
2. `instance_id`: EC2 Instance ID
3. `security_group_id`: Security Group ID
