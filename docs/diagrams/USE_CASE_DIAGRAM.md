# BITS IT Support use-case diagram

```mermaid
flowchart LR
  Employee([Employee])
  Technician([Technician])
  Admin([Administrator])

  subgraph Support["BITS IT Support"]
    Register([Register an employee account])
    Login([Sign in and view notifications])
    Report([Report and track incidents])
    Reply([Reply to requests for information])
    Verify([Verify, close and give feedback])
    Queue([View assigned queue and workload])
    Work([Acknowledge, investigate and resolve])
    Fix([Review Smart Fix Suggestions])
    Configure([Manage users, technicians, services and categories])
    Policy([Set SLA policy and assignment strategy])
    Monitor([Monitor incidents, SLA and escalations])
    Rescue([Review SLA Rescue and send reminders])
    Audit([View audit trail, reports and outbox])
  end

  Employee --- Register
  Employee --- Login
  Employee --- Report
  Employee --- Reply
  Employee --- Verify
  Technician --- Login
  Technician --- Queue
  Technician --- Work
  Technician --- Fix
  Admin --- Login
  Admin --- Configure
  Admin --- Policy
  Admin --- Monitor
  Admin --- Rescue
  Admin --- Audit
  Admin --- Fix
```

Employees see their own incidents, technicians see assigned incidents, and administrators oversee all records. An administrator can also report an incident and verify its resolution as the original reporter. Authorization is enforced by the [application services](../../backend/src/services.js).
