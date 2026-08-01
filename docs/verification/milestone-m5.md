# M5 verification report: WeChat Pay protocol and trust safety

- Date: 2026-08-02 (Asia/Shanghai)
- Branch: `agent/m5-wechat-risk`
- Base accepted main commit: `7bdbcdc81f3f14a42e2a910ab3ddda1442e195b7`
- Accountable owner and final approver: Cedric
- Status: **OFFLINE IMPLEMENTATION VERIFIED; LIVE MERCHANT EXECUTION PENDING**

This is a candidate verification report, not an acceptance record. It preserves the mandatory pause
in [the M5 entry approval](m5-entry-approval.md): M5 cannot be marked finally accepted and M6
cannot begin before real test-merchant evidence is collected and approved.

## Delivered scope

- `@campus/payments` now provides a deliberately bounded WeChat Pay API v3 protocol client:
  exact request signing, signed-response verification, public-key-ID selection, authenticated
  callback-resource decryption, JSAPI prepay/query and refund/query construction. Its production
  transport has a fixed HTTPS host, certificate verification, no ambient proxy agent, a 1 MiB
  response cap, and bounded timeouts.
- Callback ingress verifies strict UTF-8 bytes and the provider signature before decrypting or
  parsing content. A signed provider fact is committed before any payment/refund state changes.
- PostgreSQL now has immutable `ProviderEvent` facts and tenant-bound reconciliation exceptions.
  Triggers reject mismatched amount, currency, order, refund, provider-event, and terminal-state
  relationships even when an application caller is bypassed.
- Replayed provider event IDs with a different digest are atomically moved from `RECEIVED` to
  `REVIEW_REQUIRED`, so a later replay cannot settle payment or disclose contacts. A durable
  reconciliation exception retains only digests, never raw callback content.
- Refund-success processing recovers an invalidated formation through the shared worker/API
  recovery function; it cannot create a second disclosure.
- Verified students can report group members and block future matching. Reports use a durable
  five-per-hour limit, omit free-text evidence from the outbox, and bilateral blocks are checked
  before joining or starting a formation.
- Safety reviewers require campus-scoped RBAC, CSRF protection, idempotency and audit logging.
  Restrictions hold pre-delivery groups, dispute post-delivery groups, and preserve the existing
  refund path for paid rounds.
- `m5-quality.yml` supplies the dedicated CI quality gate and retains checksum evidence for the
  M5 documentation, migration, protocol and native test assets.

## Verification evidence

| Gate | Result | Evidence |
|---|---|---|
| Aggregate quality gate | Pass | `pnpm check` completed on 2026-08-02 in 258 seconds against PostgreSQL and Redis, including M0–M5 verifiers, static security scan, type checks, builds, tests and coverage. |
| M5 structural verifier | Pass | `pnpm verify:m5`: 86 passed, 0 failed. |
| Migration status | Pass | `pnpm db:status`: four migrations found; local PostgreSQL schema is up to date. |
| Full API coverage | Pass | statements 87.98% (1479/1681), branches 80.03% (1050/1312), functions 95.10% (350/368), lines 90.35% (1386/1534). |
| WeChat protocol tests | Pass | 18 tests cover signing, public-key verification, strict parsing, decrypt failures, fixed-host transport, oversized/malformed replies, ambiguous outcomes, prepay and refund request construction. |
| Native M5 payment safety | Pass | 2 PostgreSQL tests, including 20 repetitions of duplicate ingress/application races, conflicting replay review, late/unknown/amount/membership/duplicate facts, and refund recovery without a second disclosure. |
| Added digest-conflict regression | Pass | Unit and native tests prove a pre-application conflicting replay transitions the provider event to `REVIEW_REQUIRED` and creates no successful payment transaction. |
| M4 compatibility | Pass | M4 verifier and immutable historical migration checks passed as part of `pnpm check`; the M5 supersession ledger records every intentionally changed M4 baseline surface. |
| Formatting and diff integrity | Pass | `biome ci .` completed with no errors; `git diff --check` completed with no whitespace errors. Existing repository informational suggestions do not fail the gate. |
| Dependency vulnerability audit | Pass | `pnpm audit --audit-level high --json`: 0 vulnerabilities across 275 dependencies. |
| Secret/log review | Pass | A tracked-source scan found no private-key literal, populated payment secret, or M5 callback console logging. Configuration keeps callbacks disabled by default and outbound WeChat payment fail-closed. |

## Live-provider boundary

No real WeChat Pay request, refund, callback registration, or merchant-console operation was made.
`PAYMENT_PROVIDER=wechat` remains fail-closed, and callbacks are disabled unless explicit
credential configuration is present. That is intentional: the repository contains no merchant
secret, certificate, OpenID acquisition path, externally reachable HTTPS callback URL, or
authorised merchant-test environment.

Before final M5 acceptance, the responsible operator must provide the secret-manager-backed test
merchant prerequisites listed in [m5-entry-approval.md](m5-entry-approval.md), then collect
auditable evidence for all of the following without placing any secret in Git or chat:

1. JSAPI test payment creation and signed response validation;
2. provider query after a deliberately ambiguous transport outcome;
3. signed payment callback and duplicate/late callback handling;
4. refund request, signed refund callback, and merchant-console reconciliation;
5. a negative signature/key-rotation drill and a callback reachability test;
6. protected GitHub CI for the eventual M5 pull request.

## Remaining acceptance gate

The offline M5 implementation is ready for review, but final acceptance is **not yet requested**.
Keep M6 blocked until the merchant test conditions and protected-CI evidence above are complete,
then obtain Cedric's explicit M5 acceptance and merge approval.
