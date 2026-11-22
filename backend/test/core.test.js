import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AegisDatabase } from '../src/database.js';
import { AssignmentStrategyFactory, ConflictError, ForbiddenError, IncidentStatus, LifecycleError, PriorityCalculator, Roles, UnauthorizedError, toPublicUser } from '../src/domain.js';
import { createApplication } from '../src/server.js';
import { createServices, seedDemoData } from '../src/services.js';

function setup(seed = true, clock) {
  const database = new AegisDatabase(':memory:');
  const services = createServices({ database, clock });
  if (seed) seedDemoData({ database, services, clock });
  const login = (email, password) => services.auth.actorForToken(services.auth.login(email, password).token);
  return {
    database, services,
    admin: () => login('admin@aegis.local', 'Admin@12345'),
    employee: () => login('employee@aegis.local', 'Employee@12345'),
    technician: (email = 'jamie.apps@aegis.local') => login(email, 'Technician@12345'),
    close: () => database.close(),
  };
}

function seededIncident(context, title = 'Payment application unavailable') {
  return context.database.get('SELECT * FROM incidents WHERE title=:title', { title });
}

const paymentReport = {
  title: 'Payment application unavailable',
  description: 'Payment transactions are failing for students and staff. The payment application is unavailable.',
  serviceId: 1, categoryId: 4, impact: 3, urgency: 3, affectedUsers: 650,
};

test('invalid incident fields leave the database unchanged', (t) => {
  const app = setup();
  t.after(app.close);
  const before = app.database.value('SELECT COUNT(*) FROM incidents');
  assert.throws(() => app.services.incidentService.create(app.employee(), { ...paymentReport, affectedUsers: 1.5 }), { code: 'VALIDATION_ERROR' });
  assert.equal(app.database.value('SELECT COUNT(*) FROM incidents'), before);
});

test('no assignment is made when capacity and availability rules exclude all technicians', (t) => {
  const app = setup();
  t.after(app.close);
  const [first, ...remaining] = app.services.admin.technicians(app.admin());
  app.services.admin.updateUser(app.admin(), first.id, { capacity: 0 });
  for (const tech of remaining) app.services.admin.updateUser(app.admin(), tech.id, { available: false });
  const { incident } = app.services.incidentService.create(app.employee(), paymentReport);
  assert.equal(incident.status, IncidentStatus.CLASSIFIED);
  assert.equal(incident.assignedTechnician, null);
  assert.ok(app.database.get("SELECT 1 FROM notifications WHERE type='UNASSIGNED_INCIDENT' AND incident_id=:id", { id: incident.id }));
});

test('P2 and P3 SLA targets are snapshotted in calendar minutes', (t) => {
  const app = setup();
  t.after(app.close);
  const employee = app.employee();
  for (const [urgency, priority, response, resolution] of [[3, 'P2', 15, 120], [2, 'P3', 60, 480]]) {
    const { incident } = app.services.incidentService.create(employee, { ...paymentReport, impact: 2, urgency, affectedUsers: 1 });
    assert.equal(incident.priority, priority);
    assert.equal(Date.parse(incident.sla.responseDeadline) - Date.parse(incident.createdAt), response * 60_000);
    assert.equal(Date.parse(incident.sla.resolutionDeadline) - Date.parse(incident.createdAt), resolution * 60_000);
  }
});

test('similarity requires shared terms and respects incident ownership', (t) => {
  const app = setup();
  t.after(app.close);
  const stranger = app.services.auth.createUser({ name: 'Other Reporter', email: 'other@example.test', password: 'DemoPassword123!' });
  assert.deepEqual(app.services.incidentService.duplicates(paymentReport, stranger), []);
  assert.deepEqual(app.services.incidentService.duplicates({ ...paymentReport, title: 'Printer cartridge', description: 'Toner replacement requested' }, app.employee()), []);
  const { incident } = app.services.incidentService.create(stranger, { ...paymentReport, relatedIncidentIds: [seededIncident(app).id] });
  assert.deepEqual(incident.related, []);
});

