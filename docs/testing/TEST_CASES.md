# BITS IT Support test cases

Each case points to the assertion or browser workflow used to exercise it. Some tests cover more than one case.

| ID | Scenario | Input or precondition | Expected result | Coverage |
| --- | --- | --- | --- | --- |
| TC-01 | Employee registration | Fresh account and a public privileged-role request | Create an employee and reject the privileged role | [core.test.js:111](../../backend/test/core.test.js#L111) |
| TC-02 | Duplicate registration | Existing demo email | Duplicate is rejected | [core.test.js:119](../../backend/test/core.test.js#L119) |
| TC-03 | Valid login | Seeded employee credentials | Issue an opaque session for the employee | [core.test.js:125](../../backend/test/core.test.js#L125) |
| TC-04 | Invalid login | Correct email and wrong password | Return an authentication error | [core.test.js:125](../../backend/test/core.test.js#L125) |
| TC-05 | API access | Unauthenticated call to protected incidents | Reject the request | [core.test.js:386](../../backend/test/core.test.js#L386) |
| TC-06 | Incident privacy | Another reporter's incident | Deny access | [core.test.js:197](../../backend/test/core.test.js#L197) |
| TC-07 | Create critical incident | Payment service, impact 3, urgency 3 | Persist P1, technician, SLA and side effects | [core.test.js:183](../../backend/test/core.test.js#L183) |
| TC-08 | Invalid incident | Fractional affected-user count | Reject without writing a row | [core.test.js:36](../../backend/test/core.test.js#L36) |
| TC-09 | Explainable priority | High and low scoring fixtures | Correct P1/P4 plus score and reasoning | [core.test.js:134](../../backend/test/core.test.js#L134) |
| TC-10 | Priority validation | Input outside range 1–3 | Return validation error | [core.test.js:143](../../backend/test/core.test.js#L143) |
| TC-11 | Skill strategy | Available technician with matching skills | Prefer the matching specialist | [core.test.js:165](../../backend/test/core.test.js#L165) |
| TC-12 | Least-loaded strategy | Several eligible technicians | Prefer smallest active queue; deterministic tie-break | [core.test.js:174](../../backend/test/core.test.js#L174) |
| TC-13 | Availability | Unavailable candidates | Exclude unavailable technicians | [core.test.js:44](../../backend/test/core.test.js#L44) |
| TC-14 | Capacity | Remaining candidate has capacity zero | Leave incident unassigned and notify admins | [core.test.js:44](../../backend/test/core.test.js#L44) |
| TC-15 | Full lifecycle | Assigned technician and owning reporter | Reach CLOSED through valid actions | [core.test.js:215](../../backend/test/core.test.js#L215) |
| TC-16 | Invalid lifecycle | Action skips required states | Reject with lifecycle error | [core.test.js:206](../../backend/test/core.test.js#L206) |
| TC-17 | Response SLA | Create P2 and P3 incidents | Deadlines are creation +15/+60 minutes | [core.test.js:56](../../backend/test/core.test.js#L56) |
| TC-18 | Resolution SLA | Create P2 and P3 incidents | Deadlines are creation +120/+480 minutes | [core.test.js:56](../../backend/test/core.test.js#L56) |
| TC-19 | Record SLA breach | Seeded response-overdue P1 | Persist response violation | [core.test.js:241](../../backend/test/core.test.js#L241) |
| TC-20 | Deduplicate breach | Run monitor again | No duplicate response breach | [core.test.js:241](../../backend/test/core.test.js#L241) |
| TC-21 | Notification channels | Seed creates/assigns incidents | In-app entry and simulated email retained | [core.test.js:102](../../backend/test/core.test.js#L102) |
| TC-22 | Audit creation | Create a report | Audit history includes workflow events | [core.test.js:183](../../backend/test/core.test.js#L183) |
| TC-23 | Similar duplicate | Closely matching active payment report | Return scored match | [core.test.js:155](../../backend/test/core.test.js#L155) |
| TC-24 | False positive and privacy | Unrelated same-service text and another reporter | Reject unrelated and private candidates | [core.test.js:68](../../backend/test/core.test.js#L68) |
| TC-25 | Category suggestion | Network keywords | Return Network and explanation | [core.test.js:147](../../backend/test/core.test.js#L147) |
| TC-26 | Strategy configuration | Admin changes selection | Read the persisted new key | [core.test.js:252](../../backend/test/core.test.js#L252) |
| TC-27 | Admin RBAC | Employee attempts technician edit | Reject operation | [core.test.js:261](../../backend/test/core.test.js#L261) |
| TC-28 | Restart persistence | Create and reopen a file-backed database | Retain the original incident | [core.test.js:372](../../backend/test/core.test.js#L372) |
| TC-29 | Escalation | Seeded overdue payment incident | Show persisted escalation in admin browser view | [browser smoke](../../scripts/browser-smoke.mjs) |
| TC-30 | Compound filtering | Search plus overlapping filters | Return only matching rows | [core.test.js:272](../../backend/test/core.test.js#L272) |
| TC-31 | Resolution rejected | Reporter declines a response | Return to investigation with archived prior resolution | [core.test.js:78](../../backend/test/core.test.js#L78) |
| TC-32 | Report filters | Category, UTC dates, malformed date | Limit rows and reject invalid dates | [core.test.js:94](../../backend/test/core.test.js#L94) |
| TC-33 | Service dependency cycles | Add a cyclic service dependency | Reject the edge | [core.test.js:363](../../backend/test/core.test.js#L363) |
| TC-34 | Investigation collaboration | Technician note and employee comment | Retain both messages | [core.test.js:229](../../backend/test/core.test.js#L229) |
| TC-35 | Feedback | Submit feedback twice after closure | Persist once | [core.test.js:355](../../backend/test/core.test.js#L355) |
| TC-36 | Report aggregation | Read report against seeded dataset | Metrics match stored records | [core.test.js:281](../../backend/test/core.test.js#L281) |
| TC-37 | Larger reports | More than 100 incidents in scope | Aggregate all matching records while applying role scope | [Trend regression](../../backend/test/core.test.js#L290) |
| TC-38 | Duplicate settings | Duplicate service or category at create or rename | Return HTTP 409 and preserve rows and audit counts | [Conflict tests](../../backend/test/core.test.js#L318) |
| TC-39 | Disabled account edit | Save a name change on a disabled account | Preserve disabled status and show unsupported fields as read-only or omit them | [Edge admin edit](../../scripts/browser-smoke.mjs#L235) |
| TC-40 | Form boundaries | Enter a long title and inspect register search hint | Enforce 160 characters and name only searchable fields | [Edge form checks](../../scripts/browser-smoke.mjs#L259) |
| TC-41 | Smart Fix ranking | Normalize symptom variants and compare historical fixes | Rank relevant fixes and enforce stable ties and result limit | [Matcher tests](../../backend/test/automation.test.js#L23) |
| TC-42 | Smart Fix fallback | No accessible strong match | Show labelled curated guidance for authorized staff | [Fallback test](../../backend/test/automation.test.js#L91) |
| TC-43 | Smart Fix privacy | Try two incident scopes and sensitive free text | Enforce both scopes and return filtered resolution snippets | [Privacy test](../../backend/test/automation.test.js#L103) |
| TC-44 | SLA boundary | Tick up to and across a response target | Distinguish approaching, due now and overdue | [Response risk test](../../backend/test/automation.test.js#L129) |
| TC-45 | Rescue ranking | Mix overdue, P1, approaching and on-track incidents | Order by risk and urgency | [Rescue sort](../../backend/test/automation.test.js#L199) |
| TC-46 | Rescue reminder | Attempt unauthorized, stale and repeated reminders | Enforce role and active target, then write one audit and both channels | [Reminder API](../../backend/test/automation.test.js#L223) |
| TC-47 | Server-time countdown | Skew the browser clock against the server | Show deadline time from the server reference | [Edge clock regression](../../scripts/browser-smoke.mjs#L394) |
| TC-48 | Sign-out | Cancel, then confirm sign-out | Retain the session on cancel and revoke its token on confirm | [Edge logout](../../scripts/browser-smoke.mjs#L501) |

Results are recorded in [TEST_RESULTS.md](TEST_RESULTS.md).
