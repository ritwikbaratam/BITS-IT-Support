import crypto from 'node:crypto';
import {
  AssignmentStrategyFactory,
  CategorySuggester,
  ConflictError,
  DomainError,
  DuplicateDetector,
  ForbiddenError,
  HistoricalFixMatcher,
  IncidentFactory,
  IncidentLifecycle,
  IncidentStatus,
  NotFoundError,
  Priorities,
  PriorityCalculator,
  Roles,
  SlaRiskPredictor,
  UnauthorizedError,
  ValidationError,
  addMinutes,
  assertRole,
  createToken,
  hashPassword,
  minutesBetween,
  nowIso,
  parseJson,
  toPublicUser,
  verifyPassword,
} from './domain.js';
import { IncidentRepository, UserRepository } from './database.js';

const SYSTEM_ACTOR = Object.freeze({ id: null, role: 'SYSTEM', name: 'AEGIS SLA monitor' });
const ACTIVE_STATUSES = [IncidentStatus.NEW, IncidentStatus.CLASSIFIED, IncidentStatus.ASSIGNED, IncidentStatus.ACKNOWLEDGED, IncidentStatus.IN_PROGRESS, IncidentStatus.WAITING_FOR_INFORMATION];
const closedStatuses = [IncidentStatus.RESOLVED, IncidentStatus.VERIFIED, IncidentStatus.CLOSED];
const rescueOrder = ['OVERDUE', 'BREACHED', 'CRITICAL', 'APPROACHING', 'UNASSIGNED', 'ON_TRACK'];
const reminderKey = (incidentId, target, technicianId) => `${incidentId}:${target}:${technicianId}`;
const asBool = (value) => value === true || value === 1 || value === '1' || value === 'true';
const toId = (value, name = 'ID') => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`${name} must be a positive number`);
  return id;
};
const requireText = (value, name, min = 1, max = 5000) => {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) throw new ValidationError(`${name} must contain ${min}-${max} characters`);
  return text;
};
const writeWithUniqueName = (write, conflictMessage) => {
  try {
    return write();
  } catch (error) {
    // SQLITE_CONSTRAINT_UNIQUE, including case-insensitive name collisions.
    if (error.code === 'ERR_SQLITE_ERROR' && error.errcode === 2067) throw new ConflictError(conflictMessage);
    throw error;
  }
};
const utcDateBounds = ({ from, to }) => {
  const parseBound = (value, time) => {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new ValidationError('Date filters must be valid YYYY-MM-DD values');
    }
    const timestamp = new Date(value + time);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== value) {
      throw new ValidationError('Date filters must be valid YYYY-MM-DD values');
    }
    return timestamp.toISOString();
  };
  const start = parseBound(from, 'T00:00:00.000Z');
  const end = parseBound(to, 'T23:59:59.999Z');
  if (start && end && start > end) throw new ValidationError('From date must be on or before the to date');
  return { from: start, to: end };
};
const safeError = (error) => error instanceof DomainError ? error : new DomainError('An unexpected server error occurred', 500, 'INTERNAL_ERROR');
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

class RepositoryNotificationChannel {
  constructor(database, users) { this.db = database; this.users = users; }
  recipients(event) { return [...new Set((event.recipients ?? []).filter(Boolean).map(Number))]; }
}

/** Concrete Observer channel: persistent in-app messages. */
export class InAppNotificationChannel extends RepositoryNotificationChannel {
  handle(event) {
    for (const recipientId of this.recipients(event)) {
      this.db.run(`INSERT INTO notifications (recipient_id, incident_id, type, subject, message, created_at)
        VALUES (:recipientId, :incidentId, :type, :subject, :message, :createdAt)`, {
        recipientId, incidentId: event.incidentId ?? null, type: event.type, subject: event.subject, message: event.message, createdAt: event.createdAt,
      });
    }
  }
}

/** Concrete Observer channel: local, inspectable simulated e-mail outbox. */
export class SimulatedEmailNotificationChannel extends RepositoryNotificationChannel {
  handle(event) {
    for (const recipientId of this.recipients(event)) {
      const recipient = this.users.byId(recipientId);
      if (!recipient) continue;
      this.db.run(`INSERT INTO simulated_emails (recipient_id, recipient_email, incident_id, subject, body, delivery_status, created_at)
        VALUES (:recipientId, :email, :incidentId, :subject, :body, 'SIMULATED_DELIVERED', :createdAt)`, {
        recipientId, email: recipient.email, incidentId: event.incidentId ?? null, subject: event.subject, body: event.message, createdAt: event.createdAt,
      });
    }
  }
}

/** Event publisher / Observer subject. New channels only need a handle(event) method. */
export class EventPublisher {
  constructor(channels = []) { this.channels = channels; }
  subscribe(channel) { this.channels.push(channel); }
  publish(event) { this.channels.forEach((channel) => channel.handle(event)); }
}

export class AuditService {
  constructor(database, clock = () => new Date()) { this.db = database; this.clock = clock; }
  record({ incidentId = null, actor = SYSTEM_ACTOR, action, oldValue = null, newValue = null, description, metadata = {} }) {
    this.db.run(`INSERT INTO audit_events (incident_id, actor_id, actor_role, action_type, old_value, new_value, description, metadata, created_at)
      VALUES (:incidentId, :actorId, :actorRole, :action, :oldValue, :newValue, :description, :metadata, :createdAt)`, {
      incidentId, actorId: actor?.id ?? null, actorRole: actor?.role ?? 'SYSTEM', action,
      oldValue: oldValue == null ? null : String(oldValue), newValue: newValue == null ? null : String(newValue),
      description, metadata: JSON.stringify(metadata), createdAt: nowIso(this.clock),
    });
  }
}

export class AuthService {
  constructor(database, users, audit, clock = () => new Date()) {
    this.db = database; this.users = users; this.audit = audit; this.clock = clock;
  }

