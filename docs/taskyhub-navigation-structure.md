# TaskyHub Dashboard Navigation Structure

This document explains how TaskyHub dashboard navigation is organized so users never need horizontal page scrolling to find features.

## Primary navigation (left sidebar)

Primary categories:
- **Overview**: high-level snapshot and KPIs.
- **Workflows**: create and manage workflows (technical).
- **Integrations**: connect providers (OpenAI, Slack, etc.) (technical).
- **Subscription**: plan, pricing, and billing stubs (CS/admin).
- **Users**: team members and access info (CS/admin).
- **Monitoring**: failures, logs, AE/n8n logs, and health stubs (technical).
- **Settings**: workspace settings + operational links (technical).

## Secondary navigation (tabs)

Each primary category renders a secondary tab bar at the top of the content area.

- **Overview**
  - Summary
  - Recent activity (stub)
  - Usage (seat/plan summary)
- **Integrations**
  - All
  - Connected
  - Not connected
- **Subscription**
  - Current plan
  - Plans & pricing
  - Invoices (stub)
- **Users**
  - Members
  - Pending invites (stub)
  - Roles & access (informational)
- **Monitoring**
  - Health (stub)
  - Workflow errors (failures)
  - AE / n8n (logs view)
  - Logs (activity log)
  - System (settings view)

## Role-based visibility

Navigation is filtered by role after login (the UI fetches the current user role via `/api/me`).

- **CS**
  - Sidebar: Overview, Subscription, Users
  - No access: Monitoring, Workflows, Integrations, Settings
- **Technical**
  - Sidebar: Overview, Workflows, Integrations, Monitoring, Settings
  - No access: user management, plan change actions
- **Super Admin**
  - Sees all primary categories plus the **Platform** group (global admin pages)

Important: backend RBAC still enforces access with 403 responses even if a user manually navigates to a hidden section.

## Diagram

Primary sidebar → Secondary tabs → Content cards

- Overview → Summary | Recent activity | Usage → KPI cards + workflow list + quick actions
- Integrations → All | Connected | Not connected → integration cards + connections list
- Subscription → Current plan | Plans & pricing | Invoices → plan summary + plan cards + users table
- Users → Members | Pending invites | Roles & access → users table + invite controls (admin only)
- Monitoring → Health | Workflow errors | AE / n8n | Logs | System → dashboards + log views

