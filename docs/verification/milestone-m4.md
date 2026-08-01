# M4 verification report: mock payment, refund, and contact delivery

- Date: 2026-08-01 (Asia/Shanghai)
- Branch: `agent/m4-payment-contact`
- Base accepted main commit: `c9c773dba37e99efe48d31a7af714562cd5de742`
- Accountable owner and final approver: Cedric
- Scope: mock-only 99-fen information-service payment, all-member contact disclosure, payment-expiry/refund compensation, and gated mini-program flow.

## Design and security decisions

- The API, not the client, creates exactly one 99-fen CNY service order per eligible account in a locked M3 `PAYING` round.
- PostgreSQL triggers reject direct service-order creation outside a matching paying member/round/group and reject direct contact unlocks before a delivered matching pair exists.
- The M1 `PaymentTransaction_occurred_check` constraint is removed additively in M4 because an independently timestamped provider event can legitimately precede the database receipt write; retaining it rejects valid receipts under ordinary network latency.
- Payment/deadline/consent state changes run at serializable isolation. Both Prisma serialization failures and PostgreSQL deadlocks (`40P01`) retry with bounded backoff.
- A contact read is evaluated as one serializable decision. A no-order M3 group remains indistinguishable from a missing contact resource; an M4 group that has entered payment/refund recovery returns a stable non-disclosure denial. The denial is written after the decision transaction so its audit row is not rolled back together with the deliberate 409 response.
- Before-delivery consent withdrawal removes unpaid members from the frozen round, reopens their demands, creates full refunds for every paid order, and prevents contact delivery until the worker completes compensation.
- The mock gateway is deterministic and has no external side effect. It is rejected outside development/test. Real WeChat Pay remains explicitly unavailable until M5.

## Verification evidence

| Gate | Result | Evidence |
|---|---|---|
| API/worker/package/database type checks | Pass | `pnpm typecheck`; Prisma schema validation and client generation completed on 2026-08-01 |
| M4 controller DTO tests | Pass | Server-owned price, constrained mock intent, contact/consent routes |
| Full API coverage, including native PostgreSQL | Pass | 97 tests; statements 89.55%, branches 80.87%, functions 95.43%, lines 92.08% |
| Native M4 API | Pass from a fresh migration chain | 4 tests: 20 concurrent final-payment deliveries, forgery/replay, post-delivery revocation denial audit, 20 settlement/revocation races |
| Native M4 worker | Pass from a fresh migration chain | 1 test repeats 20 payment-timeout/refund/recovery cycles and covers retry/manual-review paths |
| Native PostgreSQL inventory | Pass from a fresh migration chain | 4 tests confirmed M4 trigger/function inventory and direct-insert guards |
| Fresh database migration chain | Pass | Empty `campus_companion_m4_fresh`: 3 migrations applied, repeat deploy reported no pending migrations, schema status up to date |
| Lint | Pass | `pnpm lint` completed with 0 errors; the repository retains 64 pre-existing informational suggestions |
| OpenAPI lint | Pass | `pnpm api:lint` validated `docs/api/openapi.yaml` |
| Static security scan | Pass | `pnpm security:static` checked 55 source files with 0 violations |
| Aggregate quality gate | Pass | `pnpm check` completed against the fresh M4 database in 210.2 seconds; it includes M0–M4 verification, builds, type checks, coverage gates, lint and static security scanning |
| Dependency audit | Pass | `pnpm audit --audit-level high --json` reported 0 vulnerabilities across 275 dependencies |
| GitHub CI | Pending pull request | The required remote quality gate must pass after the draft PR is opened; this is not a substitute for the recorded local evidence |

## CI portability remediation

The first remote execution of PR #9 passed the dedicated `verify-m4` workflow, but the inherited `verify` and `verify-m3` workflows failed before their native suites. The root cause was a test-runner helper that unconditionally executed Windows `cmd.exe`; GitHub-hosted Linux runners correctly reported `spawnSync cmd.exe ENOENT`.

The remediation keeps the Windows `.cmd` shim path, executes `pnpm` directly on POSIX, preserves the argument allowlist and `shell: false`, and adds unit coverage for Windows, Linux/macOS, non-zero child status, and shell-control input rejection. On 2026-08-01, `pnpm db:status` reported three applied migrations for the fresh `campus_companion_m4_fresh` schema, `pnpm check` completed successfully in 198.4 seconds, and the strengthened M4 verifier reported 242 passed with 0 failures. A new remote execution is required after this remediation is committed and pushed.

## Known limitations and non-goals

- No WeChat Pay API v3 credentials, signing, callback verification, reconciliation, or production payment configuration exists in M4.
- No driver, vehicle, transport order, fare, car-fare split, GPS/location tracking, or platform chat is implemented.
- The local Docker PostgreSQL test database was advanced only for M4 native validation; it contains no user-approved retained data and is not deployment evidence.

## Remaining acceptance gate

The local M4 quality gates and manual diff/security review are complete. The remaining release steps are to commit this isolated M4 change set, open a draft pull request, confirm the required GitHub quality gate, and obtain Cedric's explicit acceptance and merge approval. M5 must not start until that approval and merge are complete.
