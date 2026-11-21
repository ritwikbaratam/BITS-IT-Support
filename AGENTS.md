# BITS IT Support contributor notes

BITS IT Support is a local-first academic project. Keep the application runnable without cloud credentials or paid services.

- Use the Node 24 built-in `node:sqlite` module; do not introduce external runtime packages unless they are genuinely needed.
- Preserve the layers: HTTP controller -> application service -> repository -> SQLite database.
- Keep business rules server-side. The frontend must call real API endpoints rather than inventing dashboard data.
- Use UTC ISO timestamps at rest. The UI may convert them to the viewer's local timezone.
- Seeded credentials and data are development-only. Never treat them as production security.
- Record executed verification in `docs/testing/TEST_RESULTS.md` when a meaningful feature changes.
- Avoid deleting historical incidents, audit events, notifications, or SLA records during ordinary mutations.
- Test with `node --test backend/test` from the repository root when backend tests are available.