test('a rejected resolution returns to investigation and preserves the prior resolution in audit', (t) => {
  const app = setup();
  t.after(app.close);
  const employee = app.employee();
  const tech = app.technician();
  const { incident } = app.services.incidentService.create(employee, paymentReport);
  app.services.incidentService.acknowledge(tech, incident.id);
  app.services.incidentService.startInvestigation(tech, incident.id);
  app.services.incidentService.resolve(tech, incident.id, { resolution: 'Restarted the simulated payment worker.' });
  const reopened = app.services.incidentService.rejectResolution(employee, incident.id, { message: 'Payments continue to fail.' });
  assert.equal(reopened.status, IncidentStatus.IN_PROGRESS);
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.sla.resolutionDeadline, incident.sla.resolutionDeadline);
  assert.match(reopened.audit.find((event) => event.action === 'RESOLUTION_ARCHIVED').metadata.resolution, /Restarted/);
});

test('report filters handle UTC dates, categories and invalid input', (t) => {
  const app = setup();
  t.after(app.close);
  assert.equal(app.services.reports.overview(app.admin(), { category: 4 }).totalIncidents, 2);
  assert.equal(app.services.reports.overview(app.admin(), { to: '2000-01-01' }).totalIncidents, 0);
  assert.throws(() => app.services.reports.overview(app.admin(), { from: '2026-02-30' }), { code: 'VALIDATION_ERROR' });
});

test('seed creates roles, incidents, audit history, and simulated email', () => {
  const app = setup();
  assert.equal(app.database.value('SELECT COUNT(*) FROM users'), 6);
  const states = app.database.all('SELECT status FROM incidents ORDER BY id').map(({ status }) => status);
  assert.deepEqual(states, ['WAITING_FOR_INFORMATION', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'VERIFIED', 'CLOSED']);
  assert.equal(app.database.value('SELECT COUNT(*) FROM sla_breaches'), 0);
  const payment = seededIncident(app);
  const { recommendations } = app.services.incidentService.recommendations(app.technician(), payment.id);
  assert.ok(recommendations.some(({ incident }) => incident.title === 'Payment application software installation failure'));
  assert.ok(app.database.value('SELECT COUNT(*) FROM audit_events') >= 20);
  assert.ok(app.database.value('SELECT COUNT(*) FROM simulated_emails') >= 10);
  app.close();
});

test('public registration creates an employee account only', () => {
  const app = setup(false);
  const user = app.services.auth.createUser({ name: 'Taylor Test', email: 'taylor@example.test', password: 'SafePass123!' });
  assert.equal(user.role, Roles.EMPLOYEE);
  assert.throws(() => app.services.auth.createUser({ name: 'Bad Role', email: 'bad@example.test', password: 'SafePass123!', role: Roles.ADMINISTRATOR }), ForbiddenError);
  app.close();
});

test('duplicate registration is rejected', () => {
  const app = setup();
  assert.throws(() => app.services.auth.createUser({ name: 'Riya Again', email: 'employee@aegis.local', password: 'SafePass123!' }), ConflictError);
  app.close();
});

test('valid and invalid logins are handled securely', () => {
  const app = setup();
  const login = app.services.auth.login('employee@aegis.local', 'Employee@12345');
  assert.match(login.token, /^[a-f0-9]{64}$/);
  assert.equal(login.user.role, Roles.EMPLOYEE);
  assert.throws(() => app.services.auth.login('employee@aegis.local', 'wrong-password'), UnauthorizedError);
  app.close();
});

test('priority algorithm produces explainable P1 and P4 outcomes', () => {
  const calculator = new PriorityCalculator();
  const critical = calculator.calculate({ impact: 3, urgency: 3, businessCriticality: 3, affectedUsers: 700, serviceName: 'Payments' });
  const low = calculator.calculate({ impact: 1, urgency: 1, businessCriticality: 1, affectedUsers: 1, serviceName: 'Wiki' });
  assert.equal(critical.priority, 'P1');
  assert.equal(low.priority, 'P4');
  assert.match(critical.explanation, /score/i);
});

test('priority input bounds are validated', () => {
  assert.throws(() => new PriorityCalculator().calculate({ impact: 0, urgency: 1, businessCriticality: 1 }), /impact/);
});

