# BITS IT Support class diagram

```mermaid
classDiagram
  direction LR
  class IncidentService {
    +incidents
    +clock
    +create(actor, input)
    +recordTransition(incident, actor, to, action, description, fields)
    +assign(actor, id, input)
    +recommendations(actor, id)
    +rescueQueue(actor)
    +remindForRescue(actor, id, input)
    +monitorSla()
  }
  class AuthService {
    +users
    +createUser(input, actor)
    +login(email, password)
    +actorForToken(token)
    +logout(token)
  }
  class AdminService {
    +updateUser(actor, id, input)
    +updatePolicy(actor, priority, input)
    +updateAssignmentStrategy(actor, input)
  }
  class ReportService {
    +overview(actor, filters)
    +trends(actor)
  }
  class IncidentLifecycle {
    +transitions$
    +assertTransition(from, to)$
  }
  class IncidentFactory {
    +priorityCalculator
    +clock
    +create(input, service, sequence)
  }
  class PriorityCalculator {
    +calculate(input)
  }
  class TechnicianAssignmentStrategy {
    <<abstract>>
    +key
    +eligible(technicians)
    +assign(input)*
  }
  class SkillBasedAssignmentStrategy {
    +assign(input)
  }
  class LeastLoadedAssignmentStrategy {
    +assign(input)
  }
  class AssignmentStrategyFactory {
    +create(key)$
  }
  class CategorySuggester {
    +suggest(text, categories)
  }
  class DuplicateDetector {
    +compare(candidate, existing)
  }
  class HistoricalFixMatcher {
    +rank(current, candidates)
    +guidance(incident)
  }
  class SlaRiskPredictor {
    +target(incident, kind, now)
    +assess(incident, now)
    +rescue(incident, now)
  }
  class EventPublisher {
    +channels
    +subscribe(channel)
    +publish(event)
  }
  class RepositoryNotificationChannel {
    +recipients(event)
  }
  class InAppNotificationChannel {
    +handle(event)
  }
  class SimulatedEmailNotificationChannel {
    +handle(event)
  }
  class AuditService {
    +record(event)
  }
  class BaseRepository {
    +db
    +insert(table, data)
  }
  class UserRepository {
    +byEmail(email)
    +technicians()
  }
  class IncidentRepository {
    +byId(id)
    +historicalFixes(incidentId, technicianId)
    +activeForRescue()
    +rescueReminders(incidentId)
  }
  class AegisDatabase {
    +transaction(callback)
    +get(sql, params)
    +all(sql, params)
    +run(sql, params)
  }

  IncidentService *-- IncidentFactory
  IncidentService *-- CategorySuggester
  IncidentService *-- DuplicateDetector
  IncidentService *-- HistoricalFixMatcher
  IncidentService *-- SlaRiskPredictor
  IncidentService --> IncidentLifecycle
  IncidentService --> AssignmentStrategyFactory
  IncidentService o-- IncidentRepository
  IncidentService o-- EventPublisher
  IncidentService o-- AuditService
  IncidentFactory --> PriorityCalculator
  AssignmentStrategyFactory ..> TechnicianAssignmentStrategy
  TechnicianAssignmentStrategy <|-- SkillBasedAssignmentStrategy
  TechnicianAssignmentStrategy <|-- LeastLoadedAssignmentStrategy
  EventPublisher o-- RepositoryNotificationChannel
  RepositoryNotificationChannel <|-- InAppNotificationChannel
  RepositoryNotificationChannel <|-- SimulatedEmailNotificationChannel
  AuthService o-- UserRepository
  AdminService --> IncidentService
  AdminService --> AuthService
  ReportService --> UserRepository
  ReportService --> AegisDatabase
  BaseRepository <|-- UserRepository
  BaseRepository <|-- IncidentRepository
  BaseRepository --> AegisDatabase
```

The diagram shows selected fields and methods. JavaScript implements `assign(input)` and `handle(event)` as behavioral contracts. Domain exceptions inherit from `DomainError` and carry an HTTP status and code. See the [domain classes](../../backend/src/domain.js), [services](../../backend/src/services.js), [repositories](../../backend/src/database.js), and [data associations](ER_DIAGRAM.md).
