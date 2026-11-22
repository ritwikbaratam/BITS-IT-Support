import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../backend/src/server.js';

const { chromium } = await import(process.env.AEGIS_PLAYWRIGHT_MODULE ?? 'playwright-core');
let now = Date.now();
const app = createApplication({ databasePath: ':memory:', clock: () => new Date(now) });
const server = http.createServer(app.handler);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [];
const screenshots = process.env.AEGIS_SCREENSHOTS_DIR;
let browser;

async function capture(page, filename) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, filename), animations: 'disabled', style: '.toast-region { visibility: hidden }' });
}

async function signIn(page, email, password) {
  await page.goto(url + '/#/login');
  await page.locator('.workspace-overlay').waitFor({ state: 'detached' });
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to BITS IT Support' }).click();
  await page.locator('.workspace-overlay').getByText('Preparing your dashboard', { exact: true }).waitFor();
  await page.waitForURL('**/#/dashboard');
  await page.locator('.metric').first().waitFor();
  await page.locator('.workspace-overlay').waitFor({ state: 'detached' });
}

async function perform(page, action, values = {}) {
  await page.locator(`[data-operation="${action}"]`).click();
  const dialog = page.getByRole('dialog');
  for (const [name, value] of Object.entries(values)) {
    const control = dialog.locator(`[name="${name}"]`);
    if (await control.evaluate((element) => element.tagName === 'SELECT')) await control.selectOption(value);
    else await control.fill(value);
  }
  await dialog.locator('button[type=submit]').click();
  await dialog.waitFor({ state: 'hidden' });
}