test('rule-based category suggestion explains matching keywords', () => {
  const app = setup();
  const suggestion = app.services.incidentService.categorySuggestion('VPN and DNS cannot connect to Wi-Fi', 'Network outage');
  assert.equal(suggestion.category.name, 'Network');
  assert.ok(suggestion.matchedKeywords.includes('vpn') || suggestion.matchedKeywords.includes('dns'));
  app.close();
});

test('duplicate detector identifies a related payment incident', () => {
  const app = setup();
  const payment = app.database.get('SELECT id FROM it_services WHERE name=:name', { name: 'Payment Application' });
  const category = app.database.get('SELECT id FROM categories WHERE name=:name', { name: 'Software/Application' });
  const matches = app.services.incidentService.duplicates({ title: 'Payment application failing', description: 'Payments cannot be processed and the application is unavailable', serviceId: payment.id, categoryId: category.id });
  assert.ok(matches.length > 0);
  assert.ok(matches[0].score >= 25);
  app.close();
});

test('skill-based assignment favours matching technician skills', () => {
  const strategy = AssignmentStrategyFactory.create('SKILL_BASED');
  const outcome = strategy.assign({ categoryName: 'Network', serviceName: 'Campus Network', technicians: [
    { id: 1, name: 'Apps', active: 1, available: 1, capacity: 5, active_workload: 0, skills: '["application"]' },
    { id: 2, name: 'Network', active: 1, available: 1, capacity: 5, active_workload: 2, skills: '["network","dns"]' },
  ] });
  assert.equal(outcome.technician.id, 2);
});

test('least-loaded assignment favours lowest workload with deterministic tie-break', () => {
  const strategy = AssignmentStrategyFactory.create('LEAST_LOADED');
  const outcome = strategy.assign({ technicians: [
    { id: 1, name: 'Zara', active: 1, available: 1, capacity: 4, active_workload: 1 },
    { id: 2, name: 'Alex', active: 1, available: 1, capacity: 4, active_workload: 1 },
  ] });
  assert.equal(outcome.technician.name, 'Alex');
});

test('incident creation assigns technician, records audit, notification, and SLA', () => {
  const app = setup();
  const employee = app.employee();
  const service = app.database.get('SELECT id FROM it_services WHERE name=:name', { name: 'Campus Network' });
  const category = app.database.get('SELECT id FROM categories WHERE name=:name', { name: 'Network' });
  const result = app.services.incidentService.create(employee, { title: 'VPN disconnected for remote class', description: 'The VPN disconnects repeatedly while access to the campus network is required.', serviceId: service.id, categoryId: category.id, impact: 2, urgency: 3, affectedUsers: 40 });
  assert.equal(result.incident.status, IncidentStatus.ASSIGNED);
  assert.ok(result.incident.assignedTechnician);
  assert.equal(result.incident.sla.responseMinutes, 15);
  assert.ok(app.database.value('SELECT COUNT(*) FROM audit_events WHERE incident_id=:id', { id: result.incident.id }) >= 5);
  assert.ok(app.database.value('SELECT COUNT(*) FROM notifications WHERE incident_id=:id', { id: result.incident.id }) >= 2);
  app.close();
});

test('employee cannot read another employee private incident', () => {
  const app = setup();
  const other = app.services.auth.createUser({ name: 'Other Employee', email: 'other@example.test', password: 'SafePass123!' });
  const actor = app.services.auth.actorForToken(app.services.auth.login(other.email, 'SafePass123!').token);
  const incident = seededIncident(app);
  assert.throws(() => app.services.incidentService.get(actor, incident.id), ForbiddenError);
  app.close();
});

test('invalid lifecycle transition is rejected', () => {
  const app = setup();
  const incident = seededIncident(app, 'Student portal login failure');
  const tech = toPublicUser(app.database.get('SELECT * FROM users WHERE id=:id', { id: incident.assigned_technician_id }));
  assert.equal(incident.status, IncidentStatus.IN_PROGRESS);
  assert.throws(() => app.services.incidentService.acknowledge(tech, incident.id), LifecycleError);
  app.close();
});