  createUser(input, actor = null) {
    const name = requireText(input.name, 'Name', 2, 100);
    const email = requireText(input.email, 'Email', 5, 254).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new ValidationError('Email address is invalid');
    const requestedRole = input.role ?? Roles.EMPLOYEE;
    if (!actor && requestedRole !== Roles.EMPLOYEE) throw new ForbiddenError('Public registration may only create employee accounts');
    const role = actor ? requestedRole : Roles.EMPLOYEE;
    if (!Object.values(Roles).includes(role)) throw new ValidationError('Role is invalid');
    if (actor) assertRole(actor, Roles.ADMINISTRATOR);
    if (this.users.byEmail(email)) throw new ConflictError('An account with this email already exists');
    const skills = Array.isArray(input.skills) ? input.skills.map((skill) => String(skill).trim()).filter(Boolean).slice(0, 20) : [];
    const capacity = Number(input.capacity ?? 6);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 99) throw new ValidationError('Capacity must be a whole number from 0 to 99');
    const id = this.users.insert('users', {
      name, email, password_hash: hashPassword(input.password), role,
      active: input.active === undefined ? 1 : asBool(input.active) ? 1 : 0,
      skills: JSON.stringify(skills), available: input.available === undefined ? 1 : asBool(input.available) ? 1 : 0,
      capacity, created_at: nowIso(this.clock),
    });
    const result = this.users.byId(id);
    this.audit.record({ actor: actor ?? { id, role }, action: 'USER_CREATED', description: `${role} account ${email} was created.`, metadata: { userId: id, role } });
    return toPublicUser(result);
  }

  login(email, password) {
    const user = this.users.byEmail(String(email ?? '').trim().toLowerCase());
    if (!user || !user.active || !verifyPassword(String(password ?? ''), user.password_hash)) throw new UnauthorizedError('Invalid email or password');
    const rawToken = createToken();
    const createdAt = nowIso(this.clock);
    const expiresAt = new Date(this.clock().getTime() + 12 * 60 * 60 * 1000).toISOString();
    this.db.run('DELETE FROM sessions WHERE expires_at <= :now', { now: createdAt });
    this.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (:tokenHash,:userId,:expiresAt,:createdAt)', {
      tokenHash: tokenHash(rawToken), userId: user.id, expiresAt, createdAt,
    });
    this.audit.record({ actor: { id: user.id, role: user.role }, action: 'LOGIN', description: `${user.email} signed in.` });
    return { token: rawToken, expiresAt, user: toPublicUser(user) };
  }

  actorForToken(token) {
    if (!token) throw new UnauthorizedError();
    const row = this.db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=:tokenHash AND s.expires_at > :now`, { tokenHash: tokenHash(token), now: nowIso(this.clock) });
    if (!row || !row.active) throw new UnauthorizedError('Your session is invalid or expired');
    return toPublicUser(row);
  }

  logout(token) {
    if (!token) return;
    this.db.run('DELETE FROM sessions WHERE token_hash = :tokenHash', { tokenHash: tokenHash(token) });
  }
}

export class IncidentService {
  constructor({ database, users, incidents, audit, publisher, clock = () => new Date() }) {
    this.db = database;
    this.users = users;
    this.incidents = incidents;
    this.audit = audit;
    this.publisher = publisher;
    this.clock = clock;
    this.priorityCalculator = new PriorityCalculator();
    this.factory = new IncidentFactory(this.priorityCalculator, clock);
    this.categorySuggester = new CategorySuggester();
    this.duplicateDetector = new DuplicateDetector();
    this.fixMatcher = new HistoricalFixMatcher();
    this.riskPredictor = new SlaRiskPredictor();
  }

  isAdmin(actor) { return actor?.role === Roles.ADMINISTRATOR; }
  isReporter(actor, incident) { return actor?.role === Roles.EMPLOYEE && Number(actor.id) === Number(incident.reporter_id); }
  isAssignee(actor, incident) { return actor?.role === Roles.TECHNICIAN && Number(actor.id) === Number(incident.assigned_technician_id); }
  assertCanView(actor, incident) {
    if (this.isAdmin(actor) || this.isReporter(actor, incident) || this.isAssignee(actor, incident)) return;
    throw new ForbiddenError('You may only view incidents assigned to you or reported by you');
  }
  assertTechnicianAssignee(actor, incident) {
    if (!this.isAssignee(actor, incident)) throw new ForbiddenError('Only the assigned technician can perform this action');
  }
  assertReporter(actor, incident) {
    if (!this.isReporter(actor, incident)) throw new ForbiddenError('Only the reporting employee can perform this action');
  }

  admins() { return this.db.all("SELECT id FROM users WHERE role='ADMINISTRATOR' AND active=1").map((row) => row.id); }
  notify(event) {
    this.publisher.publish({ createdAt: nowIso(this.clock), ...event });
  }

  recordTransition(incident, actor, to, action, description, fields = {}) {
    IncidentLifecycle.assertTransition(incident.status, to);
    const now = nowIso(this.clock);
    this.db.run(`UPDATE incidents SET status=:status, updated_at=:updatedAt, version=version+1 ${Object.keys(fields).map((key) => `, ${key}=:${key}`).join('')} WHERE id=:id`, {
      id: incident.id, status: to, updatedAt: now, ...fields,
    });
    this.audit.record({ incidentId: incident.id, actor, action, oldValue: incident.status, newValue: to, description });
    return this.incidents.byId(incident.id);
  }

  categorySuggestion(description, title = '') {
    const categories = this.db.all('SELECT * FROM categories WHERE active=1 ORDER BY name');
    const suggested = this.categorySuggester.suggest(`${title} ${description}`, categories);
    return {
      ...suggested,
      category: suggested.category ? { id: suggested.category.id, name: suggested.category.name } : null,
    };
  }

  duplicates(input, actor = null) {
    const active = this.db.all(`SELECT i.*, c.name AS category_name, s.name AS service_name FROM incidents i
      LEFT JOIN categories c ON c.id=i.category_id JOIN it_services s ON s.id=i.service_id
      WHERE i.status NOT IN ('RESOLVED','VERIFIED','CLOSED')
        AND (:scope = 'ADMINISTRATOR' OR (:scope = 'EMPLOYEE' AND i.reporter_id = :actorId)
          OR (:scope = 'TECHNICIAN' AND i.assigned_technician_id = :actorId))
      ORDER BY i.created_at DESC LIMIT 100`, { scope: actor?.role ?? Roles.ADMINISTRATOR, actorId: actor?.id ?? null });
    const candidate = { ...input, serviceId: Number(input.serviceId ?? input.service_id) || null, categoryId: Number(input.categoryId ?? input.category_id) || null };
    return active.map((incident) => ({ incident: this.summary(incident), ...this.duplicateDetector.compare(candidate, incident) }))
      .filter((entry) => entry.score >= 45 && entry.sharedKeywords.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  create(actor, input) {
    if (![Roles.EMPLOYEE, Roles.ADMINISTRATOR].includes(actor?.role)) throw new ForbiddenError('Only employees may report incidents');
    const title = requireText(input.title, 'Title', 5, 160);
    const description = requireText(input.description, 'Description', 12, 5000);
    const serviceId = toId(input.serviceId, 'Affected service');
    const service = this.db.get('SELECT * FROM it_services WHERE id=:id AND active=1', { id: serviceId });
    if (!service) throw new NotFoundError('Active IT service');
    const suggestion = this.categorySuggestion(description, title);
    const categoryId = input.categoryId ? toId(input.categoryId, 'Category') : suggestion.category?.id;
    const category = categoryId ? this.db.get('SELECT * FROM categories WHERE id=:id AND active=1', { id: categoryId }) : null;
    if (categoryId && !category) throw new NotFoundError('Active incident category');
    if (!category) throw new ValidationError('A category is required; no automatic category suggestion was available');
    const impact = Number(input.impact);
    const urgency = Number(input.urgency);
    const affectedUsers = toId(input.affectedUsers ?? 1, 'Affected users');
    const created = this.factory.create({ title, description, impact, urgency, affectedUsers }, service, this.incidents.nextSequence());
    const policy = this.db.get('SELECT * FROM sla_policies WHERE priority=:priority', { priority: created.priorityResult.priority });
    if (!policy) throw new ConflictError(`No SLA policy exists for ${created.priorityResult.priority}`);
    const technicians = this.users.technicians();
    const strategyKey = this.configuration('assignment_strategy', 'SKILL_BASED');
    const assignment = AssignmentStrategyFactory.create(strategyKey).assign({ technicians, categoryName: category.name, serviceName: service.name });
    const duplicateCandidates = this.duplicates({ title, description, serviceId, categoryId }, actor);
    const responseDeadline = addMinutes(created.createdAt, policy.response_minutes);
    const resolutionDeadline = addMinutes(created.createdAt, policy.resolution_minutes);
    let incidentId;
    this.db.transaction(() => {
      incidentId = this.incidents.insert('incidents', {
        incident_code: created.incidentCode, title: created.title, description: created.description,
        reporter_id: actor.id, category_id: category.id, service_id: service.id,
        impact, urgency, business_criticality: service.business_criticality, affected_users: affectedUsers,
        priority: created.priorityResult.priority, priority_score: created.priorityResult.score,
        priority_explanation: JSON.stringify(created.priorityResult),
        status: assignment.technician ? IncidentStatus.ASSIGNED : IncidentStatus.CLASSIFIED,
        assigned_technician_id: assignment.technician?.id ?? null, assignment_explanation: assignment.explanation,
        created_at: created.createdAt, updated_at: created.createdAt,
        response_minutes: policy.response_minutes, resolution_minutes: policy.resolution_minutes,
        response_deadline: responseDeadline, resolution_deadline: resolutionDeadline,
      });
      this.audit.record({ incidentId, actor, action: 'INCIDENT_CREATED', description: `${created.incidentCode} was reported.`, newValue: IncidentStatus.NEW });
      this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'CATEGORY_CLASSIFIED', description: suggestion.explanation, newValue: category.name, metadata: { suggestion } });
      this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'LIFECYCLE_AUTO_CLASSIFIED', oldValue: IncidentStatus.NEW, newValue: IncidentStatus.CLASSIFIED, description: 'The report was validated and classified by the incident creation workflow.' });
      this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'PRIORITY_CALCULATED', description: created.priorityResult.explanation, newValue: created.priorityResult.priority, metadata: created.priorityResult });
      this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'SLA_SNAPSHOT_CREATED', description: `${created.priorityResult.priority} policy snapshots response target ${policy.response_minutes} minutes and resolution target ${policy.resolution_minutes} minutes.`, metadata: { responseDeadline, resolutionDeadline } });
      if (assignment.technician) {
        this.incidents.insert('incident_assignments', {
          incident_id: incidentId, technician_id: assignment.technician.id, assigned_by: null, strategy: strategyKey,
          reason: assignment.explanation, assigned_at: created.createdAt, active: 1,
        });
        this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'LIFECYCLE_AUTO_ASSIGNED', oldValue: IncidentStatus.CLASSIFIED, newValue: IncidentStatus.ASSIGNED, description: 'An eligible technician was selected by the configured assignment strategy.' });
        this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'TECHNICIAN_ASSIGNED', newValue: assignment.technician.name, description: assignment.explanation, metadata: { strategy: strategyKey } });
      } else {
        this.audit.record({ incidentId, actor: SYSTEM_ACTOR, action: 'ASSIGNMENT_DEFERRED', description: assignment.explanation });
      }
      const links = Array.isArray(input.relatedIncidentIds) ? input.relatedIncidentIds : input.relatedIncidentId ? [input.relatedIncidentId] : [];
      for (const relatedId of new Set(links.slice(0, 5).map(Number))) {
        const match = duplicateCandidates.find((entry) => entry.incident.id === relatedId);
        if (!match) continue;
        this.db.run(`INSERT OR IGNORE INTO incident_relationships (incident_id,related_incident_id,relation_type,similarity_score,created_at)
          VALUES (:incidentId,:relatedId,'POTENTIAL_DUPLICATE',:score,:createdAt)`, { incidentId, relatedId, score: match.score, createdAt: created.createdAt });
        this.audit.record({ incidentId, actor, action: 'INCIDENT_LINKED', newValue: match.incident.incidentCode, description: 'Reporter linked a potential duplicate.', metadata: { score: match.score } });
      }
    });
    const incident = this.hydrate(incidentId, actor, true);
    this.notify({
      recipients: [actor.id], incidentId, type: 'INCIDENT_CREATED', subject: `${incident.incidentCode} was created`,
      message: `Your incident "${incident.title}" was recorded with priority ${incident.priority}.`,
    });
    if (assignment.technician) {
      this.notify({ recipients: [assignment.technician.id], incidentId, type: 'INCIDENT_ASSIGNED', subject: `${incident.incidentCode} assigned to you`, message: assignment.explanation });
    } else {
      this.notify({ recipients: this.admins(), incidentId, type: 'UNASSIGNED_INCIDENT', subject: `${incident.incidentCode} needs assignment`, message: assignment.explanation });
    }
    return { incident: this.hydrate(incidentId, actor, true), duplicates: duplicateCandidates, categorySuggestion: suggestion };
  }

  configuration(key, fallback = null) {
    return this.db.value('SELECT config_value FROM system_configuration WHERE config_key=:key', { key }) ?? fallback;
  }

  slaStatus(incident, now = this.clock()) {
    if (incident.response_breached || incident.resolution_breached) return 'BREACHED';
    if (incident.resolved_at) return 'MET';
    const pendingRisk = ['response', 'resolution'].some((kind) => {
      const target = this.riskPredictor.target(incident, kind, now);
      return !target.completedAt && (target.approaching || target.overdue);
    });
    if (pendingRisk) return 'AT_RISK';
    return 'ON_TRACK';
  }

  summary(row, now = this.clock()) {
    const risk = this.riskPredictor.assess(row, now);
    return {
      id: row.id, incidentCode: row.incident_code, title: row.title, description: row.description,
      status: row.status, priority: row.priority, priorityScore: row.priority_score,
      impact: row.impact, urgency: row.urgency, businessCriticality: row.business_criticality, affectedUsers: row.affected_users,
      createdAt: row.created_at, updatedAt: row.updated_at, category: row.category_name ? { id: row.category_id, name: row.category_name } : null,
      service: row.service_name ? { id: row.service_id, name: row.service_name, businessCriticality: row.business_criticality } : null,
      reporter: row.reporter_name ? { id: row.reporter_id, name: row.reporter_name, email: row.reporter_email } : null,
      assignedTechnician: row.technician_name ? { id: row.assigned_technician_id, name: row.technician_name, email: row.technician_email } : null,
      sla: {
        responseDeadline: row.response_deadline, resolutionDeadline: row.resolution_deadline,
        responseMinutes: row.response_minutes, resolutionMinutes: row.resolution_minutes,
        responseBreached: Boolean(row.response_breached), resolutionBreached: Boolean(row.resolution_breached),
        status: this.slaStatus(row, now), risk,
      },
    };
  }

  baseIncidentQuery(where = '', params = {}) {
    return this.db.all(`SELECT i.*, c.name AS category_name, s.name AS service_name,
        reporter.name AS reporter_name, reporter.email AS reporter_email,
        tech.name AS technician_name, tech.email AS technician_email
      FROM incidents i
      LEFT JOIN categories c ON c.id=i.category_id
      JOIN it_services s ON s.id=i.service_id
      JOIN users reporter ON reporter.id=i.reporter_id
      LEFT JOIN users tech ON tech.id=i.assigned_technician_id
      ${where} ORDER BY CASE i.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, i.created_at DESC`, params);
  }

  list(actor, filters = {}) {
    const conditions = [];
    const params = {};
    if (actor.role === Roles.EMPLOYEE) { conditions.push('i.reporter_id=:actorId'); params.actorId = actor.id; }
    if (actor.role === Roles.TECHNICIAN) { conditions.push('i.assigned_technician_id=:actorId'); params.actorId = actor.id; }
    if (filters.id) { conditions.push('(i.incident_code LIKE :code OR CAST(i.id AS TEXT)=:id)'); params.code = `%${filters.id}%`; params.id = String(filters.id); }
    if (filters.q) { conditions.push('(LOWER(i.title) LIKE :q OR LOWER(i.description) LIKE :q OR LOWER(i.incident_code) LIKE :q)'); params.q = `%${String(filters.q).toLowerCase()}%`; }
    for (const [filter, column] of [['status','i.status'], ['priority','i.priority'], ['category','i.category_id'], ['service','i.service_id'], ['technician','i.assigned_technician_id'], ['reporter','i.reporter_id']]) {
      if (filters[filter]) { conditions.push(`${column}=:${filter}`); params[filter] = filters[filter]; }
    }
    const { from, to } = utcDateBounds(filters);
    if (from) { conditions.push('i.created_at >= :from'); params.from = from; }
    if (to) { conditions.push('i.created_at <= :to'); params.to = to; }
    if (filters.slaStatus === 'BREACHED') conditions.push('(i.response_breached=1 OR i.resolution_breached=1)');
    if (filters.slaStatus === 'UNASSIGNED') conditions.push('i.assigned_technician_id IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const raw = this.baseIncidentQuery(where, params).map((row) => this.summary(row));
    const filtered = filters.slaStatus && !['BREACHED','UNASSIGNED'].includes(filters.slaStatus) ? raw.filter((incident) => incident.sla.status === filters.slaStatus) : raw;
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  hydrate(id, actor = null, skipAuthorisation = false) {
    const row = this.db.get(`SELECT i.*, c.name AS category_name, s.name AS service_name,
      reporter.name AS reporter_name, reporter.email AS reporter_email, tech.name AS technician_name, tech.email AS technician_email
      FROM incidents i LEFT JOIN categories c ON c.id=i.category_id JOIN it_services s ON s.id=i.service_id
      JOIN users reporter ON reporter.id=i.reporter_id LEFT JOIN users tech ON tech.id=i.assigned_technician_id
      WHERE i.id=:id OR i.incident_code=:id`, { id: String(id) });
    if (!row) throw new NotFoundError('Incident');
    if (actor && !skipAuthorisation) this.assertCanView(actor, row);
    const now = this.clock();
    const incident = this.summary(row, now);
    incident.sla.evaluatedAt = now.toISOString();
    const priorityExplanation = parseJson(row.priority_explanation, {});
    const assignments = this.db.all(`SELECT ia.*, u.name AS technician_name, u.email AS technician_email, by_user.name AS assigned_by_name
      FROM incident_assignments ia LEFT JOIN users u ON u.id=ia.technician_id LEFT JOIN users by_user ON by_user.id=ia.assigned_by
      WHERE ia.incident_id=:id ORDER BY ia.assigned_at DESC`, { id: row.id }).map((assignment) => ({
        id: assignment.id, strategy: assignment.strategy, reason: assignment.reason, assignedAt: assignment.assigned_at, active: Boolean(assignment.active),
        technician: assignment.technician_id ? { id: assignment.technician_id, name: assignment.technician_name, email: assignment.technician_email } : null,
        assignedBy: assignment.assigned_by ? assignment.assigned_by_name : 'System',
      }));
    incident.priorityExplanation = priorityExplanation;
    incident.assignmentExplanation = row.assignment_explanation;
    incident.assignments = assignments;
    incident.acknowledgedAt = row.acknowledged_at;
    incident.investigationStartedAt = row.investigation_started_at;
    incident.resolution = row.resolution_description ? { description: row.resolution_description, resolvedAt: row.resolved_at } : null;
    incident.verification = row.verified_at ? { note: row.verification_note, verifiedAt: row.verified_at } : null;
    incident.closedAt = row.closed_at;
    incident.notes = this.db.all(`SELECT n.*, u.name AS author_name, u.role AS author_role FROM investigation_notes n JOIN users u ON u.id=n.author_id WHERE n.incident_id=:id ORDER BY n.created_at`, { id: row.id }).map((note) => ({ id: note.id, note: note.note, createdAt: note.created_at, author: { id: note.author_id, name: note.author_name, role: note.author_role } }));
    incident.comments = this.db.all(`SELECT c.*, u.name AS author_name, u.role AS author_role FROM incident_comments c JOIN users u ON u.id=c.author_id WHERE c.incident_id=:id ORDER BY c.created_at`, { id: row.id }).map((comment) => ({ id: comment.id, message: comment.message, kind: comment.kind, createdAt: comment.created_at, author: { id: comment.author_id, name: comment.author_name, role: comment.author_role } }));
    incident.audit = this.db.all(`SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.incident_id=:id ORDER BY a.created_at`, { id: row.id }).map((audit) => ({ id: audit.id, action: audit.action_type, oldValue: audit.old_value, newValue: audit.new_value, description: audit.description, createdAt: audit.created_at, actor: { id: audit.actor_id, name: audit.actor_name ?? 'AEGIS system', role: audit.actor_role }, metadata: parseJson(audit.metadata, {}) }));
    incident.related = this.related(row.id).filter((link) => {
      const linked = this.incidents.byId(link.id);
      return !actor || this.isAdmin(actor) || this.isReporter(actor, linked) || this.isAssignee(actor, linked);
    });
    const feedback = this.db.get('SELECT f.*,u.name AS reporter_name FROM feedback f JOIN users u ON u.id=f.reporter_id WHERE f.incident_id=:id', { id: row.id });
    incident.feedback = feedback ? { rating: feedback.rating, comment: feedback.comment, createdAt: feedback.created_at, reporter: feedback.reporter_name } : null;
    incident.escalations = this.db.all('SELECT * FROM escalations WHERE incident_id=:id ORDER BY escalation_level', { id: row.id }).map((entry) => ({ level: entry.escalation_level, reason: entry.reason, destination: entry.destination, createdAt: entry.created_at }));
    return incident;
  }

  related(incidentId) {
    return this.db.all(`SELECT r.*, i.incident_code, i.title, i.status, i.priority FROM incident_relationships r
      JOIN incidents i ON i.id=r.related_incident_id WHERE r.incident_id=:id
      UNION ALL SELECT r.*, i.incident_code, i.title, i.status, i.priority FROM incident_relationships r
      JOIN incidents i ON i.id=r.incident_id WHERE r.related_incident_id=:id`, { id: incidentId }).map((row) => ({
        id: row.related_incident_id === Number(incidentId) ? row.incident_id : row.related_incident_id,
        incidentCode: row.incident_code, title: row.title, status: row.status, priority: row.priority,
        relationType: row.relation_type, similarityScore: row.similarity_score,
      }));
  }

  get(actor, id) { return this.hydrate(id, actor); }

  patch(actor, id, input) {
    assertRole(actor, Roles.ADMINISTRATOR);
    const current = this.incidents.byId(id);
    if (!current) throw new NotFoundError('Incident');
    if (current.status === IncidentStatus.CLOSED) throw new ConflictError('Closed incidents cannot be changed');
    const service = input.serviceId ? this.db.get('SELECT * FROM it_services WHERE id=:id', { id: toId(input.serviceId, 'Service') }) : this.db.get('SELECT * FROM it_services WHERE id=:id', { id: current.service_id });
    if (!service?.active) throw new NotFoundError('Active IT service');
    const category = input.categoryId ? this.db.get('SELECT * FROM categories WHERE id=:id', { id: toId(input.categoryId, 'Category') }) : this.db.get('SELECT * FROM categories WHERE id=:id', { id: current.category_id });
    if (!category?.active) throw new NotFoundError('Active category');
    const impact = input.impact === undefined ? current.impact : Number(input.impact);
    const urgency = input.urgency === undefined ? current.urgency : Number(input.urgency);
    const affectedUsers = input.affectedUsers === undefined ? current.affected_users : Number(input.affectedUsers);
    const calculated = this.priorityCalculator.calculate({ impact, urgency, businessCriticality: service.business_criticality, affectedUsers, serviceName: service.name });
    const policy = this.db.get('SELECT * FROM sla_policies WHERE priority=:priority', { priority: calculated.priority });
    const recomputeDeadlines = asBool(input.recalculateSla);
    const now = nowIso(this.clock);
    this.db.run(`UPDATE incidents SET service_id=:serviceId, category_id=:categoryId, impact=:impact, urgency=:urgency, business_criticality=:criticality,
      affected_users=:affectedUsers, priority=:priority, priority_score=:score, priority_explanation=:explanation,
      response_minutes=:responseMinutes, resolution_minutes=:resolutionMinutes,
      response_deadline=:responseDeadline, resolution_deadline=:resolutionDeadline, updated_at=:now, version=version+1 WHERE id=:id`, {
      id: current.id, serviceId: service.id, categoryId: category.id, impact, urgency, criticality: service.business_criticality, affectedUsers,
      priority: calculated.priority, score: calculated.score, explanation: JSON.stringify(calculated),
      responseMinutes: recomputeDeadlines ? policy.response_minutes : current.response_minutes,
      resolutionMinutes: recomputeDeadlines ? policy.resolution_minutes : current.resolution_minutes,
      responseDeadline: recomputeDeadlines ? addMinutes(current.created_at, policy.response_minutes) : current.response_deadline,
      resolutionDeadline: recomputeDeadlines ? addMinutes(current.created_at, policy.resolution_minutes) : current.resolution_deadline,
      now,
    });
    this.audit.record({ incidentId: current.id, actor, action: 'PRIORITY_RECALCULATED', oldValue: current.priority, newValue: calculated.priority, description: calculated.explanation, metadata: { recalculatedSla: recomputeDeadlines } });
    this.notify({ recipients: [current.reporter_id, current.assigned_technician_id].filter(Boolean), incidentId: current.id, type: 'PRIORITY_CHANGED', subject: `${current.incident_code} priority updated`, message: calculated.explanation });
    return this.hydrate(current.id, actor, true);
  }

  assign(actor, id, input) {
    assertRole(actor, Roles.ADMINISTRATOR);
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    if (closedStatuses.includes(incident.status)) throw new ConflictError('Resolved or closed incidents cannot be reassigned');
    const technicianId = toId(input.technicianId, 'Technician');
    const technicians = this.users.technicians();
    const technician = technicians.find((candidate) => Number(candidate.id) === technicianId);
    if (!technician || !technician.active || !technician.available) throw new ConflictError('Technician is unavailable');
    if (Number(technician.active_workload) >= Number(technician.capacity) && Number(incident.assigned_technician_id) !== technicianId) throw new ConflictError('Technician workload capacity has been reached');
    const reason = requireText(input.reason, 'Reassignment reason', 4, 1000);
    const now = nowIso(this.clock);
    this.db.transaction(() => {
      this.db.run('UPDATE incident_assignments SET active=0 WHERE incident_id=:incidentId', { incidentId: incident.id });
      this.incidents.insert('incident_assignments', { incident_id: incident.id, technician_id: technician.id, assigned_by: actor.id, strategy: 'MANUAL', reason, assigned_at: now, active: 1 });
      this.db.run('UPDATE incidents SET assigned_technician_id=:technicianId, assignment_explanation=:reason, status=:status, updated_at=:now, version=version+1 WHERE id=:id', {
        id: incident.id, technicianId, reason: `Manually assigned to ${technician.name}: ${reason}`, status: incident.status === IncidentStatus.CLASSIFIED ? IncidentStatus.ASSIGNED : incident.status, now,
      });
      this.audit.record({ incidentId: incident.id, actor, action: 'TECHNICIAN_REASSIGNED', oldValue: incident.assigned_technician_id, newValue: technician.id, description: reason });
    });
    this.notify({ recipients: [technician.id], incidentId: incident.id, type: 'INCIDENT_ASSIGNED', subject: `${incident.incident_code} assigned to you`, message: reason });
    return this.hydrate(incident.id, actor, true);
  }

  acknowledge(actor, id) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertTechnicianAssignee(actor, incident);
    const acknowledgedAt = nowIso(this.clock);
    return this.db.transaction(() => {
      const changed = this.recordTransition(incident, actor, IncidentStatus.ACKNOWLEDGED, 'TECHNICIAN_ACKNOWLEDGED', `${actor.name} acknowledged assignment.`, { acknowledged_at: acknowledgedAt });
      if (Date.parse(acknowledgedAt) > Date.parse(changed.response_deadline)) {
        this.recordBreach(changed, 'RESPONSE', actor);
      }
      this.notify({ recipients: [changed.reporter_id], incidentId: changed.id, type: 'INCIDENT_ACKNOWLEDGED', subject: `${changed.incident_code} acknowledged`, message: `${actor.name} has acknowledged your incident and will investigate it.` });
      return this.hydrate(changed.id, actor, true);
    });
  }

  startInvestigation(actor, id) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertTechnicianAssignee(actor, incident);
    const changed = this.recordTransition(incident, actor, IncidentStatus.IN_PROGRESS, 'INVESTIGATION_STARTED', `${actor.name} began investigating the incident.`, { investigation_started_at: nowIso(this.clock) });
    return this.hydrate(changed.id, actor, true);
  }

  addNote(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertTechnicianAssignee(actor, incident);
    if (closedStatuses.includes(incident.status)) throw new ConflictError('Notes cannot be added after resolution');
    const note = requireText(input.note, 'Investigation note', 3, 3000);
    this.incidents.insert('investigation_notes', { incident_id: incident.id, author_id: actor.id, note, created_at: nowIso(this.clock) });
    this.audit.record({ incidentId: incident.id, actor, action: 'INVESTIGATION_NOTE_ADDED', description: 'A technician investigation note was added.' });
    return this.hydrate(incident.id, actor, true);
  }

  requestInformation(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertTechnicianAssignee(actor, incident);
    const message = requireText(input.message, 'Information request', 5, 3000);
    const changed = this.recordTransition(incident, actor, IncidentStatus.WAITING_FOR_INFORMATION, 'INFORMATION_REQUESTED', `${actor.name} requested additional information.`, {});
    this.incidents.insert('incident_comments', { incident_id: changed.id, author_id: actor.id, message, kind: 'REQUEST_INFORMATION', created_at: nowIso(this.clock) });
    this.notify({ recipients: [changed.reporter_id], incidentId: changed.id, type: 'INFORMATION_REQUESTED', subject: `More information needed for ${changed.incident_code}`, message });
    return this.hydrate(changed.id, actor, true);
  }

  reply(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertReporter(actor, incident);
    const message = requireText(input.message, 'Reply', 2, 3000);
    const changed = this.recordTransition(incident, actor, IncidentStatus.IN_PROGRESS, 'REPORTER_REPLIED', `${actor.name} supplied requested information.`, {});
    this.incidents.insert('incident_comments', { incident_id: changed.id, author_id: actor.id, message, kind: 'REPORTER_REPLY', created_at: nowIso(this.clock) });
    if (changed.assigned_technician_id) this.notify({ recipients: [changed.assigned_technician_id], incidentId: changed.id, type: 'REPORTER_REPLIED', subject: `New information on ${changed.incident_code}`, message });
    return this.hydrate(changed.id, actor, true);
  }

  comment(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertCanView(actor, incident);
    if (incident.status === IncidentStatus.CLOSED) throw new ConflictError('Closed incidents cannot be changed');
    const message = requireText(input.message, 'Comment', 2, 3000);
    this.incidents.insert('incident_comments', { incident_id: incident.id, author_id: actor.id, message, kind: 'COMMENT', created_at: nowIso(this.clock) });
    this.audit.record({ incidentId: incident.id, actor, action: 'COMMENT_ADDED', description: `${actor.name} added a comment.` });
    const recipients = [incident.reporter_id, incident.assigned_technician_id].filter((recipientId) => recipientId && Number(recipientId) !== Number(actor.id));
    if (recipients.length) this.notify({ recipients, incidentId: incident.id, type: 'INCIDENT_COMMENT', subject: `New comment on ${incident.incident_code}`, message });
    return this.hydrate(incident.id, actor, true);
  }

  resolve(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertTechnicianAssignee(actor, incident);
    const resolution = requireText(input.resolution, 'Resolution', 10, 5000);
    const changed = this.recordTransition(incident, actor, IncidentStatus.RESOLVED, 'RESOLUTION_SUBMITTED', `${actor.name} submitted a resolution.`, { resolution_description: resolution, resolved_at: nowIso(this.clock) });
    this.recordHistoricalBreach(changed, actor);
    this.notify({ recipients: [changed.reporter_id], incidentId: changed.id, type: 'INCIDENT_RESOLVED', subject: `${changed.incident_code} awaits your verification`, message: resolution });
    return this.hydrate(changed.id, actor, true);
  }

  verify(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    const adminReporter = this.isAdmin(actor) && Number(actor.id) === Number(incident.reporter_id);
    if (!adminReporter && !this.isReporter(actor, incident)) {
      throw new ForbiddenError('Only the original reporter can verify the resolution');
    }
    const note = String(input.note ?? 'Reporter verified the proposed resolution.').trim().slice(0, 3000);
    const changed = this.recordTransition(incident, actor, IncidentStatus.VERIFIED, 'RESOLUTION_VERIFIED', `${actor.name} verified the resolution.`, { verification_note: note, verified_at: nowIso(this.clock) });
    if (changed.assigned_technician_id) this.notify({ recipients: [changed.assigned_technician_id], incidentId: changed.id, type: 'INCIDENT_VERIFIED', subject: `${changed.incident_code} was verified`, message: note });
    return this.hydrate(changed.id, actor, true);
  }

  rejectResolution(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertReporter(actor, incident);
    if (incident.status !== IncidentStatus.RESOLVED) throw new LifecycleError(incident.status, IncidentStatus.IN_PROGRESS);
    const message = requireText(input.message, 'Rejection reason', 5, 3000);
    return this.db.transaction(() => {
      const changed = this.recordTransition(incident, actor, IncidentStatus.IN_PROGRESS, 'RESOLUTION_REJECTED', 'Reporter rejected the proposed resolution.', { resolution_description: null, resolved_at: null });
      this.incidents.insert('incident_comments', { incident_id: changed.id, author_id: actor.id, message, kind: 'RESOLUTION_REJECTED', created_at: nowIso(this.clock) });
      this.audit.record({ incidentId: changed.id, actor, action: 'RESOLUTION_ARCHIVED', description: 'Previous resolution retained in audit metadata.', metadata: { resolution: incident.resolution_description, resolvedAt: incident.resolved_at, reason: message } });
      this.notify({ recipients: [changed.assigned_technician_id], incidentId: changed.id, type: 'RESOLUTION_REJECTED', subject: `${changed.incident_code} needs further investigation`, message });
      return this.hydrate(changed.id, actor, true);
    });
  }

  close(actor, id) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    if (!this.isAdmin(actor)) this.assertReporter(actor, incident);
    const changed = this.recordTransition(incident, actor, IncidentStatus.CLOSED, 'INCIDENT_CLOSED', `${actor.name} closed the incident.`, { closed_at: nowIso(this.clock) });
    this.notify({ recipients: [changed.reporter_id, changed.assigned_technician_id].filter(Boolean), incidentId: changed.id, type: 'INCIDENT_CLOSED', subject: `${changed.incident_code} was closed`, message: 'The incident lifecycle is complete. Feedback is now available.' });
    return this.hydrate(changed.id, actor, true);
  }

  feedback(actor, id, input) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertReporter(actor, incident);
    if (incident.status !== IncidentStatus.CLOSED) throw new ConflictError('Feedback is available only after an incident is closed');
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ValidationError('Feedback rating must be 1 to 5');
    const comment = String(input.comment ?? '').trim().slice(0, 2000);
    if (this.db.get('SELECT id FROM feedback WHERE incident_id=:id', { id: incident.id })) throw new ConflictError('Feedback has already been submitted');
    this.incidents.insert('feedback', { incident_id: incident.id, reporter_id: actor.id, rating, comment, created_at: nowIso(this.clock) });
    this.audit.record({ incidentId: incident.id, actor, action: 'FEEDBACK_SUBMITTED', description: `Reporter submitted ${rating}/5 feedback.` });
    return this.hydrate(incident.id, actor, true);
  }

  recordHistoricalBreach(incident, actor = SYSTEM_ACTOR) {
    const resolvedAt = new Date(incident.resolved_at ?? this.clock());
    if (resolvedAt.getTime() > new Date(incident.resolution_deadline).getTime()) this.recordBreach(incident, 'RESOLUTION', actor);
  }

  recordBreach(incident, type, actor = SYSTEM_ACTOR) {
    const flag = type === 'RESPONSE' ? 'response_breached' : 'resolution_breached';
    if (incident[flag]) return false;
    const now = nowIso(this.clock);
    this.db.run(`UPDATE incidents SET ${flag}=1, updated_at=:now WHERE id=:id`, { id: incident.id, now });
    this.db.run('INSERT OR IGNORE INTO sla_breaches (incident_id,breach_type,detected_at) VALUES (:incidentId,:type,:detectedAt)', { incidentId: incident.id, type, detectedAt: now });
    this.audit.record({ incidentId: incident.id, actor, action: 'SLA_VIOLATION_DETECTED', description: `${type} SLA target was breached.`, newValue: type });
    this.notify({ recipients: [incident.reporter_id, incident.assigned_technician_id, ...this.admins()].filter(Boolean), incidentId: incident.id, type: 'SLA_BREACH', subject: `${incident.incident_code} breached ${type.toLowerCase()} SLA`, message: `${type} SLA violation was recorded for ${incident.incident_code}.` });
    this.escalate(incident, 2, `${type} SLA violation`, 'Administrator / IT manager', actor);
    return true;
  }

  escalate(incident, level, reason, destination, actor = SYSTEM_ACTOR) {
    const existing = this.db.get('SELECT id FROM escalations WHERE incident_id=:incidentId AND escalation_level=:level', { incidentId: incident.id, level });
    if (existing) return false;
    const now = nowIso(this.clock);
    this.incidents.insert('escalations', { incident_id: incident.id, escalation_level: level, reason, destination, created_at: now });
    this.db.run('UPDATE incidents SET escalation_level=MAX(escalation_level,:level), updated_at=:now WHERE id=:id', { id: incident.id, level, now });
    this.audit.record({ incidentId: incident.id, actor, action: 'ESCALATION_TRIGGERED', newValue: level, description: `${reason}; escalated to ${destination}.` });
    this.notify({ recipients: this.admins(), incidentId: incident.id, type: 'ESCALATION', subject: `${incident.incident_code} escalated`, message: `${reason}. Destination: ${destination}.` });
    return true;
  }

  monitorSla() {
    const now = this.clock();
    const rows = this.db.all(`SELECT * FROM incidents WHERE status NOT IN ('CLOSED') ORDER BY id`);
    const outcomes = { scanned: rows.length, warnings: 0, breaches: 0, escalations: 0 };
    for (const incident of rows) {
      const response = this.riskPredictor.target(incident, 'response', now);
      const resolution = this.riskPredictor.target(incident, 'resolution', now);
      if (response.approaching && response.remaining > 0 && !incident.response_warning_sent) {
        this.db.run('UPDATE incidents SET response_warning_sent=1 WHERE id=:id', { id: incident.id });
        this.audit.record({ incidentId: incident.id, action: 'SLA_WARNING_GENERATED', description: 'Response SLA is approaching.' });
        this.notify({ recipients: [incident.assigned_technician_id, ...this.admins()].filter(Boolean), incidentId: incident.id, type: 'SLA_WARNING', subject: `${incident.incident_code} response SLA at risk`, message: 'The response deadline is approaching.' });
        outcomes.warnings += 1;
      }
      if (resolution.approaching && resolution.remaining > 0 && !incident.resolution_warning_sent && ACTIVE_STATUSES.includes(incident.status)) {
        this.db.run('UPDATE incidents SET resolution_warning_sent=1 WHERE id=:id', { id: incident.id });
        this.audit.record({ incidentId: incident.id, action: 'SLA_WARNING_GENERATED', description: 'Resolution SLA is approaching.' });
        this.notify({ recipients: [incident.assigned_technician_id, ...this.admins()].filter(Boolean), incidentId: incident.id, type: 'SLA_WARNING', subject: `${incident.incident_code} resolution SLA at risk`, message: 'The resolution deadline is approaching.' });
        outcomes.warnings += 1;
      }
      if (!response.completedAt && response.overdue && this.recordBreach(incident, 'RESPONSE')) outcomes.breaches += 1;
      if (resolution.overdue && this.recordBreach(incident, 'RESOLUTION')) outcomes.breaches += 1;
      const risk = this.riskPredictor.assess(incident, now);
      if (risk.level === 'HIGH' && incident.priority === 'P1' && !incident.acknowledged_at && this.escalate(incident, 1, risk.explanation, 'Support team lead')) outcomes.escalations += 1;
    }
    return outcomes;
  }

  recommendations(actor, id) {
    const incident = this.incidents.byId(id);
    if (!incident) throw new NotFoundError('Incident');
    this.assertCanView(actor, incident);
    if (actor.role === Roles.EMPLOYEE) return { incident: incident.incident_code, recommendations: [], guidance: null };
    const past = this.incidents.historicalFixes(incident.id, this.isAdmin(actor) ? null : actor.id);
    const recommendations = this.fixMatcher.rank(incident, past);
    const guidance = recommendations.length ? null : this.fixMatcher.guidance({
      ...incident, category_name: this.db.get('SELECT name FROM categories WHERE id=:id', { id: incident.category_id })?.name,
    });
    return { incident: incident.incident_code, recommendations, guidance };
  }

  rescueQueue(actor) {
    assertRole(actor, Roles.ADMINISTRATOR);
    const now = this.clock();
    const reminders = new Set(this.incidents.rescueReminders()
      .map((row) => reminderKey(row.incident_id, row.target, row.technician_id)));
    const items = this.incidents.activeForRescue().map((incident) => {
      const { risk, deadline, reason } = this.riskPredictor.rescue(incident, now);
      const technician = incident.assigned_technician_id
        ? { id: incident.assigned_technician_id, name: incident.technician_name }
        : null;
      const reminderSent = reminders.has(reminderKey(incident.id, deadline.kind, technician?.id));
      let suggestedAction = 'Review progress at the next update.';
      if (risk !== 'ON_TRACK') {
        if (!incident.technician_active) suggestedAction = 'Review availability and assign a qualified technician from the incident.';
        else if (risk === 'OVERDUE' && incident.escalation_level < 2) suggestedAction = 'Run the SLA monitor to record the breach and escalate. Contact the assigned technician for an update.';
        else if (incident.escalation_level >= 2 && ['OVERDUE', 'BREACHED'].includes(risk)) suggestedAction = 'Review the existing escalation and agree on the next update with the assigned technician.';
        else if (!incident.acknowledged_at) suggestedAction = 'Ask the assigned technician to acknowledge the incident.';
        else if (incident.status === IncidentStatus.WAITING_FOR_INFORMATION) suggestedAction = 'Check whether the reporter has replied and ask the technician what is blocking progress.';
        else suggestedAction = 'Check investigation progress and ask the technician for a recovery update.';
      }
      return {
        id: incident.id, incidentCode: incident.incident_code, title: incident.title, priority: incident.priority,
        assignedTechnician: technician, deadline: deadline.deadline, deadlineKind: deadline.kind,
        risk, reason, suggestedAction, reminderSent,
        canRemind: risk !== 'ON_TRACK' && Boolean(incident.technician_active) && !reminderSent,
      };
    });
    items.sort((a, b) => rescueOrder.indexOf(a.risk) - rescueOrder.indexOf(b.risk)
      || a.priority.localeCompare(b.priority) || a.deadline.localeCompare(b.deadline) || a.id - b.id);
    return { evaluatedAt: now.toISOString(), items };
  }

  remindForRescue(actor, id, input) {
    assertRole(actor, Roles.ADMINISTRATOR);
    const { target, technicianId } = input ?? {};
    return this.db.transaction(() => {
      const incident = this.incidents.byId(id);
      if (!incident) throw new NotFoundError('Incident');
      if (!ACTIVE_STATUSES.includes(incident.status)) throw new ConflictError('Rescue reminders require an active incident');
      const assigned = this.users.byId(incident.assigned_technician_id);
      const { risk, deadline } = this.riskPredictor.rescue(incident, this.clock());
      if (risk === 'ON_TRACK' || !assigned?.active || assigned.role !== Roles.TECHNICIAN) {
        throw new ConflictError('There is no assigned technician to remind for a current SLA risk');
      }
      if (target !== deadline.kind || technicianId !== assigned.id) {
        throw new ConflictError('The SLA target or assigned technician changed. Refresh the rescue queue.');
      }
      if (this.incidents.rescueReminders(incident.id).some((row) => row.target === target)) {
        return { sent: false };
      }
      this.audit.record({ incidentId: incident.id, actor, action: 'SLA_RESCUE_REMINDER',
        description: `Requested a ${target} SLA update from the assigned technician.`,
        metadata: { target, technicianId: assigned.id } });
      this.notify({ recipients: [assigned.id], incidentId: incident.id, type: 'SLA_RESCUE_REMINDER',
        subject: `${incident.incident_code} needs an SLA update`,
        message: `An administrator requested a ${target} SLA update. Review the incident and confirm the next step.` });
      return { sent: true };
    });
  }
}

export class AdminService {
  constructor({ database, users, incidents, audit, incidentService, auth, clock = () => new Date() }) {
    this.db = database; this.users = users; this.incidents = incidents; this.audit = audit; this.incidentService = incidentService; this.auth = auth; this.clock = clock;
  }
  guard(actor) { assertRole(actor, Roles.ADMINISTRATOR); }

  usersList(actor) { this.guard(actor); return this.users.list().map((user) => ({ ...toPublicUser(user), activeWorkload: Number(this.incidents.activeWorkload(user.id)) })); }
  technicians(actor) { this.guard(actor); return this.users.technicians().map((user) => ({ ...toPublicUser(user), activeWorkload: Number(user.active_workload) })); }
  createUser(actor, input) { this.guard(actor); return this.auth.createUser(input, actor); }
  updateUser(actor, id, input) {
    this.guard(actor);
    const user = this.users.byId(toId(id, 'User'));
    if (!user) throw new NotFoundError('User');
    const name = input.name === undefined ? user.name : requireText(input.name, 'Name', 2, 100);
    const active = input.active === undefined ? user.active : asBool(input.active) ? 1 : 0;
    const available = input.available === undefined ? user.available : asBool(input.available) ? 1 : 0;
    const skills = input.skills === undefined ? parseJson(user.skills, []) : (Array.isArray(input.skills) ? input.skills.map((skill) => String(skill).trim()).filter(Boolean).slice(0,20) : []);
    const capacity = input.capacity === undefined ? user.capacity : Number(input.capacity);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 99) throw new ValidationError('Capacity must be from 0 to 99');
    this.db.run('UPDATE users SET name=:name,active=:active,available=:available,skills=:skills,capacity=:capacity WHERE id=:id', { id: user.id, name, active, available, skills: JSON.stringify(skills), capacity });
    this.audit.record({ actor, action: 'USER_UPDATED', description: `Administrator updated ${user.email}.`, metadata: { userId: user.id } });
    return toPublicUser(this.users.byId(user.id));
  }

  services(actor) { this.guard(actor); return this.db.all('SELECT * FROM it_services ORDER BY active DESC,name').map((row) => ({ id: row.id, name: row.name, description: row.description, businessCriticality: row.business_criticality, active: Boolean(row.active), createdAt: row.created_at })); }
  upsertService(actor, id, input) {
    this.guard(actor);
    const name = requireText(input.name, 'Service name', 2, 120);
    const description = String(input.description ?? '').trim().slice(0, 1000);
    const criticality = Number(input.businessCriticality);
    if (!Number.isInteger(criticality) || criticality < 1 || criticality > 3) throw new ValidationError('Business criticality must be 1 to 3');
    const active = input.active === undefined ? 1 : asBool(input.active) ? 1 : 0;
    const conflictMessage = 'An IT service with that name already exists';
    if (id) {
      const existing = this.db.get('SELECT * FROM it_services WHERE id=:id', { id: toId(id,'Service') }); if (!existing) throw new NotFoundError('Service');
      writeWithUniqueName(() => this.db.run('UPDATE it_services SET name=:name,description=:description,business_criticality=:criticality,active=:active WHERE id=:id',
        { id: existing.id,name,description,criticality,active }), conflictMessage);
      this.audit.record({ actor, action:'SERVICE_UPDATED', description:`Service ${name} was updated.` }); return { id: existing.id,name,description,businessCriticality:criticality,active:Boolean(active) };
    }
    const serviceId = writeWithUniqueName(() => this.incidents.insert('it_services',
      { name,description,business_criticality:criticality,active,created_at:nowIso(this.clock) }), conflictMessage);
    this.audit.record({ actor,action:'SERVICE_CREATED',description:`Service ${name} was created.` }); return { id:serviceId,name,description,businessCriticality:criticality,active:Boolean(active) };
  }

  categories(actor) { this.guard(actor); return this.db.all('SELECT * FROM categories ORDER BY active DESC,name').map((row) => ({ id:row.id,name:row.name,keywords:parseJson(row.keywords,[]),active:Boolean(row.active),createdAt:row.created_at })); }
  upsertCategory(actor, id, input) {
    this.guard(actor);
    const name=requireText(input.name,'Category name',2,80); const keywords=Array.isArray(input.keywords)?input.keywords.map((keyword)=>String(keyword).trim().toLowerCase()).filter(Boolean).slice(0,30):[]; const active=input.active===undefined?1:asBool(input.active)?1:0;
    const conflictMessage = 'A category with that name already exists';
    if (id) {
      const existing = this.db.get('SELECT * FROM categories WHERE id=:id', { id: toId(id, 'Category') });
      if (!existing) throw new NotFoundError('Category');
      writeWithUniqueName(() => this.db.run('UPDATE categories SET name=:name,keywords=:keywords,active=:active WHERE id=:id',
        { id: existing.id, name, keywords: JSON.stringify(keywords), active }), conflictMessage);
      this.audit.record({ actor, action: 'CATEGORY_UPDATED', description: `Category ${name} was updated.` });
      return { id: existing.id, name, keywords, active: Boolean(active) };
    }
    const categoryId = writeWithUniqueName(() => this.incidents.insert('categories',
      { name, keywords: JSON.stringify(keywords), active, created_at: nowIso(this.clock) }), conflictMessage);
    this.audit.record({ actor, action: 'CATEGORY_CREATED', description: `Category ${name} was created.` });
    return { id: categoryId, name, keywords, active: Boolean(active) };
  }

  slaPolicies(actor) { this.guard(actor); return this.db.all("SELECT * FROM sla_policies ORDER BY priority").map((policy)=>({id:policy.id,priority:policy.priority,responseMinutes:policy.response_minutes,resolutionMinutes:policy.resolution_minutes,updatedAt:policy.updated_at})); }
  updatePolicy(actor, priority, input) {
    this.guard(actor); if(!Priorities.includes(priority)) throw new ValidationError('Unknown priority'); const responseMinutes=Number(input.responseMinutes);const resolutionMinutes=Number(input.resolutionMinutes); if(!Number.isInteger(responseMinutes)||responseMinutes<=0||!Number.isInteger(resolutionMinutes)||resolutionMinutes<=0)throw new ValidationError('SLA targets must be positive whole minutes');
    const now=nowIso(this.clock); this.db.run(`INSERT INTO sla_policies(priority,response_minutes,resolution_minutes,updated_at) VALUES (:priority,:responseMinutes,:resolutionMinutes,:now) ON CONFLICT(priority) DO UPDATE SET response_minutes=excluded.response_minutes,resolution_minutes=excluded.resolution_minutes,updated_at=excluded.updated_at`,{priority,responseMinutes,resolutionMinutes,now});this.audit.record({actor,action:'SLA_POLICY_UPDATED',description:`${priority} SLA policy changed to ${responseMinutes}/${resolutionMinutes} minutes.`});return {priority,responseMinutes,resolutionMinutes,updatedAt:now};
  }

  assignmentStrategy(actor) { this.guard(actor); const key=this.incidentService.configuration('assignment_strategy','SKILL_BASED');return {current:key,available:[{key:'SKILL_BASED',name:'Skill-based intelligent assignment'},{key:'LEAST_LOADED',name:'Least-loaded assignment'}]}; }
  updateAssignmentStrategy(actor,input) { this.guard(actor); const key=String(input.strategy??'');if(!['SKILL_BASED','LEAST_LOADED'].includes(key))throw new ValidationError('Unknown assignment strategy');const now=nowIso(this.clock);this.db.run(`INSERT INTO system_configuration(config_key,config_value,updated_at) VALUES ('assignment_strategy',:key,:now) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value,updated_at=excluded.updated_at`,{key,now});this.audit.record({actor,action:'ASSIGNMENT_STRATEGY_CHANGED',description:`Assignment strategy changed to ${key}.`});return this.assignmentStrategy(actor); }

  dependencies(actor) { this.guard(actor); return this.db.all(`SELECT d.*,a.name AS service_name,b.name AS depends_on_name FROM service_dependencies d JOIN it_services a ON a.id=d.service_id JOIN it_services b ON b.id=d.depends_on_service_id ORDER BY a.name,b.name`).map((row)=>({id:row.id,service:{id:row.service_id,name:row.service_name},dependsOn:{id:row.depends_on_service_id,name:row.depends_on_name},createdAt:row.created_at})); }
  addDependency(actor,input) { this.guard(actor);const serviceId=toId(input.serviceId,'Service');const dependsOnServiceId=toId(input.dependsOnServiceId,'Dependent service');if(serviceId===dependsOnServiceId)throw new ValidationError('A service cannot depend on itself');if(!this.db.get('SELECT id FROM it_services WHERE id=:id',{id:serviceId})||!this.db.get('SELECT id FROM it_services WHERE id=:id',{id:dependsOnServiceId}))throw new NotFoundError('Service');
    const cycle=this.db.get(`WITH RECURSIVE graph(id) AS (SELECT depends_on_service_id FROM service_dependencies WHERE service_id=:start UNION SELECT d.depends_on_service_id FROM service_dependencies d JOIN graph g ON d.service_id=g.id) SELECT id FROM graph WHERE id=:target LIMIT 1`,{start:dependsOnServiceId,target:serviceId});if(cycle)throw new ConflictError('This dependency would create a cycle');const id=this.incidents.insert('service_dependencies',{service_id:serviceId,depends_on_service_id:dependsOnServiceId,created_at:nowIso(this.clock)});this.audit.record({actor,action:'SERVICE_DEPENDENCY_CREATED',description:`Service dependency ${serviceId} -> ${dependsOnServiceId} added.`});return {id,serviceId,dependsOnServiceId}; }

  auditEvents(actor,filters={}) { this.guard(actor);const conditions=[];const params={};if(filters.incidentId){conditions.push('a.incident_id=:incidentId');params.incidentId=filters.incidentId;}if(filters.action){conditions.push('a.action_type=:action');params.action=filters.action;}const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';return this.db.all(`SELECT a.*,u.name AS actor_name,i.incident_code FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN incidents i ON i.id=a.incident_id ${where} ORDER BY a.created_at DESC LIMIT 500`,params).map((entry)=>({id:entry.id,incidentId:entry.incident_id,incidentCode:entry.incident_code,action:entry.action_type,description:entry.description,oldValue:entry.old_value,newValue:entry.new_value,createdAt:entry.created_at,actor:{id:entry.actor_id,name:entry.actor_name??'AEGIS system',role:entry.actor_role},metadata:parseJson(entry.metadata,{})})); }
  escalations(actor) { this.guard(actor);return this.db.all(`SELECT e.*,i.incident_code,i.title,i.priority,i.status FROM escalations e JOIN incidents i ON i.id=e.incident_id ORDER BY e.created_at DESC`).map((entry)=>({id:entry.id,incidentId:entry.incident_id,incidentCode:entry.incident_code,title:entry.title,priority:entry.priority,status:entry.status,level:entry.escalation_level,reason:entry.reason,destination:entry.destination,createdAt:entry.created_at})); }
  emailOutbox(actor) { this.guard(actor);return this.db.all(`SELECT e.*,i.incident_code FROM simulated_emails e LEFT JOIN incidents i ON i.id=e.incident_id ORDER BY e.created_at DESC LIMIT 500`).map((email)=>({id:email.id,recipient:email.recipient_email,incidentId:email.incident_id,incidentCode:email.incident_code,subject:email.subject,body:email.body,status:email.delivery_status,createdAt:email.created_at})); }

  servicePulse(actor) { this.guard(actor);const services=this.db.all(`SELECT s.*,COUNT(CASE WHEN i.status NOT IN ('RESOLVED','VERIFIED','CLOSED') THEN 1 END) AS active_incidents,COUNT(CASE WHEN i.priority='P1' AND i.status NOT IN ('RESOLVED','VERIFIED','CLOSED') THEN 1 END) AS critical_incidents FROM it_services s LEFT JOIN incidents i ON i.service_id=s.id GROUP BY s.id ORDER BY critical_incidents DESC,active_incidents DESC,s.name`);const dependencies=this.dependencies(actor);return {services:services.map((service)=>({id:service.id,name:service.name,businessCriticality:service.business_criticality,activeIncidents:Number(service.active_incidents),criticalIncidents:Number(service.critical_incidents),potentialImpact:dependencies.filter((dependency)=>dependency.dependsOn.id===service.id).map((dependency)=>dependency.service.name)})),dependencies}; }
}

export class ReportService {
  constructor({ database, users, clock = () => new Date() }) { this.db=database;this.users=users;this.clock=clock; }
  guard(actor) { if(!actor) throw new ForbiddenError(); }
  incidentScope(actor) {
    this.guard(actor);
    const clauses = [];
    const params = {};
    if (actor.role !== Roles.ADMINISTRATOR) {
      const owner = actor.role === Roles.EMPLOYEE ? 'reporter_id' : 'assigned_technician_id';
      clauses.push(`i.${owner} = :actorId`);
      params.actorId = actor.id;
    }
    return { clauses, params };
  }
  overview(actor, filters = {}) {
    const { clauses, params } = this.incidentScope(actor);
    if (filters.category) {
      clauses.push('i.category_id = :categoryId');
      params.categoryId = toId(filters.category, 'Category');
    }
    const { from, to } = utcDateBounds(filters);
    if (from) { clauses.push('i.created_at >= :from'); params.from = from; }
    if (to) { clauses.push('i.created_at <= :to'); params.to = to; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.all(`SELECT i.* FROM incidents i ${where}`, params);
    const active = rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
    const resolved = rows.filter((row) => row.resolved_at);
    const responded = rows.filter((row) => row.acknowledged_at);
    const violations = rows.filter((row) => row.response_breached || row.resolution_breached);
    const compliant = resolved.filter((row) => !row.response_breached && !row.resolution_breached);
    const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    const recentActivity = this.db.all(`SELECT a.*, i.incident_code FROM audit_events a
      LEFT JOIN incidents i ON i.id = a.incident_id ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 10`, params)
      .map((entry) => ({ action: entry.action_type, description: entry.description, incidentCode: entry.incident_code, createdAt: entry.created_at }));
    const days = new Map();
    for (const row of rows) {
      const day = row.created_at.slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
    return {
      totalIncidents: rows.length, activeIncidents: active.length,
      resolvedIncidents: resolved.length, closedIncidents: rows.filter((row) => row.status === IncidentStatus.CLOSED).length,
      criticalIncidents: active.filter((row) => row.priority === 'P1').length, slaViolations: violations.length,
      slaComplianceRate: resolved.length ? Math.round(compliant.length / resolved.length * 100) : null,
      averageResponseMinutes: average(responded.map((row) => minutesBetween(row.created_at, row.acknowledged_at))),
      averageResolutionMinutes: average(resolved.map((row) => minutesBetween(row.created_at, row.resolved_at))),
      byCategory: this.group(rows, 'category_id', 'categories', 'name'),
      byPriority: this.groupRows(rows, 'priority'),
      byStatus: this.groupRows(rows, 'status'),
      byService: this.group(rows, 'service_id', 'it_services', 'name'),
      trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value })),
      recentActivity,
    };
  }
  group(rows,key,table,label) { const names=new Map(this.db.all(`SELECT id,${label} AS label FROM ${table}`).map((row)=>[String(row.id),row.label]));const counts={};rows.forEach((row)=>{const name=names.get(String(row[key]))??'Unclassified';counts[name]=(counts[name]??0)+1;});return Object.entries(counts).map(([name,value])=>({name,value})); }
  groupRows(rows,key) { const counts={};rows.forEach((row)=>{counts[row[key]]=(counts[row[key]]??0)+1;});return Object.entries(counts).map(([name,value])=>({name,value})); }
  workload(actor) { if(actor.role===Roles.EMPLOYEE) throw new ForbiddenError('Workload reporting is restricted');return this.users.technicians().map((tech)=>({id:tech.id,name:tech.name,available:Boolean(tech.available),capacity:tech.capacity,activeWorkload:Number(tech.active_workload),utilisation:tech.capacity?Math.round(Number(tech.active_workload)/tech.capacity*100):0,skills:parseJson(tech.skills,[])})); }
  services(actor) { if(actor.role===Roles.EMPLOYEE) throw new ForbiddenError('Service reporting is restricted');return this.db.all(`SELECT s.id,s.name,COUNT(i.id) AS total,COUNT(CASE WHEN i.status NOT IN ('RESOLVED','VERIFIED','CLOSED') THEN 1 END) AS active,COUNT(CASE WHEN i.response_breached=1 OR i.resolution_breached=1 THEN 1 END) AS breaches FROM it_services s LEFT JOIN incidents i ON i.service_id=s.id GROUP BY s.id ORDER BY total DESC,s.name`).map((row)=>({id:row.id,name:row.name,total:Number(row.total),active:Number(row.active),breaches:Number(row.breaches)})); }
  trends(actor) {
    const { clauses, params } = this.incidentScope(actor);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all(`SELECT substr(i.created_at, 1, 10) AS date, COUNT(*) AS value
      FROM incidents i ${where} GROUP BY date ORDER BY date`, params).map(({ date, value }) => ({ date, value }));
  }
  csv(actor) { const report=this.overview(actor);const records=[['Metric','Value'],...Object.entries({Total:report.totalIncidents,Active:report.activeIncidents,Resolved:report.resolvedIncidents,Closed:report.closedIncidents,Critical:report.criticalIncidents,'SLA violations':report.slaViolations,'SLA compliance %':report.slaComplianceRate}).map(([name,value])=>[name,value])];return records.map((row)=>row.map((value)=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\n'); }
}

export function createServices({ database, clock = () => new Date() }) {
  const users=new UserRepository(database); const incidents=new IncidentRepository(database); const audit=new AuditService(database,clock);
  const publisher=new EventPublisher([new InAppNotificationChannel(database,users),new SimulatedEmailNotificationChannel(database,users)]);
  const auth=new AuthService(database,users,audit,clock);
  const incidentService=new IncidentService({database,users,incidents,audit,publisher,clock});
  const admin=new AdminService({database,users,incidents,audit,incidentService,auth,clock});
  const reports=new ReportService({database,users,clock});
  return { users,incidents,audit,publisher,auth,incidentService,admin,reports };
}

export function seedDemoIncidents({ database, services }) {
  if (Number(database.value('SELECT COUNT(*) FROM incidents')) > 0) return false;

  const reporter = toPublicUser(services.users.byEmail('employee@aegis.local'));
  if (!reporter?.active || reporter.role !== Roles.EMPLOYEE) throw new ConflictError('An active demo employee is required to seed incidents');
  const incidentService = services.incidentService;
  const examples = [
    {
      title: 'Payment application unavailable',
      description: 'Payment transactions are failing for students and staff. The payment application is unavailable.',
      service: 'Payment Application', category: 'Software/Application', impact: 3, urgency: 3, affectedUsers: 650,
      note: 'Confirmed that payment requests are timing out at the checkout worker. The status page and sign-in are reachable.',
      request: 'Please share the approximate time of a failed checkout and the error text. Leave out card and account details.',
    },
    {
      title: 'Campus Wi-Fi connectivity issue',
      description: 'Devices repeatedly disconnect from campus Wi-Fi in the second-floor library study area.',
      service: 'Campus Network', category: 'Network', impact: 2, urgency: 2, affectedUsers: 80,
    },
    {
      title: 'Student portal login failure',
      description: 'Students attempting to sign in to the Student Portal are sent back to the login page after completing MFA.',
      service: 'Student Portal', category: 'Authentication', impact: 2, urgency: 3, affectedUsers: 120,
      note: 'Reproduced the login loop with a test account. Reviewing the authentication callback and session logs.',
    },
    {
      title: 'Scheduled database backup failure',
      description: 'The nightly database backup failed after the backup volume ran out of space. The live database remains available.',
      service: 'Database Platform', category: 'Database', impact: 2, urgency: 2, affectedUsers: 2,
      note: 'Checked retention settings and confirmed earlier backup files are still readable.',
      resolution: 'Freed the backup volume, corrected the retention job, and verified a successful backup and test restore.',
    },
    {
      title: 'Campus network access issue',
      description: 'A staff workstation in the library can connect to the wired network but cannot reach internal campus services.',
      service: 'Campus Network', category: 'Network', impact: 1, urgency: 2, affectedUsers: 1,
      note: 'The affected wall port was configured for the guest network. A neighboring staff port worked normally.',
      resolution: 'Restored the correct network configuration on the wall port and confirmed access to internal campus services.',
      verification: 'The workstation can reach the staff portal and shared drives again.',
    },
    {
      title: 'Payment application software installation failure',
      description: 'Payment transactions failed at campus checkout workstations after a payment worker software update could not finish.',
      service: 'Payment Application', category: 'Software/Application', impact: 2, urgency: 2, affectedUsers: 14,
      note: 'Reproduced the failed installation on a test workstation and found an incomplete payment worker package.',
      resolution: 'Reinstalled the approved payment worker package, restarted the payment application, and verified successful checkout transactions.',
      verification: 'A test checkout completed successfully on the updated workstations.',
      feedback: 'Support confirmed the fix with a test transaction and kept us informed.',
    },
  ];

  for (const { service, category, note, request, resolution, verification, feedback, ...input } of examples) {
    const serviceId = database.value('SELECT id FROM it_services WHERE name=:name AND active=1', { name: service });
    const categoryId = database.value('SELECT id FROM categories WHERE name=:name AND active=1', { name: category });
    if (!serviceId || !categoryId) throw new ConflictError(`Missing active demo service or category for ${input.title}`);

    const { incident } = incidentService.create(reporter, { ...input, serviceId, categoryId });
    if (!incident.assignedTechnician) throw new ConflictError(`No eligible technician for ${incident.title}`);

    if (!note) continue;
    const technician = toPublicUser(services.users.byId(incident.assignedTechnician.id));
    incidentService.acknowledge(technician, incident.id);
    incidentService.startInvestigation(technician, incident.id);
    incidentService.addNote(technician, incident.id, { note });
    if (request) incidentService.requestInformation(technician, incident.id, { message: request });
    if (resolution) incidentService.resolve(technician, incident.id, { resolution });
    if (verification) incidentService.verify(reporter, incident.id, { note: verification });
    if (feedback) {
      incidentService.close(reporter, incident.id);
      incidentService.feedback(reporter, incident.id, { rating: 5, comment: feedback });
    }
  }
  return true;
}

/** Initial data remains realistic because active timestamps are generated relative to the current clock. */
export function seedDemoData({ database, services, clock = () => new Date() }) {
  if (Number(database.value('SELECT COUNT(*) FROM users')) > 0) return false;
  const adminSeed={id:null,role:Roles.ADMINISTRATOR,name:'Demo Seeder'};
  const create=(data)=>services.auth.createUser(data,adminSeed);
  const admin=create({name:'Avery Morgan',email:'admin@aegis.local',password:'Admin@12345',role:Roles.ADMINISTRATOR,capacity:0,available:true});
  create({name:'Riya Shah',email:'employee@aegis.local',password:'Employee@12345',role:Roles.EMPLOYEE,capacity:0});
  create({name:'Alex Rivera',email:'alex.network@aegis.local',password:'Technician@12345',role:Roles.TECHNICIAN,skills:['network','vpn','dns','wifi'],capacity:6});
  create({name:'Jamie Chen',email:'jamie.apps@aegis.local',password:'Technician@12345',role:Roles.TECHNICIAN,skills:['software','application','payment','authentication'],capacity:5});
  create({name:'Samira Patel',email:'samira.database@aegis.local',password:'Technician@12345',role:Roles.TECHNICIAN,skills:['database','sql','backup','cloud'],capacity:5});
  create({name:'Noah Williams',email:'noah.security@aegis.local',password:'Technician@12345',role:Roles.TECHNICIAN,skills:['security','mfa','authentication','cloud'],capacity:4});
  const now=nowIso(clock);
  const serviceData=[['Payment Application','Processes campus and internal payments.',3],['Authentication Service','Identity, single sign-on, and MFA.',3],['Student Portal','Academic self-service portal.',2],['Email Service','Institutional email.',2],['Database Platform','Managed database infrastructure.',3],['Campus Network','Wired, Wi-Fi, VPN and DNS.',3]];
  for(const [name,description,business_criticality] of serviceData)services.incidents.insert('it_services',{name,description,business_criticality,active:1,created_at:now});
  const categoryData=[['Network',['wifi','router','dns','vpn','network','latency']],['Authentication',['login','password','mfa','authentication','sign in','sso']],['Database',['sql','query','database','backup','table']],['Software/Application',['crash','application','payment','error','software']],['Cloud',['server','virtual','cloud','vm','deployment']],['Security',['malware','suspicious','access','security','phishing']]];
  for(const [name,keywords] of categoryData)services.incidents.insert('categories',{name,keywords:JSON.stringify(keywords),active:1,created_at:now});
  const sla=[['P1',5,30],['P2',15,120],['P3',60,480],['P4',240,1440]];for(const [priority,response_minutes,resolution_minutes]of sla)services.incidents.insert('sla_policies',{priority,response_minutes,resolution_minutes,updated_at:now});
  database.run(`INSERT INTO system_configuration(config_key,config_value,updated_at) VALUES ('assignment_strategy','SKILL_BASED',:now)`,{now});
  const serviceByName = (name) => database.get('SELECT id FROM it_services WHERE name=:name', { name });
  const payment=serviceByName('Payment Application');const network=serviceByName('Campus Network');const portal=serviceByName('Student Portal');const auth=serviceByName('Authentication Service');const databaseService=serviceByName('Database Platform');
  database.run('INSERT INTO service_dependencies(service_id,depends_on_service_id,created_at) VALUES (:serviceId,:dependency,:now)',{serviceId:payment.id,dependency:auth.id,now});database.run('INSERT INTO service_dependencies(service_id,depends_on_service_id,created_at) VALUES (:serviceId,:dependency,:now)',{serviceId:payment.id,dependency:databaseService.id,now});database.run('INSERT INTO service_dependencies(service_id,depends_on_service_id,created_at) VALUES (:serviceId,:dependency,:now)',{serviceId:portal.id,dependency:auth.id,now});
  seedDemoIncidents({ database, services });
  services.audit.record({actor:{id:admin.id,role:admin.role},action:'DEMO_DATA_SEEDED',description:'Fictional AEGIS demonstration data was initialized.'});
  return true;
}

/** Development-only reset used by the demo preparation screen. It clears only AEGIS-owned tables. */
export function resetDemoData({ database, services, clock = () => new Date() }) {
  database.transaction(() => {
    for (const table of ['sessions', 'notifications', 'simulated_emails', 'audit_events', 'sla_breaches', 'escalations', 'feedback', 'incident_relationships', 'incident_comments', 'investigation_notes', 'incident_assignments', 'incidents', 'service_dependencies', 'sla_policies', 'system_configuration', 'categories', 'it_services', 'users']) database.run(`DELETE FROM ${table}`);
    database.run("DELETE FROM sqlite_sequence WHERE name IN ('users','it_services','categories','sla_policies','incidents','incident_assignments','investigation_notes','incident_comments','incident_relationships','notifications','simulated_emails','audit_events','sla_breaches','escalations','feedback','service_dependencies')");
  });
  return seedDemoData({ database, services, clock });
}

export { safeError };
