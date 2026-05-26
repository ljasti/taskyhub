# Admin: Plans, Subscriptions, Users, Limits

## Concepts
- Customer (Workspace): a company/account using TaskyHub (name, primary domain, status).
- Plan: pricing + limits (max users, max workflows, included runs per month).
- Subscription: links a customer to a plan and tracks lifecycle (trialing/active/past_due/cancelled).
- Usage: counters shown in UI (users used / allowed, runs used / included).

## Roles (Workspace)
- owner: highest privileges inside a workspace
- admin: can manage workspace users and settings
- member: normal user
- viewer: read-only access (where supported)

## Where Limits Are Enforced
- Users: adding/inviting a user is blocked when the workspace has reached its allowed user count.
- Workflows / Tasks / Runs: limits exist in the data model so we can enforce them as features are wired up.

## Admin Panel Screens
- Subscriptions (super-admin): list all customers and their current plan/status/usage.
- Plans (super-admin): create/edit plans and toggle active/inactive (plans in use are not deleted).
- Global Users (super-admin): overview of users across all customers.
- Workspace Users (workspace admin/owner): manage users inside the current workspace.

## API Endpoints
- Admin (super-admin):
  - GET `/api/admin/subscriptions`
  - GET `/api/admin/customers/:id/subscription`
  - POST `/api/admin/customers/:id/subscription/change-plan`
  - POST `/api/admin/customers/:id/subscription/cancel`
  - POST `/api/admin/customers/:id/subscription/resume`
  - POST `/api/admin/customers/:id/suspend`
  - POST `/api/admin/customers/:id/unsuspend`
  - GET `/api/admin/plans`
  - POST `/api/admin/plans`
  - PATCH `/api/admin/plans/:id`
  - GET `/api/admin/users`
  - PATCH `/api/admin/users/:id`
- Customer scope:
  - GET `/api/users`
  - POST `/api/users/invite`
  - PATCH `/api/users/:id`

## Example (Generic Customer)
- Customer: “Example Co”
- Plan: “Starter” (max users: 10, included runs: 10,000/month)
- Usage shown as: “Users 4 of 10” and “Runs 0 of 10,000”

This is designed so billing integration (Stripe/Paddle) can be added later without changing plan codes or customer IDs.