test('valid technician lifecycle produces resolution then reporter verification and close', () => {
  const app = setup();
  const employee = app.employee();
  const incident = seededIncident(app, 'Student portal login failure');
  const tech = toPublicUser(app.database.get('SELECT * FROM users WHERE id=:id', { id: incident.assigned_technician_id }));
  const resolved = app.services.incidentService.resolve(tech, incident.id, { resolution: 'Corrected the authentication callback and confirmed that affected students can sign in.' });
  assert.equal(resolved.status, IncidentStatus.RESOLVED);
  const verified = app.services.incidentService.verify(employee, incident.id, { note: 'Access works now.' });
  assert.equal(verified.status, IncidentStatus.VERIFIED);
  const closed = app.services.incidentService.close(employee, incident.id);
  assert.equal(closed.status, IncidentStatus.CLOSED);
  app.close();
});

test('technician notes and employee comments are persisted', () => {
  const app = setup();
  const incident = seededIncident(app, 'Student portal login failure');
  const tech = toPublicUser(app.database.get('SELECT * FROM users WHERE id=:id', { id: incident.assigned_technician_id }));
  const employee = app.employee();
  app.services.incidentService.addNote(tech, incident.id, { note: 'Captured authentication callback telemetry.' });
  const changed = app.services.incidentService.comment(employee, incident.id, { message: 'The login loop still happens after MFA.' });
  assert.ok(changed.notes.some((note) => /telemetry/.test(note.note)));
  assert.ok(changed.comments.some((comment) => /after MFA/.test(comment.message)));
  app.close();
});

test('SLA monitor records each breach only once', () => {
  let now = Date.parse('2026-11-20T06:00:00Z');
  const app = setup(true, () => new Date(now));
  const { incident } = app.services.incidentService.create(app.employee(), paymentReport);
  now = Date.parse(incident.sla.responseDeadline) + 1;
  const first = app.services.incidentService.monitorSla();
  assert.equal(first.breaches, 1);
  assert.equal(app.database.value("SELECT COUNT(*) FROM sla_breaches WHERE incident_id=:id AND breach_type='RESPONSE'", { id: incident.id }), 1);
  const count = app.database.value('SELECT COUNT(*) FROM sla_breaches');
  const second = app.services.incidentService.monitorSla();
  assert.ok(first.scanned > 0);
  assert.equal(app.database.value('SELECT COUNT(*) FROM sla_breaches'), count);
  assert.equal(second.breaches, 0);
  app.close();
});

test('admin configuration persists assignment strategy selection', () => {
  const app = setup();
  const admin = app.admin();
  const changed = app.services.admin.updateAssignmentStrategy(admin, { strategy: 'LEAST_LOADED' });
  assert.equal(changed.current, 'LEAST_LOADED');
  assert.equal(app.services.incidentService.configuration('assignment_strategy'), 'LEAST_LOADED');
  app.close();
});

test('admin can manage technician capacity while ordinary employee cannot', () => {
  const app = setup();
  const admin = app.admin();
  const tech = app.services.admin.technicians(admin)[0];
  const changed = app.services.admin.updateUser(admin, tech.id, { capacity: 9, available: false });
  assert.equal(changed.capacity, 9);
  assert.equal(changed.available, false);
  assert.throws(() => app.services.admin.technicians(app.employee()), ForbiddenError);
  app.close();
});

test('search and compound filters return only matching records', () => {
  const app = setup();
  const employee = app.employee();
  const result = app.services.incidentService.list(employee, { q: 'payment', priority: 'P1', pageSize: 20 });
  assert.equal(result.total, 1);
  assert.match(result.items[0].title, /payment/i);
  app.close();
});

test('reports derive data from persisted incident records', () => {
  const app = setup();
  const report = app.services.reports.overview(app.admin());
  assert.equal(report.totalIncidents, 6);
  assert.ok(report.byPriority.length > 0);
  assert.ok(report.recentActivity.length > 0);
  app.close();
});

