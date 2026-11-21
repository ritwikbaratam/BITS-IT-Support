# BITS IT Support

**Intelligent IT Service Management & Incident Resolution System**

BITS IT Support helps a university IT team track an incident from report to closure. It classifies reports, calculates priority, assigns technicians, monitors service-level agreement (SLA) deadlines, and gives the reporter a way to verify the resolution.

Built for the Object-Oriented Programming course (CS F213 / MAC F212) at **BITS Pilani, Hyderabad Campus**, Semester I, 2026–2027.

## Project preview

![BITS IT Support sign-in screen with the BITS emblem and Hyderabad campus library photograph](docs/screenshots/login.jpg)

<details>
<summary>View dashboards, Smart Fix Suggestions, and SLA Rescue</summary>

| Employee dashboard | Technician dashboard |
| --- | --- |
| ![Employee dashboard with support requests and recent activity](docs/screenshots/employee-dashboard.jpg) | ![Technician dashboard with assigned incidents and workload](docs/screenshots/technician-dashboard.jpg) |

| Administrator dashboard | SLA Rescue |
| --- | --- |
| ![Administrator dashboard with incident and SLA metrics](docs/screenshots/administrator-dashboard.jpg) | ![SLA Rescue queue showing overdue and priority incidents](docs/screenshots/sla-rescue.jpg) |

**Smart Fix Suggestions**

![Incident detail showing a historical resolution, similarity score, and match explanation](docs/screenshots/smart-fix-suggestions.jpg)

</details>

Screenshots use fictional incidents and accounts from an isolated demo.

## Key capabilities

| Workspace | What it supports |
| --- | --- |
| Employee | Sign in, report incidents, track progress, reply to support, verify resolutions, close requests, and leave feedback. |
| Technician | Review the assigned queue and current workload, acknowledge and investigate incidents, request information, record resolutions, and consult historical fixes. |
| Administrator | Oversee incidents, manage users, technicians, services, and categories, configure SLA policies and assignment strategies, review audit history, and export filtered reports as CSV. |
| System automation | Calculate priority from impact, urgency, service criticality, and affected-user count. Suggest categories from keywords and flag potential duplicates. Assign work by skills or workload. Record SLA warnings, breaches, and escalations, with in-app and simulated email notifications. |

## Intelligent features

### Smart Fix Suggestions

The **Related & knowledge** tab ranks relevant historical resolutions the viewer is authorized to access. It normalizes terms such as *Wi-Fi* and *wireless*, compares symptoms and phrases, and considers the affected service, category, and wording of past fixes. Each result includes a similarity score and an explanation. When no match qualifies, the tab offers clearly labelled curated troubleshooting guidance. The recommendation system uses deterministic rules and runs entirely locally.

### SLA Rescue

Administrators get a risk-ordered queue of active incidents, with server-based countdowns, explanations, and suggested next steps. A pending target enters the warning window in the final 20% of its SLA and becomes overdue once the deadline passes. Authorized reminders reuse the audit trail and both notification channels. Each incident, SLA target, and assigned technician combination receives at most one manual reminder. The existing SLA monitor records breaches and escalations.

## Technology and architecture

The browser single-page application uses **JavaScript, HTML5, and CSS3**. **Node.js 24** serves the frontend and HTTP API. **SQLite** provides file-backed storage through the built-in `node:sqlite` module. The runtime uses only built-in Node modules.

```text
Browser SPA → HTTP API → Application services
                              ├─ Domain policies
                              └─ Repositories → SQLite
```

The [HTTP controller](backend/src/server.js) authenticates requests and calls [application services](backend/src/services.js). Services coordinate workflows, use [domain policies](backend/src/domain.js) to enforce rules, and persist records through the [database layer](backend/src/database.js). This separation lets tests exercise business decisions independently of the browser.

## Object-oriented design

`AuthService` encapsulates password and session handling. `IncidentService` abstracts incident operations and composes lifecycle, assignment, audit, and notification collaborators. Inheritance shares behavior across strategies and repositories. Polymorphism lets the service call either assignment implementation through the same `assign` method. SQLite foreign keys associate incidents with reporters, technicians, services, categories, and audit records.

| Pattern | Implementation and benefit |
| --- | --- |
| Strategy | `TechnicianAssignmentStrategy` defines the `assign` contract. `SkillBasedAssignmentStrategy` and `LeastLoadedAssignmentStrategy` can be swapped through configuration. |
| Observer | `EventPublisher` calls `handle(event)` on `InAppNotificationChannel` and `SimulatedEmailNotificationChannel`. Each channel handles delivery independently of the incident workflow. |
| Factory | `IncidentFactory` builds initial incident data, and `AssignmentStrategyFactory` selects the configured implementation. Both centralize creation rules. |
| Repository | `UserRepository` and `IncidentRepository` extend `BaseRepository` and encapsulate recurring SQLite queries and inserts. |

