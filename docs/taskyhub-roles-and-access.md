# TaskyHub Roles and Access (RBAC)

This document explains what different types of TaskyHub users can see and do in the dashboard and APIs. It is written for business stakeholders, Customer Success, and technical operators.

## Roles (simple definitions)

TaskyHub supports these roles at the application level:

- **CS (Customer Success)** (`cs`)
  - Non-technical support users.
  - Focus: customer/account status, subscription information, and user lists.
  - Cannot access the Automation Engine (n8n) UI or low-level monitoring/logs.
- **Technical (Engineering/Ops)** (`technical`)
  - Technical users who operate workflows, automations, and integrations.
  - Focus: workflows, integrations, monitoring, and troubleshooting.
  - Cannot change subscription plans or manage users unless they also have tenant admin privileges.
- **Super Admin** (`super_admin` or `is_super_admin=true`)
  - Internal platform administrators.
  - Full access to all tenants, global admin pages, deeper monitoring, and user management.
  - This role should be restricted to internal staff only.

TaskyHub also keeps tenant-level roles for normal customer workspaces:

- **Owner** (`owner`) – the main workspace administrator.
- **Admin** (`admin`) – workspace admin.
- **Member** (`member`) – normal user.
- **Viewer** (`viewer`) – read-only user.

Notes:
- `is_owner` is used for tenant ownership and is separate from platform-wide `super_admin`.
- No role can ever view raw integration secrets in the UI or API responses. Only metadata and status are returned.

## What each role can do (high level)

### CS
- Can view subscription status and plan details (read-only).
- Can view users inside a subscription (name/email/role/status).
- Cannot manage workflows or integrations.
- Cannot access monitoring pages or Automation Engine internals.

### Technical
- Can view and manage workflows (within plan limits).
- Can view integrations status and test integrations (without seeing secrets).
- Can view monitoring pages and troubleshooting views.
- Cannot change plans or manage users.

### Super Admin
- Can do everything CS and Technical can do.
- Can see global admin pages (all tenants/subscriptions).
- Can force-change plans, override limits, and manage all users/roles across tenants.

## Access matrix (pages + APIs)

Legend:
- **View**: can see the page/data
- **Edit**: can change data or execute actions
- **None**: blocked (server returns 403)

| Feature / API | CS | Technical | Super Admin | Owner | Admin | Member | Viewer |
|---|---|---|---|---|---|---|---|
| Dashboard Overview | View | View | View | View | View | View | View |
| Plans & Pricing (GET /api/plans) | View | View | View | View | View | View | View |
| Subscription summary (GET /api/subscription) | View | View | View | View | View | None | None |
| Change plan (POST /api/subscription/change-plan) | None (configurable) | None | Edit | Edit | Edit | None | None |
| Users list (GET /api/users) | View | None | View | View | View | None | None |
| Invite/add user (POST /api/users, POST /api/users/invite) | None | None | Edit | Edit | Edit | None | None |
| Change user role/deactivate (PATCH /api/users/:id) | None | None | Edit | Edit | Edit | None | None |
| Workflows list/create (GET/POST /api/workflows) | None | Edit | Edit | Edit | Edit | None | None |
| Failures + monitoring (GET /api/failures, GET /api/activity-logs) | None | View | View | None | None | None | None |
| Automation Engine logs (GET /api/admin/ae/logs) | None | View | View | None | None | None | None |
| Integrations list/manage/test (GET/POST/PATCH /api/integrations/*) | None | Edit | Edit | Edit | Edit | None | None |
| Global Admin (GET /api/admin/*) | None | None | Edit/View | None | None | None | None |

## How roles are assigned

- **Default role for new tenant users**: `member`.
- **Who can change roles**:
  - Tenant **Owner/Admin** can change roles within their workspace between `viewer/member/admin/owner`.
  - Only **Super Admin** can assign platform roles `cs`, `technical`, or `super_admin`.
- **Bootstrap behavior**:
  - The first users created during deployment are standard tenant users (admin + developer/member) for TaskyHub login.
  - Super Admin should be granted explicitly (internal staff only), typically by setting `is_super_admin=true` for a specific internal user.

## Security notes (important)

- **Backend RBAC is enforced on every request**. Hiding UI tabs is only a convenience.
- **Integration secrets are never returned** from any API. Only labels, status, and n8n credential id metadata are exposed.
- **Super Admin is powerful**: it can affect any tenant. Restrict it to internal staff only.

## Example flows

### Example 1 — CS reviews a customer
1. CS logs in and opens “Subscription”.
2. CS sees the customer’s current plan, status, renewal period, and seat usage.
3. CS opens “Users” to see who is in the workspace and whether they are active.
4. CS cannot access monitoring or Automation Engine pages.

### Example 2 — Technical user troubleshoots an automation
1. Technical user logs in and opens “Workflows”.
2. They review workflows and create/update workflows as needed (within plan limits).
3. They open “Integrations” to check connection status and run “Test” if needed.
4. They open “Failures/Logs” for troubleshooting and monitoring.
5. They cannot change subscription plans or invite users.

### Example 3 — Super Admin performs a plan change and role assignment
1. Super Admin opens “Subscription” and changes a tenant from Team to Business.
2. If the tenant has too many users for the target plan, TaskyHub blocks the change and explains why.
3. Super Admin opens “Global Users” and assigns a user the `cs` role (or marks them as `super_admin`).
4. The UI updates immediately; backend RBAC enforces access on subsequent requests.

