# BITS IT Support verification

## 22 November 2026 IST

Verification ran on Windows with Node.js 24.18.0, its bundled SQLite 3.53.1, and Microsoft Edge through Playwright Core.

| Check | Observed result |
| --- | --- |
| `node --test backend/test` | **56 passed**, 0 failed, 0 cancelled, 0 skipped. |
| `npm.cmd run check` | Exit 0. All listed application JavaScript files passed the syntax check. |
| `node scripts/browser-smoke.mjs` | **17 groups passed**, 0 failed. The suite observed no client exceptions or HTTP 5xx responses. |
| Fresh proposed checkout | Both startup scripts launched from a temporary copy of the retained tree. The PowerShell start initialized a fresh SQLite file, served the branding assets, seeded sample records, and accepted all three role logins. The POSIX script was exercised using Git sh on Windows. |
| Isolated two-process restart | The second process reopened that SQLite file and returned the created incident, its technician assignment, and its audit record. The seed count stayed stable after restart. |
| Supplemental HTTP check | Eight combined register criteria returned the expected incident. The employee session received HTTP 403 on an administrator route. |
| Documentation | Five Mermaid diagrams rendered in Edge. The ER diagram matched all 18 SQLite tables and 26 foreign-key relationships. Relative links and all six screenshot paths resolved. |

The [test cases](TEST_CASES.md) map coverage for authentication and authorization, lifecycle transitions, classification and priority, both assignment strategies, notifications and audit history, deadline boundaries, Smart Fix and SLA Rescue. Stabilization checks cover protected disabled accounts, unsupported edit fields, duplicate-name conflicts, trend totals above 100, server-time countdowns, and search and title input behavior.

Edge coverage includes the three role workflows, SLA filters, appearance, sign-out, mobile navigation, and responsive checks at 320, 390, 768, 1120, and 1440 pixels. The checks use isolated SQLite databases. See the [README](../../README.md#testing-and-verification) for commands.

## Historical evidence

Earlier isolated restart checks confirmed persisted closure and verification audits, response breach history, Smart Fix recommendations, and reminder deduplication. The current results above supersede the earlier suite totals.
