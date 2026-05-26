# TaskyHub - Complete Architecture & Data Flow Diagrams
All diagrams are created using **Mermaid.js**, which supports:
- GitHub/GitLab rendering
- VS Code preview
- Export to PNG/SVG (via [Mermaid Live Editor](https://mermaid.live/))
- Draw.io compatible structure

---

## Table of Contents
1. [High-Level System Architecture](#1-high-level-system-architecture)
2. [End-to-End User Flow](#2-end-to-end-user-flow)
3. [Authentication Flow](#3-authentication-flow)
4. [Dashboard Analytics Flow](#4-dashboard-analytics-flow)
5. [Grafana Integration Flow](#5-grafana-integration-flow)
6. [n8n Workflow Execution Flow](#6-n8n-workflow-execution-flow)
7. [Real-Time Update Flow](#7-real-time-update-flow)
8. [Error Handling Flow](#8-error-handling-flow)
9. [Admin Access Flow](#9-admin-access-flow)
10. [Database ER Diagram](#10-database-er-diagram)

---

## Color Legend
| Section       | Color       |
|---------------|-------------|
| Frontend      | Blue        |
| Backend       | Green       |
| Database      | Orange      |
| Monitoring    | Purple      |
| Errors        | Red         |
| Admin         | Dark Gray   |

---

## 1. High-Level System Architecture
```mermaid
graph TD
    subgraph USER["👤 User Layer"]
        U((User))
    end

    subgraph FRONTEND["🖥️ Frontend (TaskyHub UI) - Blue"]
        Login[Login Page]
        Dash[Dashboard<br/>Overview / Workflows / Failures / Insights]
        LS[(localStorage<br/>token, user)]
    end

    subgraph BACKEND["⚙️ Backend API - Green"]
        API[Express.js Server]
        Auth[JWT Auth Middleware]
        Endpoints[REST Endpoints<br/>/api/dashboard/*]
    end

    subgraph DATABASES["🗄️ Databases - Orange"]
        TaskyDB[(TaskyHub DB<br/>users, subscriptions)]
        N8nDB[(n8n DB<br/>workflow_entity<br/>execution_entity)]
    end

    subgraph MONITORING["📊 Monitoring & Integrations - Purple"]
        N8n[n8n Workflow Engine]
        Grafana[Grafana Analytics]
    end

    U -->|1. Open TaskyHub| Login
    Login -->|2. Enter credentials| API
    API -->|3. Validate user| TaskyDB
    TaskyDB -->|4. User found| API
    API -->|5. Generate JWT| Login
    Login -->|6. Store token| LS
    Login -->|7. Redirect| Dash
    Dash -->|8. Get token| LS
    Dash -->|9. API Request + Bearer token| API
    API -->|10. Verify JWT| Auth
    Auth -->|11. Token valid| Endpoints
    Endpoints -->|12. Query data| N8nDB
    N8nDB -->|13. Return results| Endpoints
    Endpoints -->|14. JSON Response| Dash
    Dash -->|15. Render KPI cards, charts| U
    Grafana -->|16. Query data| N8nDB
    N8n -->|17. Write executions| N8nDB
    Dash -->|18. Open in new tab| N8n
    Dash -->|19. Open in new tab| Grafana
```

---

## 2. End-to-End User Flow
```mermaid
sequenceDiagram
    participant U as User
    participant L as Login Page
    participant D as Dashboard
    participant LS as localStorage
    participant BE as Backend API
    participant JW as JWT Auth
    participant PG as n8n PostgreSQL
    participant N as n8n
    participant G as Grafana

    Note over U,G: 1. Initial Visit
    U->>L: Open TaskyHub
    L->>LS: Check for token
    alt Token exists
        LS-->>L: Token found
        L->>D: Redirect to dashboard
    else No token
        LS-->>L: No token
        L-->>U: Show login form
    end

    Note over U,G: 2. Login
    U->>L: Enter email/password
    L->>BE: POST /api/login
    BE->>PG: Verify credentials (TaskyHub DB)
    PG-->>BE: User valid
    BE->>BE: Generate JWT Token
    BE-->>L: 200 OK { token, user }
    L->>LS: Store tasky_token & tasky_user
    L->>D: Redirect to dashboard

    Note over U,G: 3. Dashboard Load
    D->>LS: Get JWT token
    D->>BE: GET /api/dashboard/overview<br/>Authorization: Bearer {token}
    BE->>JW: Verify token
    alt Token valid
        JW-->>BE: Valid
        BE->>PG: Query workflow_entity & execution_entity
        PG-->>BE: Return KPIs, executions, etc.
        BE-->>D: 200 OK { success: true, data: ... }
        D->>D: Render KPI cards, charts, tables
        D-->>U: Dashboard visible
    else Token invalid/expired
        JW-->>BE: Invalid
        BE-->>D: 401 Unauthorized
        D->>LS: Clear localStorage
        D->>L: Redirect to login
    end

    Note over U,G: 4. Real-Time Updates
    loop Every 30 seconds
        D->>LS: Check token
        alt Token exists
            D->>BE: Refresh dashboard data
            BE->>PG: Query updated data
            PG-->>BE: Results
            BE-->>D: Updated JSON
            D->>D: Refresh charts & tables
        else Token missing
            break Stop polling
        end
    end

    Note over U,G: 5. Admin Actions
    alt User is admin
        D->>D: Show admin buttons (Open Grafana/n8n)
        U->>D: Click "Open Grafana"
        D->>G: Open in new tab
        U->>D: Click "Open n8n"
        D->>N: Open in new tab
    end
```

---

## 3. Authentication Flow
```mermaid
graph TD
    subgraph FRONTEND["Frontend - Blue"]
        LF[Login Form<br/>email + password]
        LS[(localStorage<br/>tasky_token)]
        DH[Dashboard<br/>Check token]
    end

    subgraph BACKEND["Backend - Green"]
        API[Express Server]
        JWTV[JWT Verification<br/>Middleware]
        LOG[POST /api/login]
        PROT[Protected Endpoints<br/>/api/dashboard/*]
    end

    subgraph DATABASE["Database - Orange"]
        TDB[(TaskyHub DB<br/>users table)]
    end

    LF -->|1. POST /api/login| LOG
    LOG -->|2. Query user| TDB
    TDB -->|3. User exists?| LOG
    alt User exists
        LOG -->|4. Verify password| LOG
        alt Password valid
            LOG -->|5. Generate JWT<br/>expiresIn: 8h| LOG
            LOG -->|6. Return token + user| LF
            LF -->|7. Store token| LS
            LF -->|8. Redirect| DH
            DH -->|9. Get token from LS| LS
            DH -->|10. API Request + Bearer token| API
            API -->|11. Pass to middleware| JWTV
            JWTV -->|12. Token valid?| JWTV
            alt Token valid
                JWTV -->|13. Proceed| PROT
                PROT -->|14. Return data| DH
            else Token invalid/expired
                JWTV -->|15. Return 401| API
                API -->|16. 401 Unauthorized| DH
                DH -->|17. Clear LS| LS
                DH -->|18. Redirect to login| LF
            end
        else Password invalid
            LOG -->|19. 401 Unauthorized| LF
            LF -->|20. Show error| LF
        end
    else User not found
        LOG -->|21. 401 Unauthorized| LF
        LF -->|22. Show error| LF
    end
```

---

## 4. Dashboard Analytics Flow
```mermaid
graph TD
    subgraph N8N["n8n Engine - Purple"]
        TRIG[Trigger/Webhook<br/>starts workflow]
        WF[Workflow Execution<br/>node processing]
        RES{Success or Failure?}
    end

    subgraph DB["PostgreSQL - Orange"]
        WE[(workflow_entity)]
        EE[(execution_entity<br/>status, startedAt, stoppedAt, data)]
    end

    subgraph BACKEND["Backend - Green"]
        AGG[API Endpoints<br/>/api/dashboard/*]
        QRY[PostgreSQL Queries<br/>COUNT, AVG, etc.]
        JSON[JSON Response<br/>success: true, data: ...]
    end

    subgraph FRONTEND["Frontend - Blue"]
        KPIs[KPI Cards<br/>Total, Active, Failed, etc.]
        CHARTS[Charts & Graphs<br/>Chart.js]
        TABLES[Tables<br/>Workflows, Executions, Failures]
        DASH[Dashboard UI<br/>Rendered]
    end

    TRIG -->|1. Start| WF
    WF -->|2. Process nodes| WF
    WF -->|3. Complete| RES
    RES -->|Success| EE
    RES -->|Failure| EE
    EE -->|4. Insert execution record| EE
    EE -->|5. Query data| QRY
    QRY -->|6. Calculate KPIs<br/>success rate, avg duration| AGG
    AGG -->|7. Format data| JSON
    JSON -->|8. Send to frontend| KPIs
    JSON -->|8. Send to frontend| CHARTS
    JSON -->|8. Send to frontend| TABLES
    KPIs -->|9. Render| DASH
    CHARTS -->|9. Render| DASH
    TABLES -->|9. Render| DASH
```

---

## 5. Grafana Integration Flow
```mermaid
graph TD
    subgraph DB["n8n PostgreSQL - Orange"]
        EE[(execution_entity)]
        WE[(workflow_entity)]
    end

    subgraph GRAFANA["Grafana - Purple"]
        DS[(PostgreSQL Datasource)]
        DASH[Grafana Dashboard<br/>taskyhub-overview]
        PANELS[Panels & Charts<br/>Stat, Line, Pie, Table]
    end

    subgraph FRONTEND["Frontend - Blue"]
        ADMIN{Is Admin?}
        G_BTN[Open Grafana Button]
        NEW_TAB[Open in New Tab]
    end

    DS -->|1. Query data| EE
    DS -->|1. Query data| WE
    EE -->|2. Return data| DS
    WE -->|2. Return data| DS
    DS -->|3. Pass to panels| PANELS
    PANELS -->|4. Render dashboard| DASH
    FRONTEND -->|5. Check user role| ADMIN
    alt User is admin
        ADMIN -->|6. Show button| G_BTN
        G_BTN -->|7. User clicks| NEW_TAB
        NEW_TAB -->|8. Navigate| DASH
    else User not admin
        ADMIN -->|9. Hide button| FRONTEND
    end
```

---

## 6. n8n Workflow Execution Flow
```mermaid
graph TD
    subgraph TRIGGER["Trigger Layer"]
        W[Webhook<br/>HTTP Request]
        CRON[Cron/Schedule]
        MAN[Manual Trigger]
    end

    subgraph N8N["n8n Engine - Purple"]
        WF[Workflow Instance]
        NODES[Node Execution<br/>Process each node]
        RES{Execution<br/>Result?}
    end

    subgraph DB["PostgreSQL - Orange"]
        EE[(execution_entity<br/>status, startedAt, stoppedAt, data)]
    end

    subgraph TASKYHUB["TaskyHub Analytics"]
        API[Backend API]
        DASH[Dashboard<br/>Failures Section]
        INS[AI Insights]
    end

    W -->|1. Trigger| WF
    CRON -->|1. Trigger| WF
    MAN -->|1. Trigger| WF
    WF -->|2. Start timer| EE
    EE -->|3. Insert status: running| EE
    WF -->|4. Execute| NODES
    NODES -->|5. Node completes| NODES
    NODES -->|6. All nodes done?| RES
    RES -->|Success| EE
    RES -->|Failure| EE
    EE -->|7. Update status<br/>success/error<br/>stoppedAt| EE
    EE -->|8. Notify| API
    API -->|9. Update dashboard| DASH
    API -->|10. Generate insights| INS
```

---

## 7. Real-Time Update Flow
```mermaid
graph TD
    subgraph FRONTEND["Frontend - Blue"]
        POLL[setInterval<br/>30000ms]
        TOKEN{Valid Token?}
        REQ[API Request<br/>/api/dashboard/overview]
        RENDER[Update UI<br/>KPIs, Charts, Tables]
    end

    subgraph BACKEND["Backend - Green"]
        AUTH[JWT Auth]
        QRY[Query PostgreSQL]
        RESP[JSON Response]
    end

    subgraph DB["n8n PostgreSQL - Orange"]
        EE[(execution_entity)]
        WE[(workflow_entity)]
    end

    POLL -->|1. Every 30s| TOKEN
    TOKEN -->|Token exists| REQ
    TOKEN -->|Token missing| POLL
    REQ -->|2. Send request| AUTH
    AUTH -->|3. Token valid| QRY
    QRY -->|4. Get fresh data| EE
    QRY -->|4. Get fresh data| WE
    EE -->|5. Return| QRY
    WE -->|5. Return| QRY
    QRY -->|6. Format data| RESP
    RESP -->|7. Send to frontend| RENDER
    RENDER -->|8. Update UI| POLL
```

---

## 8. Error Handling Flow
```mermaid
graph TD
    subgraph ERRORS["Error - Red"]
        API_ERR[API Failure<br/>500 Internal Server Error]
        AUTH_ERR[Auth Error<br/>Missing/Invalid JWT]
        DB_ERR[Database Error<br/>Connection/Query Failed]
        GRAF_ERR[Grafana Embedding Error<br/>X-Frame-Options]
    end

    subgraph BACKEND["Backend - Green"]
        TC[Try/Catch Blocks]
        LOG[Error Logging<br/>console.error]
        JSON_ERR[JSON Error Response<br/>success: false, error: ...]
    end

    subgraph FRONTEND["Frontend - Blue"]
        ERR_STATE[Error State UI<br/>Show message]
        WARN[User Warning]
        RETRY[Retry Mechanism<br/>Next poll cycle]
    end

    API_ERR -->|1. Throw error| TC
    AUTH_ERR -->|1. Throw error| TC
    DB_ERR -->|1. Throw error| TC
    GRAF_ERR -->|1. Handle in frontend| FRONTEND
    TC -->|2. Catch error| LOG
    LOG -->|3. Log to console| JSON_ERR
    JSON_ERR -->|4. Send to frontend| ERR_STATE
    ERR_STATE -->|5. Show warning| WARN
    WARN -->|6. Wait for poll| RETRY
    RETRY -->|7. Try again| FRONTEND
```

---

## 9. Admin Access Flow
```mermaid
graph TD
    subgraph USER["User"]
        ADMIN{Admin User?}
    end

    subgraph AUTH["Auth - Green"]
        LOGIN[Login]
        TOKEN[JWT Token<br/>contains role: admin]
        VALIDATE[Validate Role]
    end

    subgraph FRONTEND["Frontend - Blue"]
        DASH[Dashboard]
        ADMIN_NAV[Admin Navigation<br/>Show Buttons]
        G_BTN[Open Grafana]
        N_BTN[Open n8n]
    end

    subgraph MONITORING["Monitoring - Purple"]
        GRAFANA[Grafana UI]
        N8N[n8n Editor]
    end

    USER -->|1. Login| LOGIN
    LOGIN -->|2. Generate token| TOKEN
    TOKEN -->|3. Redirect to| DASH
    DASH -->|4. Check role| VALIDATE
    VALIDATE -->|role === admin| ADMIN_NAV
    VALIDATE -->|role !== admin| DASH
    ADMIN_NAV -->|5. Show buttons| G_BTN
    ADMIN_NAV -->|5. Show buttons| N_BTN
    G_BTN -->|6. User clicks| GRAFANA
    N_BTN -->|6. User clicks| N8N
    GRAFANA -->|7. Open in new tab| GRAFANA
    N8N -->|7. Open in new tab| N8N
```

---

## 10. Database ER Diagram
```mermaid
erDiagram
    users ||--o{ subscriptions : "belongs to"
    users ||--o{ audit_logs : "generates"
    workflows ||--o{ executions : "has"
    users {
        string id PK "User ID"
        string subscription_id FK "Subscription ID"
        string email UK "Email"
        string password "Hashed Password"
        string name "Full Name"
        string role "Role: admin/user"
        datetime created_at "Created At"
    }
    subscriptions {
        string id PK "Subscription ID"
        string name "Subscription Name"
        int seat_limit "Seat Limit"
        datetime created_at "Created At"
    }
    workflow_entity {
        string id PK "Workflow ID"
        string name "Workflow Name"
        boolean active "Active Status"
        json data "Workflow Definition"
        datetime createdAt "Created At"
        datetime updatedAt "Updated At"
    }
    execution_entity {
        string id PK "Execution ID"
        string workflowId FK "Workflow ID"
        string mode "Execution Mode"
        string status "Status: success/error/running"
        json data "Execution Data (nodes, errors)"
        datetime startedAt "Started At"
        datetime stoppedAt "Stopped At"
    }
    audit_logs {
        string id PK "Audit Log ID"
        string userId FK "User ID"
        string action "Action Performed"
        json details "Action Details"
        datetime created_at "Created At"
    }
```

---

## Export Instructions
To export these diagrams:
1. Open [Mermaid Live Editor](https://mermaid.live/)
2. Paste the diagram code
3. Click "Actions" → "Export PNG" or "Export SVG"
4. For Draw.io compatibility, export as SVG and import into Draw.io

## File Organization
All architecture/infra/docs files are now:
- `docs/APPLICATION_ARCHITECTURE.md`: App-level details, KPIs, health scoring
- `docs/INFRASTRUCTURE_ARCHITECTURE.md`: Docker Compose & AWS Terraform infra
- `docs/ARCHITECTURE_DIAGRAMS.md`: This file - all diagrams!
- `SPECIFICATIONS_AND_ARCHITECTURE.md`: Original comprehensive specs (kept as reference)
