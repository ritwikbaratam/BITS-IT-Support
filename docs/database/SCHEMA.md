# BITS IT Support database design

## Persistence choice

BITS IT Support uses file-backed SQLite at `backend/data/aegis.db` by default. Startup creates missing tables and seeds demo records in development when the users table is empty. The [SQL in database.js](../../backend/src/database.js) is the schema source of truth. The [ER diagram](../diagrams/ER_DIAGRAM.md) shows the relationships.

## Core tables

| Table | Purpose | Important fields / constraints |
| --- | --- | --- |
| `users` | Accounts for all roles | unique lowercased email; password hash; role constrained to EMPLOYEE/TECHNICIAN/ADMINISTRATOR; active flag |
| `sessions` | Opaque local login sessions | unique token hash; user FK; expiry; revocable |
| `users` technician fields | Technician skills and capacity | `skills` JSON, `available`, and `capacity` in the account row |
| `it_services` | Managed services | unique name; criticality 1-3; active flag |
| `categories` | Configurable classification | unique name, keyword JSON, active flag |
| `sla_policies` | Editable response/resolution targets | unique priority and positive minute targets |
| `system_configuration` | Selected assignment strategy | key/value pair persisted across restarts |
| `incidents` | Current and historical incident state | unique public incident code, reporter and service foreign keys, optional category and assignee, lifecycle state, priority, resolution and SLA snapshots |
| `incident_assignments` | Assignment/reassignment history | incident, current or former technician, actor, reason, strategy and timestamp |
| `investigation_notes` | Technician investigation record | incident and author FKs; server timestamp |
| `incident_comments` | Request-for-information and reply conversation | incident, author, body, timestamp |
| `incident_relationships` | Related or possible duplicate incidents | source and related IDs, relationship type, similarity score, and unique pair constraint |
| `audit_events` | Workflow history and SLA Rescue reminder evidence | timestamp, optional actor and incident, role, action, old/new value and JSON metadata |
| `notifications` | In-app notification inbox | recipient, message, link/incident, read timestamp |
| `simulated_emails` | Local email-outbox simulator | recipient, subject, body, delivery status, incident, timestamp |
| `sla_breaches` | Breach history | incident, breach type, detected timestamp, unique incident/type. Warnings use flags and audit events. |
| `escalations` | Escalation levels and reason | incident, level, reason, destination, timestamp; prevent duplicate level |
| `feedback` | Employee assessment after closure | incident, employee, rating 1-5, comment |
| `service_dependencies` | Service Pulse graph edges | parent/child service FKs; unique edge; no self-edge |

## Keys, integrity, and indexes

- Internal IDs are integer primary keys. Public incident numbers use `INC-YYYYMMDD-####` with the UTC creation date.
- Foreign keys are enabled in SQLite. Historic data uses restrictive/no-cascade semantics rather than deleting audit or incident history when a user/service is deactivated.
- The server validates enum values and numeric ranges before writes; SQLite constraints supply a second safety net.
- The incident index set covers status, priority, reporter, assignee and creation time. Audit indexes use incident and time. Notifications index recipient, read time and creation time.
- Status, priority, SLA outcomes, and role permissions are always evaluated server-side; they are not trusted from UI values.

## SLA snapshot policy

Incident creation copies the applicable policy targets and computes deadlines. Editing a policy changes future snapshots. Admin priority edits through the UI preserve the original deadlines. The API accepts an explicit `recalculateSla` flag and audits the choice. Smart Fix uses historical incident rows with resolutions. SLA Rescue uses the stored deadlines, breach flags, and reminder audit metadata. Historical breach records are retained.

## Seed data

The seed creates one employee, one administrator, four technicians, six services, six categories, four SLA policies, and sample service dependencies. The six fictional incidents cover assigned campus Wi-Fi, an active Student Portal investigation, a payment outage awaiting reporter information, a resolved database backup failure, verified campus network access, and a closed payment software installation issue. The workflows create their audit and notification records. The closed payment case provides a historical match for Smart Fix Suggestions. SLA deadlines start from each report's creation time.

## Persistence verification

Persistence checks use an isolated file specified by `AEGIS_DATABASE_PATH`. See [test results](../testing/TEST_RESULTS.md) for the restart evidence.
