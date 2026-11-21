# BITS IT Support requirements specification

## Stakeholders and problem

The campus relies on payment, network, database, authentication, and student portal services. Reports scattered across messages and spreadsheets obscure ownership, urgency, missed deadlines, and past fixes. BITS IT Support gives employees one place to track requests, technicians an assigned queue, and administrators policy and reporting controls. The project models one organisation on a local server with fictional sample data and continuous calendar-time targets.

## Functional requirements

| ID | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-01 | Employee registration and login | Public registration creates employees. Valid credentials create an expiring session. |
| FR-02 | RBAC | Employee, technician, and admin protected operations reject unauthorized actors |
| FR-03 | Incident reporting | Valid report creates a persistent numbered incident with reporter, category/service, priority, SLA and audit data |
| FR-04 | Lifecycle | Enforce the normal sequence from NEW through CLASSIFIED, ASSIGNED, ACKNOWLEDGED, IN_PROGRESS, RESOLVED, VERIFIED and CLOSED. Requests for information can pause investigation, and a rejected resolution returns to investigation. |
| FR-05 | Priority | Impact, urgency, service/business criticality, and affected users produce deterministic P1-P4 explanation |
| FR-06 | Assignment | Skill-based and least-loaded strategies select only eligible technicians; admin can change strategy/reassign |
| FR-07 | SLA | Apply editable response and resolution targets by priority, capture deadlines on the incident, warn before deadlines, record breaches once per target, and expose an administrator rescue queue with server-time countdowns and deduplicated reminders. |
| FR-08 | Notifications | Relevant events create both in-app entries and simulated-email outbox rows |
| FR-09 | Audit | Important actions append server-side timeline entries with actor, time, action, description and state changes where applicable. |
| FR-10 | Intelligence | Provide keyword category suggestions, access-scoped duplicate matches, explainable Smart Fix rankings or curated fallback, and rule-based SLA risk and escalation. |
| FR-11 | Search and reporting | Combine register criteria such as text, code, status, priority, category, service, technician and SLA state. Generate database-backed metrics and filtered CSV exports. |
| FR-12 | Administration | Admin manages users, technicians, services, categories, SLAs, and assignment configuration |
| FR-13 | Demonstration | Seed data supports three end-to-end workflows |

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01 | Local install must not require paid APIs, Docker, or cloud credentials. |
| NFR-02 | User input is validated; password hashes and session controls are never exposed in API DTOs. |
| NFR-03 | SQLite data persists across a normal server restart. |
| NFR-04 | UI works on common desktop widths and adjusts for narrower screens; keyboard labels and focus states are provided. |
| NFR-05 | Dashboards, filters, and reports use database records rather than static totals. |
| NFR-06 | Errors use clear, safe messages and appropriate HTTP statuses. |
| NFR-07 | Code must make OOP abstractions, patterns, and exception boundaries understandable to a beginner. |

## Role permissions

| Operation | Employee | Technician | Administrator |
| --- | --- | --- |
| Register self | Yes, employee only | No | No |
| Report incidents | Yes | No | Yes |
| View incidents | Own reports | Assigned incidents | All incidents |
| Reply, verify or reject resolution, and give feedback | Own incidents, subject to state | Request information on assigned incidents | Verify own reports |
| Close after verification | Own incidents | No | Verified incidents |
| Acknowledge, investigate and resolve | No | Assigned incidents | Oversight |
| Manage user/service/category/SLA configuration | No | No | Yes |
| Change assignment strategy / manual reassignment | No | No | Yes |
| Read Smart Fix Suggestions | No | From assigned history | From authorized staff-wide history |
| Review SLA Rescue and send reminders | No | Receive reminders | Yes |
| View audit / outbox / reports / escalations | Own timeline only | Assigned timelines | Yes |

## Key business rules

1. Normal employees cannot create privileged accounts or view another employee's private incident.
2. A resolved incident must contain a resolution description; verification follows resolution; closure follows verification.
3. A technician must be active, available, have capacity, and be authorized before an assignment is made.
4. Server-generated SLA deadlines use UTC calendar time. The initial response/resolution defaults are P1 5/30 minutes, P2 15/120 minutes, P3 60/480 minutes, and P4 240/1440 minutes. Recorded breaches survive later resolution.
5. Possible duplicates are advisory links the reporter may choose when filing.
6. Backend operations create the audit trail and notification events.

See the [compliance matrix](COMPLIANCE_MATRIX.md) for assignment coverage and the [OOP design](../OOP_DESIGN_EXPLAINED.md) for scoring and risk rules.