try {
  browser = await chromium.launch({
    ...(process.env.AEGIS_BROWSER_PATH ? { executablePath: process.env.AEGIS_BROWSER_PATH } : { channel: 'msedge' }),
  });
  const newPage = async (options) => {
    const page = await (await browser.newContext(options)).newPage();
    page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
    });
    return page;
  };

  const entry = await newPage({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  const emblem = await entry.request.get(url + '/assets/bits-logo.jpeg');
  assert.equal(emblem.headers()['content-type'], 'image/jpeg');
  const photo = await entry.request.get(url + '/assets/bits-hyderabad.jpg');
  assert.equal(photo.status(), 200);
  assert.equal(photo.headers()['content-type'], 'image/jpeg');
  await entry.goto(url + '/');
  const entryLoader = entry.locator('.workspace-overlay');
  await entryLoader.getByText('Initializing workspace', { exact: true }).waitFor();
  assert.equal(await entryLoader.locator('.halo-primary').evaluate(el => getComputedStyle(el).animationDuration), '2.8s');
  assert.equal(await entryLoader.locator('.halo-secondary').evaluate(el => getComputedStyle(el).animationDirection), 'reverse');
  assert.equal(await entryLoader.getByRole('img', { name: 'BITS Pilani emblem' }).getAttribute('src'), '/assets/bits-logo.jpeg');
  assert.equal(await entry.locator('link[rel="icon"]').getAttribute('href'), '/assets/bits-logo.jpeg');
  await capture(entry, 'bits-loader.png');
  await entryLoader.waitFor({ state: 'detached' });
  await entry.getByRole('heading', { name: 'Campus IT support' }).waitFor();
  assert.equal(await entry.locator('#app').evaluate(el => el.inert), false);
  assert.match(await entry.title(), /BITS IT Support/);
  const wordmark = await entry.locator('.bits-wordmark > span').evaluateAll((letters) => letters.map((el) => ({
    text: el.textContent, weight: Number(getComputedStyle(el).fontWeight), color: getComputedStyle(el).color,
    top: el.getBoundingClientRect().top,
  })));
  assert.equal(wordmark.map(({ text }) => text).join(''), 'BITS');
  assert.ok(wordmark[1].weight > wordmark[0].weight && wordmark[2].weight > wordmark[3].weight);
  assert.notEqual(wordmark[1].color, wordmark[0].color);
  const tops = wordmark.map(({ top }) => top);
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2);
  assert.match(await entry.locator('.auth-shell').evaluate(el => getComputedStyle(el).backgroundImage), /bits-hyderabad.jpg/);
  await capture(entry, 'bits-login.png');
  await entry.evaluate(() => window.bitsAppearance.set({ theme: 'light' }));
  await capture(entry, 'bits-login-light.png');
  await entry.setViewportSize({ width: 390, height: 850 });
  assert.match(await entry.locator('.auth-intro').evaluate(el => getComputedStyle(el).backgroundImage), /bits-hyderabad.jpg/);
  await capture(entry, 'bits-login-mobile-light.png');
  await entry.close();
  console.log('PASS BITS logo and favicon, weighted wordmark, campus photo, and startup halo');

  const employee = await newPage();
  await signIn(employee, 'employee@aegis.local', 'Employee@12345');
  await employee.goto(url + '/#/incidents/new');
  const titleInput = employee.getByLabel('Short incident title');
  await titleInput.fill('A'.repeat(161));
  assert.equal((await titleInput.inputValue()).length, 160);
  await employee.getByLabel('Short incident title').fill('Payment application unavailable');
  await employee.getByLabel('Detailed description').fill('Payment transactions are failing for students and staff. The payment application is unavailable.');
  await employee.getByRole('button', { name: 'Suggest category' }).click();
  await employee.locator('#category-suggestion').getByText(/Software\/Application/).waitFor();
  await employee.getByLabel('Affected IT service').selectOption({ label: 'Payment Application' });
  await employee.getByLabel('Impact', { exact: true }).selectOption('3');
  await employee.getByLabel('Urgency', { exact: true }).selectOption('3');
  await employee.getByLabel('Affected users').fill('650');
  await employee.locator('[name=relatedIncidentId]').first().check();
  await employee.getByRole('button', { name: /Create incident/ }).click();
  await employee.waitForURL(/#\/incidents\/\d+$/);
  const detail = employee.url();
  await employee.getByText('Why this priority?').waitFor();
  await employee.locator('.incident-hero').getByText('P1', { exact: true }).waitFor();
  await capture(employee, 'incident-detail.png');
  await employee.getByRole('tab', { name: 'Related & knowledge' }).click();
  await employee.getByText(/Similarity \d+%/).waitFor();
  await employee.getByRole('tab', { name: 'Activity timeline' }).click();
  await employee.getByText('Reporter linked a potential duplicate.').waitFor();
  const createdIncidentCode = await employee.locator('.incident-id').textContent();
  await employee.goto(url + '/#/notifications');
  const createdNotice = employee.getByRole('button', { name: new RegExp(`${createdIncidentCode} was created`) });
  await createdNotice.click();
  await employee.waitForURL(detail);
  console.log('PASS browser workflow 1: critical report, category, duplicate link, assignment and audit');

  const tech = await newPage();
  await signIn(tech, 'jamie.apps@aegis.local', 'Technician@12345');
  assert.match(await tech.locator('.campus-dashboard').evaluate(el => getComputedStyle(el).backgroundImage), /bits-hyderabad.jpg/);
  await tech.goto(detail);
  await perform(tech, 'acknowledge');
  await perform(tech, 'start-investigation');
  await tech.getByRole('tab', { name: 'Investigation' }).click();
  await tech.getByLabel('Add investigation note').fill('Confirmed a simulated payment worker outage.');
  await tech.getByRole('button', { name: 'Add note' }).click();
  await tech.getByText('Confirmed a simulated payment worker outage.', { exact: true }).waitFor();
  await perform(tech, 'request-information', { message: 'When did you first notice the outage?' });
  await employee.reload();
  await employee.getByRole('tab', { name: 'Investigation' }).click();
  await employee.getByLabel('Reply to information request').fill('We first noticed it at 9 AM.');
  await employee.getByRole('button', { name: 'Send reply' }).click();
  await employee.getByText('We first noticed it at 9 AM.', { exact: true }).waitFor();
  await tech.reload();
  await perform(tech, 'resolve', { resolution: 'Restored the payment worker and verified a successful transaction.' });
  await employee.reload();
  await perform(employee, 'verify', { note: 'Payments are working again.' });
  await perform(employee, 'close');
  await perform(employee, 'feedback', { rating: '5', comment: 'Quick response and clear communication.' });
  await employee.locator('.incident-hero').getByText('CLOSED', { exact: true }).waitFor();
  assert.equal(await employee.locator('[data-sla-end]').textContent(), 'Resolved');
  console.log('PASS browser workflow 2: acknowledgement, investigation, information request, reply, resolution, verification, closure and feedback');

  const admin = await newPage();
  await signIn(admin, 'admin@aegis.local', 'Admin@12345');
  assert.match(await admin.locator('.campus-dashboard').evaluate(el => getComputedStyle(el).backgroundImage), /bits-hyderabad.jpg/);
  await capture(admin, 'admin-dashboard.png');
  await admin.getByRole('button', { name: /Refresh/ }).click();
  await admin.locator('.workspace-overlay').getByText('Updating your dashboard', { exact: true }).waitFor();
  await admin.locator('.workspace-overlay').waitFor({ state: 'detached' });
  await admin.getByRole('heading', { name: 'Command overview' }).waitFor();
  await admin.goto(url + '/#/admin/sla');
  const p1 = admin.locator('[data-priority="P1"]');
  await p1.getByLabel('Response minutes').fill('6');
  await p1.getByRole('button', { name: 'Save P1' }).click();
  await admin.getByText('SLA policy saved.', { exact: true }).waitFor();
  await admin.goto(url + '/#/admin/technicians');
  const jamie = admin.getByRole('row', { name: /Jamie Chen/ });
  await jamie.getByRole('button', { name: 'Edit' }).click();
  await admin.getByRole('dialog').locator('[name=capacity]').fill('7');
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await admin.getByRole('row', { name: /Jamie Chen.*7/ }).waitFor();
  await admin.goto(url + '/#/admin/assignment');
  await admin.getByLabel('Strategy', { exact: true }).selectOption('LEAST_LOADED');
  await admin.getByRole('button', { name: 'Save strategy' }).click();
  await admin.getByText('Assignment strategy saved.', { exact: true }).waitFor();
  const escalationReporter = app.services.auth.login('employee@aegis.local', 'Employee@12345').user;
  const { incident: overdue } = app.services.incidentService.create(escalationReporter, {
    title: 'Campus network response escalation fixture', description: 'The campus network is unreachable in several teaching buildings.',
    serviceId: 6, categoryId: 1, impact: 3, urgency: 3, affectedUsers: 650,
  });
  now = Date.parse(overdue.sla.responseDeadline) + 1_000;
  await admin.goto(url + '/#/sla-monitor');
  await admin.getByRole('button', { name: 'Run monitor', exact: true }).click();
  await admin.getByText('SLA monitor completed.', { exact: true }).waitFor();
  await admin.goto(url + '/#/admin/escalations');
  await admin.getByRole('row').filter({ has: admin.getByRole('cell', { name: String(overdue.id), exact: true }) }).getByText('RESPONSE SLA violation', { exact: true }).waitFor();
  await admin.goto(url + '/#/admin/email-outbox');
  await admin.locator('tbody tr').first().waitFor();
  await admin.getByRole('button', { name: 'View message' }).first().click();
  await admin.getByRole('dialog').getByText(/^To /).waitFor();
  await admin.getByRole('button', { name: 'Close dialog' }).click();
  await admin.goto(url + '/#/reports');
  await admin.getByRole('heading', { name: 'Service analysis' }).waitFor();
  await admin.getByLabel('Category', { exact: true }).selectOption({ label: 'Software/Application' });
  await admin.getByRole('button', { name: 'Apply filters' }).click();
  await admin.waitForURL(/category=4/);
  await admin.locator('.metric-value').first().getByText('3', { exact: true }).waitFor();
  const download = admin.waitForEvent('download');
  await admin.getByRole('button', { name: /Export incident CSV/ }).click();
  assert.match((await download).suggestedFilename(), /^aegis-incidents-.*\.csv$/);
  console.log('PASS browser workflow 3: SLA policy, technician settings, strategy, escalations, email, reports and CSV');

  const { auth, incidentService } = app.services;
  const reporter = auth.login('admin@aegis.local', 'Admin@12345').user;
  const userEmail = 'edit-regression@example.test';
  const disabledUser = app.services.admin.createUser(reporter, {
    name: 'Disabled user fixture', email: userEmail, password: 'RegressionDemo@123',
  });
  const setAccountActive = (active) => app.services.admin.updateUser(reporter, disabledUser.id, { active });
  setAccountActive(false);
  await admin.goto(url + '/#/admin/users');
  const editUser = (name) => admin.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Edit' }).click();
  const editor = admin.getByRole('dialog');
  await editUser('Disabled user fixture');
  assert.equal(await editor.locator('[name=active]').inputValue(), 'false');
  assert.deepEqual(await editor.locator('input[readonly]').evaluateAll((inputs) => inputs.map((input) => input.value)), [userEmail, 'Employee']);
  assert.equal(await editor.locator('[name=email], [name=role]').count(), 0);
  await editor.locator('[name=name]').fill('Renamed disabled user');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(app.services.users.byId(disabledUser.id).name, 'Renamed disabled user');
  assert.equal(app.services.users.byId(disabledUser.id).active, 0);
  await editUser('Renamed disabled user');
  await editor.locator('[name=active]').selectOption('true');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(app.services.users.byId(disabledUser.id).active, 1);
  await editUser('Renamed disabled user');
  setAccountActive(false);
  await editor.locator('[name=name]').fill('Renamed after deactivation');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(app.services.users.byId(disabledUser.id).active, 0);
  await admin.goto(url + '/#/admin/categories');
  await admin.getByRole('row', { name: /Authentication/ }).getByRole('button', { name: 'Edit' }).click();
  await editor.waitFor();
  assert.equal(await editor.locator('[name=description]').count(), 0);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  console.log('PASS user edits preserve account status and unsupported fields cannot be edited');

  const createPaymentIncident = (title) => incidentService.create(reporter, {
    title, description: 'Payment application is not processing test transactions.',
    serviceId: 1, categoryId: 4, impact: 3, urgency: 3, affectedUsers: 650,
  }).incident;
  const owned = createPaymentIncident('Administrator verification fixture');
  const assignee = auth.login(owned.assignedTechnician.email, 'Technician@12345').user;
  incidentService.acknowledge(assignee, owned.id);
  incidentService.startInvestigation(assignee, owned.id);
  incidentService.resolve(assignee, owned.id, { resolution: 'Restored the test payment application.' });
  await admin.goto(`${url}/#/incidents/${owned.id}`);
  await perform(admin, 'verify', { note: 'Confirmed as the reporter.' });
  await perform(admin, 'close');
  await admin.locator('.incident-hero').getByText('CLOSED', { exact: true }).waitFor();
  console.log('PASS browser regression: original administrator reporter can verify and close');

  const atRisk = createPaymentIncident('SLA at-risk filter fixture');
  now = Date.parse(atRisk.sla.responseDeadline) - 1000;
  createPaymentIncident('SLA on-track filter fixture');
  await admin.goto(url + '/#/incidents');
  await admin.locator('tr[data-incident-link]').first().waitFor();
  const slaFilter = admin.locator('#filter-sla');
  assert.equal(await admin.locator('#incident-search').getAttribute('placeholder'), 'Search title, description, or incident ID…');
  console.log('PASS incident form enforces 160-character titles and search names supported fields');
  const search = admin.getByRole('button', { name: 'Search', exact: true });
  for (const [value, label] of [
    ['ON_TRACK', 'On track'], ['MET', 'Met'], ['AT_RISK', 'At risk'],
    ['BREACHED', 'Breached'], ['', 'Any SLA status'],
  ]) {
    const expected = incidentService.list(reporter, { slaStatus: value }).items.map(({ id }) => id);
    assert.ok(expected.length > 0, `expected seeded results for ${label}`);
    assert.deepEqual(await slaFilter.selectOption({ label }), [value]);
    await search.click();
    await admin.waitForURL((current) => (new URLSearchParams(current.hash.split('?')[1]).get('slaStatus') ?? '') === value);
    await admin.waitForFunction((ids) => {
      const actual = [...document.querySelectorAll('tr[data-incident-link]')].map((row) => Number(row.dataset.incidentLink));
      return JSON.stringify(actual) === JSON.stringify(ids);
    }, expected);
    assert.equal(await slaFilter.inputValue(), value);
  }
  await slaFilter.selectOption('AT_RISK');
  await admin.locator('#incident-search').fill('no incident has this Phase 2 test title');
  await search.click();
  await admin.getByRole('heading', { name: 'No incidents match these filters' }).waitFor();
  console.log('PASS browser regression: all four SLA states, unfiltered results and empty results');

  const mobile = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await signIn(mobile, 'employee@aegis.local', 'Employee@12345');
  await mobile.getByRole('button', { name: 'Open navigation' }).click();
  await mobile.locator('.sidebar').getByRole('link', { name: 'Incidents', exact: true }).click();
  await mobile.getByRole('heading', { name: 'Incident register' }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile register should not overflow the viewport');
  console.log('PASS mobile navigation');

  const longTitle = 'DNS troubleshooting report '.concat('X'.repeat(132));
  const employeeActor = auth.login('employee@aegis.local', 'Employee@12345').user;
  const { incident: longReport } = incidentService.create(employeeActor, {
    title: longTitle, description: 'Long-title fixture for checking the dashboard and incident detail layout.',
    serviceId: 6, categoryId: 1, impact: 3, urgency: 3, affectedUsers: 800,
  });
  const assertNoOverflow = async (page, label) => {
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth,
    }));
    assert.ok(dimensions.content <= dimensions.width + 1, `${label}: ${JSON.stringify(dimensions)}`);
  };
  for (const width of [1440, 1120, 768, 390, 320]) {
    await employee.setViewportSize({ width, height: 850 });
    await employee.goto(url + '/#/dashboard');
    const row = employee.locator('.incident-compact-row').filter({ hasText: longTitle });
    await row.waitFor();
    await assertNoOverflow(employee, `employee dashboard at ${width}px`);
    const positions = await row.evaluate((el) => ({
      title: el.querySelector('.list-row-title').getBoundingClientRect().bottom,
      meta: el.querySelector('.incident-row-code').getBoundingClientRect().top,
      header: document.querySelector('.topbar').getBoundingClientRect().bottom,
      heading: document.querySelector('.page-header h1').getBoundingClientRect().top,
    }));
    assert.ok(positions.title <= positions.meta && positions.header < positions.heading);
    assert.equal(await row.locator('.incident-row-service').textContent(), 'Campus Network');
    assert.equal(await row.locator('.badge').count(), 1);
    if (width === 1440 || width === 390) await capture(employee, `bits-dashboard-${width}.png`);
    await row.click();
    await employee.waitForURL(`**/#/incidents/${longReport.id}`);
    await employee.locator('.incident-hero').waitFor();
    await assertNoOverflow(employee, `long incident detail at ${width}px`);
    await employee.goto(url + '/#/incidents/new');
    await employee.getByLabel('Short incident title').waitFor();
    await assertNoOverflow(employee, `report form at ${width}px`);
  }
  await admin.setViewportSize({ width: 768, height: 850 });
  await admin.goto(url + '/#/reports');
  await admin.getByRole('heading', { name: 'Service analysis' }).waitFor();
  await assertNoOverflow(admin, 'administrator reports at tablet width');
  console.log('PASS long titles, clickable incident rows, header spacing and responsive layouts at 1440/1120/768/390/320px');

  const newPayment = createPaymentIncident('Payment application unavailable');
  const jamieActor = auth.login('jamie.apps@aegis.local', 'Technician@12345').user;
  if (newPayment.assignedTechnician.id !== jamieActor.id) {
    incidentService.assign(reporter, newPayment.id, { technicianId: jamieActor.id, reason: 'Use technician-scoped payment history for the test.' });
  }
  await tech.goto(`${url}/#/incidents/${newPayment.id}`);
  await tech.getByRole('tab', { name: 'Related & knowledge' }).click();
  const historicalId = detail.split('/').at(-1);
  const fix = tech.locator('.fix-card').filter({ has: tech.locator(`a[href="#/incidents/${historicalId}"]`) });
  await fix.getByText(/Similarity \d+\/100/).waitFor();
  await fix.getByText(/Restored the payment worker/).waitFor();
  await fix.getByText(/Same affected IT service/).waitFor();
  await fix.scrollIntoViewIfNeeded();
  await capture(tech, 'bits-smart-fixes.png');
  await tech.setViewportSize({ width: 320, height: 850 });
  await assertNoOverflow(tech, 'Smart Fix suggestions at 320px');
  await admin.goto(`${url}/#/incidents/${longReport.id}`);
  await admin.getByRole('tab', { name: 'Related & knowledge' }).click();
  await admin.getByRole('heading', { name: 'Network troubleshooting' }).waitFor();
  await admin.getByText('Curated guidance', { exact: true }).waitFor();
  console.log('PASS Smart Fix matches a real resolved incident and labels curated fallback');

  await tech.goto(url + '/#/admin/sla-rescue');
  await tech.getByRole('heading', { name: 'Access restricted' }).waitFor();
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.locator('.sidebar').getByRole('link', { name: 'SLA Rescue', exact: true }).click();
  const rescueCard = admin.locator(`[data-rescue-id="${newPayment.id}"]`);
  await rescueCard.getByText('P1 Attention', { exact: true }).waitFor();
  await rescueCard.getByText('Response deadline', { exact: true }).waitFor();
  const actualDeadline = await rescueCard.locator('time').getAttribute('datetime');
  assert.equal(actualDeadline, newPayment.sla.responseDeadline);
  const countdown = rescueCard.locator('.rescue-countdown');
  const initialCountdown = await countdown.textContent();
  now = Date.parse(atRisk.sla.responseDeadline) + 1000;
  await admin.waitForFunction(({ id, initial }) => document.querySelector(`[data-rescue-id="${id}"] .rescue-countdown`)?.textContent !== initial,
    { id: newPayment.id, initial: initialCountdown });
  await admin.locator(`[data-rescue-id="${atRisk.id}"]`).getByText('Overdue', { exact: true }).waitFor();
  await capture(admin, 'bits-sla-rescue.png');
  await rescueCard.getByRole('button', { name: 'Notify technician' }).click();
  await rescueCard.getByText('Reminder sent', { exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Refresh risks' }).click();
  await rescueCard.getByText('Reminder sent', { exact: true }).waitFor();
  await tech.goto(url + '/#/notifications');
  await tech.getByText(`${newPayment.incidentCode} needs an SLA update`, { exact: true }).waitFor();
  await admin.getByRole('link', { name: /All active/ }).click();
  await admin.getByText('On Track', { exact: true }).first().waitFor();
  await admin.setViewportSize({ width: 320, height: 850 });
  await assertNoOverflow(admin, 'SLA Rescue at 320px');
  await admin.evaluate(() => window.bitsAppearance.set({ theme: 'light' }));
  await capture(admin, 'bits-sla-rescue-mobile.png');
  console.log('PASS SLA Rescue authorization, snapshot deadline, countdown, reminders and mobile queue');

  await tech.clock.setFixedTime(new Date(now + 2 * 60 * 60_000));
  await tech.goto(`${url}/#/incidents/${newPayment.id}`);
  const detailClock = tech.locator('[data-sla-end]');
  await detailClock.waitFor();
  const remaining = Math.floor((Date.parse(newPayment.sla.resolutionDeadline) - now) / 1000);
  const countdownText = await detailClock.textContent();
  const parts = countdownText.match(/^(\d+)m (\d+)s left$/);
  assert.ok(parts, `Expected server-relative time remaining, received "${countdownText}"`);
  assert.ok(Math.abs(Number(parts[1]) * 60 + Number(parts[2]) - remaining) <= 3);
  await tech.waitForFunction((initial) => document.querySelector('[data-sla-end]')?.textContent !== initial, countdownText);
  console.log('PASS incident detail countdown uses server time despite browser clock skew');

  await employee.goto(url + '/#/dashboard');
  await employee.locator('.metric').first().waitFor();
  const trigger = employee.getByRole('button', { name: 'Account and settings' });
  const panel = employee.locator('#account-menu');
  await trigger.focus();
  await employee.keyboard.press('ArrowDown');
  assert.equal(await employee.evaluate(() => document.activeElement.textContent.trim()), 'My profile');
  await employee.keyboard.press('ArrowDown');
  assert.equal(await employee.evaluate(() => document.activeElement.textContent.trim()), 'Light');
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 850);
  await capture(employee, 'bits-account-mobile.png');
  await employee.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await employee.evaluate(() => document.activeElement.id), 'account-trigger');
  await trigger.click();
  await employee.locator('.breadcrumb-brand').click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click();
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click();
  await panel.getByRole('link', { name: 'About BITS IT Support' }).click();
  await employee.locator('.support-page .bits-logo').waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await trigger.click();
  await panel.getByRole('link', { name: 'User guide' }).click();
  await employee.getByRole('heading', { name: 'User guide' }).waitFor();
  await trigger.click();
  await panel.getByRole('link', { name: 'My profile' }).click();
  await employee.getByRole('heading', { name: 'Account details' }).waitFor();
  console.log('PASS account menu keyboard, pointer and mobile behavior with Profile, About and User guide');

  await employee.setViewportSize({ width: 1440, height: 900 });
  await employee.goto(url + '/#/dashboard');
  await employee.locator('.metric').first().waitFor();
  await employee.emulateMedia({ reducedMotion: 'reduce' });
  const semanticP1 = () => employee.locator('.incident-compact-row .activity-icon.critical').first().evaluate(el => getComputedStyle(el).color);
  const p1Before = await semanticP1();
  const applied = new Set();
  for (const label of ['Blue', 'Purple', 'Green', 'Orange', 'Pink']) {
    await trigger.click();
    await panel.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    applied.add(await employee.locator('.page-header .button.primary').evaluate(el => getComputedStyle(el).backgroundColor));
    assert.equal(await semanticP1(), p1Before);
  }
  assert.equal(applied.size, 5);
  await trigger.click();
  await panel.getByRole('button', { name: 'Light', exact: true }).click();
  const lightColor = await employee.locator('body').evaluate(el => getComputedStyle(el).color);
  assert.match(await employee.locator('.campus-dashboard').evaluate(el => getComputedStyle(el).backgroundImage), /bits-hyderabad.jpg/);
  await trigger.click();
  await capture(employee, 'bits-account-light.png');
  await employee.reload();
  await employee.locator('.workspace-overlay').waitFor({ state: 'detached' });
  assert.equal(await employee.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await employee.locator('html').getAttribute('data-accent'), 'pink');
  await trigger.click();
  await panel.getByRole('button', { name: 'System', exact: true }).click();
  await employee.emulateMedia({ colorScheme: 'light' });
  assert.equal(await employee.locator('body').evaluate(el => getComputedStyle(el).color), lightColor);
  await employee.emulateMedia({ colorScheme: 'dark' });
  assert.notEqual(await employee.locator('body').evaluate(el => getComputedStyle(el).color), lightColor);
  await employee.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger.click();
  await panel.getByRole('button', { name: 'Reduced animations' }).click();
  assert.equal(await panel.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await employee.reload();
  await employee.locator('.metric').first().waitFor();
  assert.equal(await employee.locator('html').getAttribute('data-motion'), 'reduced');
  await trigger.click();
  await panel.getByRole('button', { name: 'Reset appearance' }).click();
  assert.equal(await employee.locator('html').getAttribute('data-motion'), 'normal');
  assert.equal(await employee.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await employee.locator('html').getAttribute('data-accent'), 'blue');
  await employee.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await panel.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  console.log('PASS three themes, five accents, semantic colors, persistence, appearance reset and reduced motion');

  await employee.route('**/api/auth/me', route => route.abort());
  await employee.reload();
  await employee.getByRole('heading', { name: 'Could not load the workspace' }).waitFor();
  await employee.locator('.workspace-overlay').waitFor({ state: 'detached' });
  await employee.unroute('**/api/auth/me');
  await employee.getByRole('button', { name: 'Try again' }).click();
  await employee.locator('.metric').first().waitFor();
  await employee.locator('.workspace-overlay').waitFor({ state: 'detached' });
  await employee.setViewportSize({ width: 320, height: 640 });
  const token = await employee.evaluate(() => localStorage.getItem('aegis_token'));
  await trigger.click();
  await panel.getByRole('button', { name: 'Sign out', exact: true }).click();
  const logout = employee.getByRole('dialog', { name: 'Sign out?' });
  const dialogBounds = await logout.boundingBox();
  assert.ok(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 320);
  await logout.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await employee.evaluate(() => localStorage.getItem('aegis_token')), token);
  await trigger.click();
  await panel.getByRole('button', { name: 'Sign out', exact: true }).click();
  await logout.getByRole('button', { name: 'Sign out', exact: true }).click();
  await employee.waitForURL('**/#/login');
  assert.equal(await employee.evaluate(() => localStorage.getItem('aegis_token')), null);
  assert.equal((await employee.request.get(url + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status(), 401);
  await employee.goto(url + '/#/profile');
  await employee.waitForURL('**/#/login');
  console.log('PASS dashboard refresh loader, startup recovery, and mobile sign-out dialog with session revocation');

  assert.deepEqual(errors, []);
  console.log('PASS no client exceptions or HTTP 5xx responses');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  app.close();
}
