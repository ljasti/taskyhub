# TaskyHub - Specifications & Architecture Document

## Table of Contents
1. [Introduction](#introduction)
2. [KPIs & Metrics Calculation](#kpis--metrics-calculation)
3. [Workflow Health Scoring Algorithm](#workflow-health-scoring-algorithm)
4. [Application Architecture](#application-architecture)
5. [Infrastructure Architecture](#infrastructure-architecture)
6. [Data Flow Diagrams](#data-flow-diagrams)

---

## Introduction
TaskyHub is a **workflow observability, analytics, and failure intelligence platform** for n8n. It connects to n8n's PostgreSQL database, Grafana, and provides real-time insights into your workflow executions.

---

## KPIs & Metrics Calculation

### Success Rate
```
Success Rate = (Number of Successful Executions / Total Executions) × 100
```
- Successful Executions: Count of executions where `status = 'success'` in `execution_entity`
- Total Executions: Count of all records in `execution_entity`

### Failure Rate
```
Failure Rate = (Number of Failed Executions / Total Executions) × 100
```
- Failed Executions: Count of executions where `status = 'error'` in `execution_entity`

### Average Execution Time
```
Average Execution Time = AVG(EXTRACT(EPOCH FROM ("stoppedAt" - "startedAt")) × 1000)
```
- Calculated in milliseconds
- Only considers executions where `stoppedAt IS NOT NULL` (i.e., completed executions)

### Average Workflow Health Score
```
Average Workflow Health Score = (Sum of all individual workflow health scores) / Total number of workflows
```
- Each workflow's health score is calculated using the health scoring algorithm below
- Rounded to the nearest integer

---

## Workflow Health Scoring Algorithm

Each workflow's health score is calculated out of 100, with four possible health categories:

### Health Categories
| Health Score | Category    | Color  |
|--------------|-------------|--------|
| ≥ 90         | Excellent   | Green  |
| 70 - 89      | Healthy     | Blue   |
| 50 - 69      | Warning     | Yellow |
| < 50         | Critical    | Red    |

### Scoring Formula
The health score is a weighted sum of three factors:

| Factor               | Weight | Calculation                                                                 |
|----------------------|--------|-----------------------------------------------------------------------------|
| Success Rate         | 50%    | Directly uses the success rate percentage                                  |
| Average Runtime      | 20%    | - ≤ 30 seconds: +20 points<br>- ≤ 60 seconds: +10 points<br>- > 60 seconds: 0 points |
| Failure Rate         | 30%    | - < 5%: +30 points<br>- 5% - 14%: +15 points<br>- ≥ 15%: 0 points      |

### Example Calculations
**Example 1: Excellent Health**
- Success Rate: 98% → contributes 49 points (98 × 0.5)
- Avg Runtime: 12 seconds → contributes 20 points
- Failure Rate: 2% → contributes 30 points
- **Total Score: 99/100 → Excellent**

**Example 2: Warning Health**
- Success Rate: 70% → contributes 35 points (70 × 0.5)
- Avg Runtime: 45 seconds → contributes 10 points
- Failure Rate: 12% → contributes 15 points
- **Total Score: 60/100 → Warning**

---

## Application Architecture

```mermaid
graph TD
    subgraph "Frontend (TaskyHub UI)"
        A[Dashboard - Overview]
        B[Dashboard - Workflows]
        C[Dashboard - Failures]
        D[Dashboard - Insights]
        E[Login Page]
    end

    subgraph "Backend API"
        F[Express.js Server]
        G[Auth Middleware<br/>JWT Verification]
        H[Endpoints:<br/>/api/dashboard/*<br/>/api/workflows<br/>/api/executions<br/>/api/users]
    end

    subgraph "n8n & Monitoring"
        I[n8n<br/>Workflow Engine]
        J[(n8n PostgreSQL DB<br/>workflow_entity<br/>execution_entity)]
        K[Grafana<br/>Analytics Dashboards]
    end

    A <-->|API Requests (w/ JWT)| F
    B <-->|API Requests (w/ JWT)| F
    C <-->|API Requests (w/ JWT)| F
    D <-->|API Requests (w/ JWT)| F
    E <-->|Login & Auth| F
    
    F -->|Auth Check| G
    G -->|Validated| H
    H -->|Query Data| J
    K -->|Query Data| J
    I -->|Write Execution Data| J
```

### Key Components
1. **Frontend (Vanilla JS/HTML/CSS):**
   - Dashboard sections: Overview, Workflows, Failures, Insights
   - Charts using Chart.js (line, doughnut, etc.)
   - Enterprise-grade glassmorphism UI
   - Real-time polling every 30 seconds

2. **Backend (Node.js/Express):**
   - JWT-based authentication middleware
   - RESTful API endpoints for all analytics
   - PostgreSQL connection pooling
   - Error handling and logging

3. **n8n Stack:**
   - n8n (workflow execution engine)
   - PostgreSQL (stores workflows, executions)
   - Grafana (visualization dashboards)

---

## Infrastructure Architecture

### Local Development Environment (Docker Compose)
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

### AWS Infrastructure (Terraform)
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

---

## Data Flow Diagrams

### 1. User Login Flow
```mermaid
sequenceDiagram
    participant U as User
    participant UI as Login Page
    participant BE as Backend API
    participant DB as PostgreSQL
    participant JW as JWT

    U->>UI: Enter email/password
    UI->>BE: POST /api/login
    BE->>DB: Verify user credentials
    alt Valid Credentials
        BE->>JW: Generate JWT Token
        JW-->>BE: Token
        BE-->>UI: 200 OK { token, user }
        UI->>UI: Store token in localStorage
        UI-->>U: Redirect to Dashboard
    else Invalid Credentials
        BE-->>UI: 401 Unauthorized
        UI-->>U: Show error
    end
```

### 2. Dashboard Overview Flow
```mermaid
sequenceDiagram
    participant U as User
    participant D as Dashboard Page
    participant BE as Backend API
    participant JW as JWT Auth
    participant DB as n8n PostgreSQL

    D->>D: Get token from localStorage
    alt Token Exists
        D->>BE: GET /api/dashboard/overview<br/>Header: Authorization: Bearer {token}
        BE->>JW: Verify Token
        alt Token Valid
            JW-->>BE: Valid
            BE->>DB: Query KPIs from workflow_entity<br/>and execution_entity
            DB-->>BE: Results
            BE-->>D: 200 OK { success: true, data: ... }
            D->>D: Render KPI cards, charts, tables
            D-->>U: Dashboard visible
        else Token Invalid/Expired
            JW-->>BE: Invalid
            BE-->>D: 401 Unauthorized
            D->>D: Clear localStorage
            D-->>U: Redirect to login
        end
    else No Token
        D-->>U: Redirect to login
    end

    Note over D: Every 30 seconds,<br/>auto-refresh
```

---

## File Structure
```
taskyhub/
├── app/
│   ├── api/
│   │   ├── index.js              # Backend API server
│   │   └── package.json
│   ├── ui/
│   │   ├── dashboard.html        # Main dashboard
│   │   ├── login.html            # Login page
│   │   ├── config.js
│   │   ├── images/
│   │   │   ├── logo.png
│   │   │   ├── favicon.svg
│   │   │   └── favicon.ico
│   ├── grafana/
│   │   ├── dashboards/
│   │   │   └── taskyhub-overview.json
│   │   └── provisioning/
│   │       └── datasources/
│   └── docker-compose.yml
├── infra/
│   └── terraform/
│       ├── main.tf
│       ├── variables.tf
│       ├── terraform.tfvars
│       └── user_data.sh
├── ARCHITECTURE.md
├── SPECIFICATIONS_AND_ARCHITECTURE.md
└── README.md
```

---

## API Endpoints

### Core Endpoints
| Endpoint                          | Method | Description                                  |
|-----------------------------------|--------|----------------------------------------------|
| `/api/login`                      | POST   | Authenticate user and return JWT token      |
| `/api/me`                         | GET    | Get current user profile                     |
| `/api/config`                     | GET    | Get configuration (Grafana/n8n URLs)        |
| `/api/users`                      | GET    | List all users (admin only)                  |
| `/api/workflows`                  | GET    | List all workflows                           |
| `/api/executions`                 | GET    | List executions                              |

### Dashboard Endpoints
| Endpoint                          | Method | Description                                  |
|-----------------------------------|--------|----------------------------------------------|
| `/api/dashboard/overview`         | GET    | Get KPI overview (all main metrics)          |
| `/api/dashboard/trends`           | GET    | Get hourly execution trend data              |
| `/api/dashboard/performance`      | GET    | Get all workflows with performance & health  |
| `/api/dashboard/failures/detailed`| GET    | Get detailed failure information             |
| `/api/dashboard/insights`         | GET    | Get AI-style insights & alerts               |
| `/api/grafana/dashboard`          | GET    | Get Grafana dashboard URL                    |
