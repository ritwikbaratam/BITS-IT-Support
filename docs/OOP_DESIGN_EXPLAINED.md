# BITS IT Support object-oriented design

## Encapsulation and abstraction

`IncidentService` in `backend/src/services.js` owns mutations. Its `recordTransition` method calls `IncidentLifecycle.assertTransition`, updates status/version and appends an audit event. HTTP clients receive DTOs and request specific actions. `AuthService` keeps hashes and session rows behind `createUser`, `login`, `actorForToken` and `logout`.

The JavaScript strategy base class in `backend/src/domain.js` defines a shared contract. JavaScript checks that contract at runtime. The concrete classes share `eligible(technicians)`, which excludes inactive, unavailable and full technicians.

## Strategy, inheritance and polymorphism

The non-HTTP incident creation code uses this actual statement:

```js
const assignment = AssignmentStrategyFactory.create(strategyKey).assign({ technicians, categoryName: category.name, serviceName: service.name });
```

`SkillBasedAssignmentStrategy` and `LeastLoadedAssignmentStrategy` extend `TechnicianAssignmentStrategy`. The skill strategy scores `100 × skill matches + 4 × remaining capacity − active workload`, then breaks ties by lower workload and name. The least-loaded strategy sorts by active workload and then name. The persisted strategy key selects which implementation runs through the same `assign` contract.

`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError` and `LifecycleError` extend `DomainError`. The HTTP controller reads their status, code and message. This is another concrete inheritance relationship used by the application.

## Observer and notification channels

The publisher in `backend/src/services.js` invokes subscribers through a single behavioral contract:

```js
subscribe(channel) { this.channels.push(channel); }
publish(event) { this.channels.forEach((channel) => channel.handle(event)); }
```

`InAppNotificationChannel` and `SimulatedEmailNotificationChannel` extend `RepositoryNotificationChannel` and implement `handle(event)`. To add a channel, provide a handler and register it with the publisher. The service calls `AuditService.record` explicitly so each mutation can record its actor, prior value and next value.

## Factory, repository and composition

`IncidentFactory.create` combines a clock, a public sequence code, normalized input and the result of `PriorityCalculator.calculate`. `IncidentService.create` adds the SLA snapshot, assignment and audit records. `UserRepository` and `IncidentRepository` extend `BaseRepository` for shared inserts and encapsulate repeated queries. Some workflow-specific queries live next to their use cases in the services.

Services compose collaborators through constructor parameters. The incident relates to its reporter, technician, service and category through foreign keys. Its audit timeline, assignment history, SLA deadlines and feedback have distinct lifecycles and explicit links. Arrays store timelines and strategy candidates, sets normalize text tokens and deduplicate event recipients, and maps support grouped reports.

## Priority, classification and duplicate detection

`PriorityCalculator` multiplies impact, urgency and service criticality, each scored from 1 to 3. The affected-user adjustment adds 0, 1, 3 or 5 points at the thresholds of 1, 20, 100 and 500 users. P1 starts at 23, P2 at 15, P3 at 7, and scores of 6 or less are P4. The base product combines the three severity dimensions. The bounded adjustment accounts for reach while retaining the base score's influence.

`CategorySuggester` matches whole words and phrases against stored keywords. `DuplicateDetector` compares the text of open incidents the reporter can view, combining shared-token similarity with service and category matches. Suggested relationships are advisory.

## Smart Fix Suggestions

`IncidentService.recommendations` authorizes the current incident and asks `IncidentRepository` for up to 200 recent resolved, verified, or closed incidents with recorded resolution text. Technicians get only incidents currently assigned to them. Administrators can use the staff-wide history. Employees receive no suggestions. The matcher returns the historical title, service, category, and a resolution summary of up to 360 characters. It excludes private notes, reporter fields, and raw historical descriptions, and masks common credentials, email addresses, URLs, and tokens in displayed text. Pattern-based masking has limited coverage for unexpected secret formats, so operational notes should avoid credentials and personal information.

`HistoricalFixMatcher` lowercases the title and description, normalizes punctuation and accents, and removes generic words. It maps terms such as Wi-Fi and wireless to `wifi`, sign-in and log-in to `login`, and 2FA to `mfa`. It compares unique words and adjacent two-word phrases within each normalized field.

| Signal | Points available |
| --- | ---: |
| Jaccard similarity of title and description combined | 45 |
| Jaccard similarity of titles | 15 |
| Jaccard similarity of adjacent phrases | 15 |
| Fraction of current symptom words present in the historical resolution | 10 |
| Same affected service | 10 |
| Same category | 5 |

Candidates need at least two shared symptom words or one recognized symptom term such as `wifi`, `mfa`, or `timeout`. Empty and placeholder resolutions are excluded. Scores are rounded and must reach 26 out of 100. Up to four results appear, with the newest resolution first on equal scores. The explanation lists matched symptoms and phrases, any shared service or category, and whether the resolution mentions current symptoms. The score measures lexical similarity. When no history qualifies, the tab labels safe network, sign-in, or generic service troubleshooting as curated guidance. All guidance is advisory.

## SLA Rescue

`SlaRiskPredictor.target` reads the persisted response and resolution snapshots and evaluates each against the supplied clock. The incident register, monitor, and rescue queue share that target calculation. The final 20% of the configured calendar-time window is approaching. A target is due at equality and overdue immediately after it. A late acknowledgement remains visible as a missed response even after the applicable countdown moves to the resolution target. The detail timeline and rescue queue both anchor elapsed time to a timestamp evaluated by the server.

The queue sorts active incidents by the following risk order, then by priority, earliest outstanding deadline, and incident ID. Resolved, verified, and closed incidents are excluded.

| Risk | Rule |
| --- | --- |
| Overdue | A pending target has passed its deadline. |
| SLA breached | A breach is recorded or a completed target was late, while no pending target is overdue. |
| P1 attention | An active P1 incident requires immediate review. |
| Approaching | A pending target is in its final 20% or is due now. |
| Needs assignment | The incident has no active assigned technician and no higher-ranked risk. |
| On track | The remaining active incidents. The reason still identifies pending acknowledgement. |

Administrators can review an incident, request a technician update, or use the existing incident reassignment and SLA monitor controls. Recommendations reflect assignment, acknowledgement, information requests, and escalation state. The read-only queue refreshes at regular intervals and when a displayed target passes. The browser advances countdowns from the server evaluation time. The service writes one manual reminder per incident, response or resolution target, and assigned technician, using the audit record as the deduplication key. It verifies the assignment and target at submission and publishes to both Observer channels in the same SQLite transaction. Existing lifecycle, capacity and escalation rules apply. Rescue never changes an assignment or SLA policy by itself.