See the [OOP design notes](docs/OOP_DESIGN_EXPLAINED.md) and [class diagram](docs/diagrams/CLASS_DIAGRAM.md) for details.

## Getting started

Install **Git** and **Node.js 24 or newer**. Clone the [BITS IT Support repository](https://github.com/ritwikbaratam/BITS-IT-Support) and start the local server.

```text
git clone https://github.com/ritwikbaratam/BITS-IT-Support.git
cd BITS-IT-Support
node backend/src/server.js
```

Open [http://localhost:8080](http://localhost:8080). Stop the server with **Ctrl+C**. Startup initializes SQLite at `backend/data/aegis.db` by default. Outside production mode, a database with no users is seeded automatically with fictional accounts and incidents.

### Local demo accounts

Use these seeded credentials only for local academic demonstrations.

| Display name | Role | Login email | Demo password | Technician specialization (seeded skills) |
| --- | --- | --- | --- | --- |
| Avery Morgan | Administrator | `admin@aegis.local` | `Admin@12345` | ? |
| Riya Shah | Employee | `employee@aegis.local` | `Employee@12345` | ? |
| Alex Rivera | Technician | `alex.network@aegis.local` | `Technician@12345` | Network, VPN, DNS, Wi-Fi |
| Jamie Chen | Technician | `jamie.apps@aegis.local` | `Technician@12345` | Software, applications, payment, authentication |
| Samira Patel | Technician | `samira.database@aegis.local` | `Technician@12345` | Database, SQL, backup, cloud |
| Noah Williams | Technician | `noah.security@aegis.local` | `Technician@12345` | Security, MFA, authentication, cloud |

## Testing and verification

Verified on Node.js 24.18.0. See the [test results](docs/testing/TEST_RESULTS.md) for the run and its scope.

| Check | Result |
| --- | --- |
| Backend tests | **56 passed**, 0 failed, 0 skipped |
| Microsoft Edge smoke tests | **17 groups passed** |
| Syntax checks | Passed |
| SQLite persistence | An incident and its audit history survived a separate Node process reopening an isolated database |

Coverage includes authentication and role permissions, the incident lifecycle, assignment, priority, SLA monitoring, Smart Fix, notifications, audit history, and responsive UI behavior.

From the repository root in PowerShell, run the backend and syntax checks. In other shells, use `npm run check` for the syntax check.

```powershell
node --test backend/test
npm.cmd run check
```

For browser checks, install Microsoft Edge and place Playwright Core in a temporary directory. The smoke script starts its own server and uses an isolated in-memory database.

```powershell
$qa = Join-Path $env:TEMP 'aegis-qa-tools'
npm.cmd install --prefix "$qa" playwright-core
$env:AEGIS_PLAYWRIGHT_MODULE = ([uri]::new((Join-Path $qa 'node_modules/playwright-core/index.mjs'))).AbsoluteUri
node scripts/browser-smoke.mjs
```

## Security and limitations

Passwords use salted scrypt hashes. Opaque bearer sessions expire and can be revoked through sign-out. The server validates input, enforces role and incident access, and records workflow actions in an audit trail.

This prototype runs locally. Email is simulated in a local outbox, SLA policies are configured by priority and use continuous calendar time, and browser verification covers Microsoft Edge.

## Documentation

| Topic | References |
| --- | --- |
| Course requirements | [Requirements](docs/requirements/REQUIREMENTS.md) · [Compliance matrix](docs/requirements/COMPLIANCE_MATRIX.md) |
| Architecture and design | [Architecture](docs/architecture/ARCHITECTURE.md) · [OOP design](docs/OOP_DESIGN_EXPLAINED.md) |
| Diagrams and persistence | [Use case](docs/diagrams/USE_CASE_DIAGRAM.md) · [Class](docs/diagrams/CLASS_DIAGRAM.md) · [Sequence](docs/diagrams/INCIDENT_SEQUENCE.md) · [ER diagram](docs/diagrams/ER_DIAGRAM.md) · [Database schema](docs/database/SCHEMA.md) |
| Verification | [Test cases](docs/testing/TEST_CASES.md) · [Test results](docs/testing/TEST_RESULTS.md) |

## Team & Responsibilities

| Team member | Leadership and assigned responsibilities |
| --- | --- |
| Ritwik Rohan Baratam | Project lead for full-stack integration, OOP architecture, backend automation, technician and administrator functionality, testing, stabilization, repository management, and report preparation. Presents architecture, automation, testing, and the conclusion. |
| Pavuluri Venkata Manikanteshwara Reddy | Validates the technician workflow, investigation and resolution, SLA timelines, and usability. Presents the technician workspace. |
| Akhil Peesapati | Validates administration, user and technician management, services, categories, SLA policies, and assignment strategies. Introduces the project and presents administration, SLA Rescue, reports, and the audit trail. |
| Vadrevu Vivek | Validates employee registration and login, incident reporting and tracking, communication, verification, closure, and feedback. Presents the employee workspace. |
