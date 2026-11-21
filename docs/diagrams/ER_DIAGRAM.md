# BITS IT Support entity-relationship diagram

```mermaid
erDiagram
  USERS ||--o{ SESSIONS : authenticates
  USERS ||--o{ INCIDENTS : reports
  USERS |o--o{ INCIDENTS : current_assignee
  CATEGORIES |o--o{ INCIDENTS : classifies
  IT_SERVICES ||--o{ INCIDENTS : affected_service
  INCIDENTS ||--o{ INCIDENT_ASSIGNMENTS : assignment_history
  USERS |o--o{ INCIDENT_ASSIGNMENTS : assigned_technician
  USERS |o--o{ INCIDENT_ASSIGNMENTS : assigned_by
  INCIDENTS ||--o{ INVESTIGATION_NOTES : contains
  USERS ||--o{ INVESTIGATION_NOTES : writes
  INCIDENTS ||--o{ INCIDENT_COMMENTS : contains
  USERS ||--o{ INCIDENT_COMMENTS : writes
  INCIDENTS |o--o{ AUDIT_EVENTS : records
  USERS |o--o{ AUDIT_EVENTS : actor
  INCIDENTS |o--o{ NOTIFICATIONS : relates
  USERS ||--o{ NOTIFICATIONS : receives
  INCIDENTS |o--o{ SIMULATED_EMAILS : relates
  USERS |o--o{ SIMULATED_EMAILS : receives
  INCIDENTS ||--o{ SLA_BREACHES : has
  INCIDENTS ||--o{ ESCALATIONS : has
  INCIDENTS ||--o| FEEDBACK : receives
  USERS ||--o{ FEEDBACK : submits
  INCIDENTS ||--o{ INCIDENT_RELATIONSHIPS : source
  INCIDENTS ||--o{ INCIDENT_RELATIONSHIPS : related
  IT_SERVICES ||--o{ SERVICE_DEPENDENCIES : dependent_service
  IT_SERVICES ||--o{ SERVICE_DEPENDENCIES : prerequisite_service

  USERS {
    integer id PK
    text email UK
    text password_hash
    text role
    integer active
    text skills
    integer capacity
    integer available
  }
  INCIDENTS {
    integer id PK
    text incident_code UK
    integer reporter_id FK
    integer assigned_technician_id FK
    integer category_id FK
    integer service_id FK
    text status
    text priority
    text created_at
    text response_deadline
    text resolution_deadline
    text acknowledged_at
    text resolved_at
  }
  SLA_POLICIES {
    integer id PK
    text priority UK
    integer response_minutes
    integer resolution_minutes
  }
  SYSTEM_CONFIGURATION {
    text config_key PK
    text config_value
  }
```

The diagram lists selected columns. Incident creation copies the policy's response and resolution targets into the incident. Policies and configuration have independent keys. Smart Fix uses historical incident data, and SLA Rescue reads snapshots and breach flags and stores reminder metadata in `audit_events`. See the [schema](../database/SCHEMA.md) for constraints.