test('report trends count more than 100 incidents without changing role scope', (t) => {
  let now = Date.parse('2026-11-20T06:00:00Z');
  const app = setup(true, () => new Date(now));
  t.after(app.close);
  const { incidentService, reports } = app.services;
  const admin = app.admin();
  const employee = app.employee();
  const technician = app.technician();

  for (let index = 0; index < 101; index += 1) {
    incidentService.create(employee, { ...paymentReport, title: `Trend regression incident ${index}` });
  }
  now += 86_400_000;
  incidentService.create(admin, paymentReport);

  assert.deepEqual(reports.trends(admin), [
    { date: '2026-11-20', value: 107 }, { date: '2026-11-21', value: 1 },
  ]);
  assert.deepEqual(reports.trends(employee), [{ date: '2026-11-20', value: 107 }]);
  const assignedTrend = reports.overview(technician).trend;
  assert.ok(assignedTrend.length > 0);
  assert.deepEqual(reports.trends(technician), assignedTrend);
});

for (const [resource, recordKey, existingName, attributes] of [
  ['services', 'service', 'CAMPUS NETWORK', { businessCriticality: 2 }],
  ['categories', 'category', 'NETWORK', { keywords: ['regression'] }],
]) {
  test(`duplicate ${resource} return HTTP 409 on create and rename`, async (t) => {
    const app = createApplication({ databasePath: ':memory:', seed: true });
    const server = http.createServer(app.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      app.close();
    });
    const { token } = app.services.auth.login('admin@aegis.local', 'Admin@12345');
    const endpoint = `http://127.0.0.1:${server.address().port}/api/admin/${resource}`;
    const request = (method, body, id = '') => fetch(endpoint + id, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const newName = `Duplicate-name regression ${recordKey}`;
    const created = await request('POST', { ...attributes, name: newName });
    assert.equal(created.status, 201);
    const { id } = (await created.json())[recordKey];
    const before = await (await request('GET')).json();
    const initialAuditCount = app.database.value('SELECT COUNT(*) FROM audit_events');

    for (const [method, suffix] of [['POST', ''], ['PATCH', `/${id}`]]) {
      const response = await request(method, { ...attributes, name: existingName }, suffix);
      assert.equal(response.status, 409);
      const error = await response.json();
      assert.equal(error.error, 'CONFLICT');
      assert.match(error.message, new RegExp(`${recordKey} with that name already exists`, 'i'));
    }
    assert.deepEqual(await (await request('GET')).json(), before);
    assert.equal(app.database.value('SELECT COUNT(*) FROM audit_events'), initialAuditCount);
    const unchangedName = await request('PATCH', { ...attributes, name: newName }, `/${id}`);
    assert.equal(unchangedName.status, 200);
    assert.equal((await unchangedName.json())[recordKey].name, newName);
  });
}

test('closed incident accepts one feedback submission only', () => {
  const app = setup();
  const incident = seededIncident(app, 'Payment application software installation failure');
  assert.equal(incident.status, IncidentStatus.CLOSED);
  assert.throws(() => app.services.incidentService.feedback(app.employee(), incident.id, { rating: 4, comment: 'Again' }), ConflictError);
  app.close();
});

test('service dependency cycles are rejected', () => {
  const app = setup();
  const admin = app.admin();
  const payment = app.database.get('SELECT id FROM it_services WHERE name=:name', { name: 'Payment Application' });
  const auth = app.database.get('SELECT id FROM it_services WHERE name=:name', { name: 'Authentication Service' });
  assert.throws(() => app.services.admin.addDependency(admin, { serviceId: auth.id, dependsOnServiceId: payment.id }), ConflictError);
  app.close();
});

