# TaskyHub Local Testing Guide

This guide explains how to run TaskyHub locally for development and testing purposes.

## Prerequisites

- Docker and Docker Compose installed
- Web browser

## Running the Application

### 1. Start the Services (and Remove Old Volumes if Needed)

Navigate to the application directory and start all services:

```bash
cd app
# ⚠️ Important: If you have old data, remove volumes first!
docker compose down -v

# Start fresh
docker compose up -d --build
```

This will start:
- **TaskyHub UI** (frontend) on http://localhost:8080
- **TaskyHub API** on http://localhost:4000
- **n8n** (workflow automation) on http://localhost:5678
- **PostgreSQL** (database for all services)
- **TaskyHub Analytics** (monitoring, rebranded Grafana) on http://localhost:3000

The UI API host is configurable through the UI container environment variable `API_URL`. By default it is set to `http://api:4000/api`.

### 2. Access the Services

- **TaskyHub UI**: http://localhost:8080
  - **DevOps Login**: Email: `devops@taskyhub.local`, Password: `admin123`
  - **Developer Login**: Email: `developer@taskyhub.local`, Password: `test123`
- **TaskyHub API**: http://localhost:4000
  - Health Check: http://localhost:4000/api/health
- **n8n Web UI**: http://localhost:5678
- **TaskyHub Analytics (Grafana)**: http://localhost:3000
  - Username: `taskyhub_admin`
  - Password: `T4skyhub@dm1n!`

### 3. Testing Features

1. **Login/Dashboard**: Test authentication with the above credentials
2. **n8n Integration**: Click "Open n8n" from the dashboard to access the workflow editor
3. **Workflows**: Create and test automation workflows in n8n
4. **Analytics**: Access TaskyHub Analytics (Grafana) at http://localhost:3000 to view monitoring dashboards

## Stopping the Services

```bash
cd app
# Stop but keep volumes
docker compose down

# OR stop and REMOVE ALL volumes (resets everything)
docker compose down -v
```

## Notes

- The docker-compose.yml is configured for POC/development with exposed ports
- All services (UI, API, n8n, Grafana) are containerized for easy local development
- In production, services would be behind a reverse proxy (nginx) as configured in `app/tasky.conf`
- Database data persists in Docker volumes
- Default passwords should be changed for production use