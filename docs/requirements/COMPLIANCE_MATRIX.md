# BITS IT Support assignment compliance

Scope reviewed against all 17 pages of the CS F213 / MAC F212 Semester I, 2026–2027 assignment. The instructor-issued PDF is held with the group's local submission materials. The separate Classroom instructions specify the upload and spreadsheet destinations.

## Functional requirements

| Requirement | Assignment pages | Status | Evidence |
| --- | --- | --- | --- |
| Employee, technician and administrator workspaces | 4–5, 17 | PASS | Three role logins, distinct dashboards and navigation in [Edge smoke](../../scripts/browser-smoke.mjs). |
| Employee registration, authentication, access checks and input validation | 4, 13 | PASS | `AuthService`, server authorization and role-scoped incident reads. Registration, login, unauthorized API requests, disabled-account edits and invalid input are covered by [core tests](../../backend/test/core.test.js) and Edge. |
| Report, view, update, assign, investigate, resolve, verify and close | 3–7 | PASS | `IncidentService` and `IncidentLifecycle`. Edge covers acknowledgements, notes, requests and replies, resolution, verification, closure and feedback. Invalid state changes are rejected in core tests. |
| Classification, affected service and priority | 5–6 | PASS | `CategorySuggester`, `PriorityCalculator`, stored service criticality and affected-user adjustment. Core and Edge checks cover classification, priority and decision explanations. |
| Two interchangeable assignment strategies | 4, 6 | PASS | `SkillBasedAssignmentStrategy` and `LeastLoadedAssignmentStrategy` share the `assign` contract. Core tests verify eligibility and choice, and Edge switches the persisted strategy. |
| SLA calculation, monitoring, warnings and breaches | 4, 7 | PASS | Priority-policy snapshots, server-time countdowns, warning and breach persistence, SLA Rescue and late acknowledgement tests in [core](../../backend/test/core.test.js) and [automation tests](../../backend/test/automation.test.js). |
| Two notification mechanisms | 4, 8 | PASS | Persistent in-app inbox and simulated email outbox, exercised by core tests, Rescue reminder tests and Edge. |
| Incident audit history | 4, 8 | PASS | `AuditService` writes incident events with actor, action, timestamp and state changes where applicable. Edge checks the timeline and restart checks preserve audit history. |
| At least five meaningful search criteria and reporting | 4, 8–9 | PASS | Eight combined criteria passed a supplemental HTTP check. The UI register supports text, code, status, priority, category, service, technician and SLA state. Report filters, larger trend datasets and CSV have test evidence. |
| At least two intelligent or automated features | 4, 9–10 | PASS | Keyword classification, duplicate links, SLA risk and escalation, and Smart Fix rankings with curated fallback. Core, automation and Edge suites exercise these rules. |
| Persistence | 4, 13–15 | PASS | File-backed SQLite, core reopen test and separate-process restart of a clean proposed checkout. [Verification results](../testing/TEST_RESULTS.md) |
| Administrator controls | 4–5 | PASS | `AdminService` handles accounts, technicians, services, categories, policies and strategy. Tests cover duplicate-name conflicts, protected account edits, changes to policy and strategy, reports, and Rescue reminders. |
| Domain exceptions and safe failures | 10, 13 | PASS | Domain exceptions map to safe HTTP responses. Tests exercise bad input, invalid transitions, duplicate conflicts, authorization and browser network recovery. Hardware and storage fault injection is outside the recorded run. |

## OOP requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Encapsulation and abstraction | PASS | `AuthService` encapsulates password and session handling. `IncidentService` and domain policies centralize workflow and decision logic. |
| Inheritance, polymorphism and behavioral contracts | PASS | Assignment strategy subclasses, notification channel subclasses, repository classes and domain exceptions. The `assign` and `handle` contracts are exercised in tests. |
| Composition, associations and class responsibilities | PASS | Services compose policy and persistence collaborators. SQLite foreign keys associate incidents with actors, services and history. [Class diagram](../diagrams/CLASS_DIAGRAM.md) · [ER diagram](../diagrams/ER_DIAGRAM.md) |
| Suitable collections and data structures | PASS | Arrays for ordered records, sets for token comparisons and deduplication, and maps for keyed report data. [OOP design](../OOP_DESIGN_EXPLAINED.md) |
| At least two genuine design patterns | PASS | Strategy, Observer, Factory and Repository are used in the implementation. [OOP design](../OOP_DESIGN_EXPLAINED.md) |

## Deliverables and submission

| Requirement | Assignment pages | Status | Evidence |
| --- | --- | --- | --- |
| Problem analysis and requirements specification | 14 | PASS | [Requirements](REQUIREMENTS.md) covers stakeholders, challenges, solution, assumptions and acceptance criteria. |
| Architecture, technology rationale and UML | 12, 14 | PASS | [Architecture](../architecture/ARCHITECTURE.md), [use cases](../diagrams/USE_CASE_DIAGRAM.md), [class diagram](../diagrams/CLASS_DIAGRAM.md), and [sequence diagram](../diagrams/INCIDENT_SEQUENCE.md). |
| Database schema, ER diagram and sample data | 14–15 | PASS | [Schema and seed design](../database/SCHEMA.md), [ER diagram](../diagrams/ER_DIAGRAM.md), and fresh checkout verification. |
| At least 15 documented test cases | 15 | PASS | [48 documented cases](../testing/TEST_CASES.md) with source references and a separate results record. |
| Complete source and role responsibilities | 14–15 | PASS | Runnable browser app, API, tests, assets and scripts in the proposed tree. The [README](../../README.md#team--responsibilities) records leadership and assigned roles. |
| Final PDF report | 17 | PENDING | Prepare and upload the final report separately. |
| 15–20 minute group recording | 15, 17 | PENDING | Record at least three complete workflows with participation from every member. |
| Submission folder and spreadsheet | 14–15, 17 and Classroom | PENDING | Upload the PDF and video only to the group-number folder. Enter the group number and final GitHub URL in the shared spreadsheet. |

The Classroom deadline supplied with the assignment is **22 November 2026, 11:59 PM IST**. Scope limits include local deployment, simulated email, calendar-time SLAs by priority, and Edge-only browser evidence.