test('SQLite persistence survives a database reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-test-'));
  const filename = path.join(directory, 'aegis.db');
  const first = new AegisDatabase(filename);
  const services = createServices({ database: first });
  seedDemoData({ database: first, services });
  const count = first.value('SELECT COUNT(*) FROM incidents');
  first.close();
  const second = new AegisDatabase(filename);
  assert.equal(second.value('SELECT COUNT(*) FROM incidents'), count);
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('HTTP API health, login, and private incident enforcement work together', async () => {
  const app = createApplication({ databasePath: ':memory:', seed: true });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  assert.equal((await fetch(`${base}/api/incidents`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employee@aegis.local', password: 'Employee@12345' }) }).then((response) => response.json());
  const list = await fetch(`${base}/api/incidents`, { headers: { Authorization: `Bearer ${login.token}` } }).then((response) => response.json());
  assert.ok(list.total > 0);
  const denied = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${login.token}` } });
  assert.equal(denied.status, 403);
  await new Promise((resolve) => server.close(resolve));
  app.close();
});

const acknowledgementCases = [
  { name: 'before the deadline', offset: -1, expected: 0 },
  { name: 'exactly at the deadline', offset: 0, expected: 0 },
  { name: 'after the deadline between monitor runs', offset: 1, expected: 1 },
  { name: 'after the monitor already recorded a breach', offset: 1, scanBefore: true, expected: 1 },
  { name: 'followed by the next monitor run', offset: 1, scanAfter: true, expected: 1 },
];

for (const { name, offset, expected, scanBefore, scanAfter } of acknowledgementCases) {
  test(`SLA acknowledgement ${name}`, (t) => {
    let now = Date.parse('2026-11-20T06:00:00Z');
    const app = setup(true, () => new Date(now));
    t.after(app.close);
    const { incidentService, reports } = app.services;
    const reporter = app.employee();
    const administrator = app.admin();
    const baselineViolations = reports.overview(administrator).slaViolations;
    const { incident } = incidentService.create(reporter, paymentReport);
    const tech = app.technician(incident.assignedTechnician.email);
    now = Date.parse(incident.sla.responseDeadline) + offset;
    if (scanBefore) incidentService.monitorSla();
    const acknowledged = incidentService.acknowledge(tech, incident.id);
    if (scanAfter) incidentService.monitorSla();

    assert.equal(acknowledged.acknowledgedAt, new Date(now).toISOString());
    assert.equal(acknowledged.status, IncidentStatus.ACKNOWLEDGED);
    assert.equal(acknowledged.sla.responseBreached, Boolean(expected));
    const params = { id: incident.id };
    assert.equal(app.database.value("SELECT COUNT(*) FROM sla_breaches WHERE incident_id=:id AND breach_type='RESPONSE'", params), expected);
    assert.equal(app.database.value("SELECT COUNT(*) FROM audit_events WHERE incident_id=:id AND action_type='SLA_VIOLATION_DETECTED' AND new_value='RESPONSE'", params), expected);
    const noticeParams = { ...params, recipient: reporter.id };
    assert.equal(app.database.value("SELECT COUNT(*) FROM notifications WHERE incident_id=:id AND recipient_id=:recipient AND type='SLA_BREACH'", noticeParams), expected);
    assert.equal(app.database.value("SELECT COUNT(*) FROM simulated_emails WHERE incident_id=:id AND recipient_id=:recipient AND body LIKE 'RESPONSE SLA violation%'", noticeParams), expected);
    assert.equal(reports.overview(administrator).slaViolations, baselineViolations + expected);
  });
}

function reportForVerification(app, reporter, { resolve = true } = {}) {
  const { incidentService } = app.services;
  const { incident } = incidentService.create(reporter, paymentReport);
  if (!resolve) return incident;
  const technician = app.technician(incident.assignedTechnician.email);
  incidentService.acknowledge(technician, incident.id);
  incidentService.startInvestigation(technician, incident.id);
  return incidentService.resolve(technician, incident.id, { resolution: 'The test payment application was restored.' });
}

for (const role of ['administrator', 'employee']) {
  test(`${role} can verify and close their own resolved incident with audit history`, (t) => {
    const app = setup();
    t.after(app.close);
    const reporter = role === 'administrator' ? app.admin() : app.employee();
    const { incidentService } = app.services;
    const incident = reportForVerification(app, reporter);

    assert.throws(() => incidentService.close(reporter, incident.id), LifecycleError);
    const verified = incidentService.verify(reporter, incident.id, { note: 'Confirmed restored.' });
    assert.equal(verified.status, IncidentStatus.VERIFIED);
    const closed = incidentService.close(reporter, incident.id);
    assert.equal(closed.status, IncidentStatus.CLOSED);
    for (const [action, oldValue, newValue] of [
      ['RESOLUTION_VERIFIED', IncidentStatus.RESOLVED, IncidentStatus.VERIFIED],
      ['INCIDENT_CLOSED', IncidentStatus.VERIFIED, IncidentStatus.CLOSED],
    ]) {
      const event = closed.audit.find((entry) => entry.action === action);
      assert.deepEqual([event.actor.id, event.oldValue, event.newValue], [reporter.id, oldValue, newValue]);
    }
  });

  test(`${role} cannot verify another reporter's resolved incident`, (t) => {
    const app = setup();
    t.after(app.close);
    const reporter = app.employee();
    const other = role === 'administrator' ? app.admin() : app.services.auth.createUser({
      name: 'Other Employee', email: 'other@example.test', password: 'DemoPassword123!',
    });
    const { incidentService } = app.services;
    const incident = reportForVerification(app, reporter);

    assert.throws(() => incidentService.verify(other, incident.id, {}), ForbiddenError);
    const unchanged = incidentService.get(reporter, incident.id);
    assert.equal(unchanged.status, IncidentStatus.RESOLVED);
    assert.ok(!unchanged.audit.some((event) => event.action === 'RESOLUTION_VERIFIED'));
  });
}

test('the owning administrator cannot verify before resolution', (t) => {
  const app = setup();
  t.after(app.close);
  const reporter = app.admin();
  const incident = reportForVerification(app, reporter, { resolve: false });
  assert.throws(() => app.services.incidentService.verify(reporter, incident.id, {}), LifecycleError);
});

test('incident date filters validate UTC calendar dates and ranges through HTTP', async (t) => {
  let now = Date.parse('2026-11-20T00:00:00Z');
  const app = createApplication({ databasePath: ':memory:', seed: true, clock: () => new Date(now) });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const { user } = app.services.auth.login('admin@aegis.local', 'Admin@12345');
  const create = () => app.services.incidentService.create(user, paymentReport).incident.id;
  const first = create();
  now = Date.parse('2026-11-20T23:59:59.999Z');
  const last = create();
  now += 1;
  const followingDay = create();
  const { token } = app.services.auth.login('admin@aegis.local', 'Admin@12345');
  const search = (query = '') => fetch(`http://127.0.0.1:${server.address().port}/api/incidents${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const all = await search();
  const empty = await search('?from=&to=');
  const oneDay = await search('?from=2026-11-20&to=2026-11-20');
  assert.equal(all.status, 200);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), await all.json());
  assert.equal(oneDay.status, 200);
  const ids = (await oneDay.json()).items.map(({ id }) => id);
  assert.ok(ids.includes(first) && ids.includes(last) && !ids.includes(followingDay));

  for (const [query, message] of [
    ['?from=20-11-2026', /YYYY-MM-DD/],
    ['?to=2026-02-30', /YYYY-MM-DD/],
    ['?from=2026-11-21&to=2026-11-20', /on or before/],
  ]) {
    const response = await search(query);
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
    assert.equal(body.error, 'VALIDATION_ERROR');
    assert.match(body.message, message);
  }
});

test('category suggestions match meaningful whole words and contiguous phrases', (t) => {
  const app = setup();
  t.after(app.close);
  const suggest = (description) => app.services.incidentService.categorySuggestion(description);
  for (const description of ['a', 'I am', 'Help!', 'I spilled tea on my notebook', 'The applicationless draft', 'Sign the form and send it in.']) {
    assert.equal(suggest(description).category, null, description);
  }
  for (const [description, category, keyword] of [
    ['Campus Wi-Fi stopped working', 'Network', 'wifi'],
    ['The user cannot LOG IN because LOGIN fails', 'Authentication', 'login'],
    ['Cannot sign-in to the portal', 'Authentication', 'sign in'],
    ['The application crashes on launch', 'Software/Application', 'application'],
    ['Network connectivity failed on the first floor', 'Network', 'network'],
    ['dNs! RoUtEr, and VpN are unreachable.', 'Network', 'dns'],
  ]) {
    const result = suggest(description);
    assert.equal(result.category?.name, category, description);
    assert.ok(result.matchedKeywords.includes(keyword), description);
  }
});
