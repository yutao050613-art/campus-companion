# M4 payment, refund, and contact-delivery invariants

## Scope and security boundary

M4 consumes only an existing `PAYING` round created by M3. The price is server-owned and fixed at
99 fen per independently authenticated account. It validates a mock payment gateway in development
and test only; a client-side success result is never a payment fact. Real WeChat Pay API v3 signing,
certificate verification, callback decryption, reconciliation, and merchant credentials remain M5.

## Required invariants

1. **INV-007 — one server-priced order:** only a current `PAYING` snapshot member may create or
   retrieve its own order; there is at most one order per `(roundId, userId)`, its amount is exactly
   99 fen/CNY, its expiry is the locked `payBy`, and no client field selects amount, currency,
   provider, price version, payment status, or target state.
2. **INV-008 — atomic all-member delivery:** `ContactUnlock` rows can be created only inside one
   serializable transition where the group and round are still `PAYING`, every locked member is
   active and eligible, every snapshot member has exactly one `PAID` order, all contact consents
   match the locked policy and are unrevoked, and every member has a stored encrypted WeChat ID.
   The transition writes the complete directed member-pair set, moves the round to `DELIVERED`, the
   group to `CONTACTS_UNLOCKED`, and marks the orders/members delivered together.
3. **INV-009 — private all-or-nothing reads:** a viewer may read only a current unlocked round in
   their campus. Before decrypting any contact, the server rechecks all unlock pairs, membership
   snapshot, round policy, unrevoked consent, and subject contact presence. It returns every other
   member or none, and appends exactly one `ContactAccessLog` with the policy version and
   normalized subject-set digest for every result, including denial.
4. **INV-010 — monotonic payment and refund facts:** each mock provider transaction/refund ID is
   unique and an immutable order/refund fact. Duplicate, stale, or out-of-order mock settlement and
   refund calls are idempotent; they neither duplicate a charge/refund nor regress `PAID`,
   `DELIVERED`, `REFUNDED`, or `REFUND_FAILED`.
5. **INV-015 — compensation before reuse:** a payment deadline, pre-delivery consent revocation,
   failed eligibility check, or delivery failure atomically freezes the round/group as `REFUNDING`,
   closes unpaid orders, creates a full 99-fen refund task for every paid order, and prevents join,
   leave, new orders, contact unlock, and contact reads. Only after every refund succeeds may the
   old round be invalidated and removed members return to a newly recomputed recruitable group.
6. **INV-016 — mock cannot escape its environment:** every mock create, settle, query, and refund
   path requires `NODE_ENV` to be `development` or `test`. Staging and production reject mock
   payment configuration and endpoints before any money-like record is changed. No mock token,
   plaintext WeChat ID, encryption key, or provider payload appears in logs, errors, outbox data,
   audit details, or idempotency plaintext.

## Abuse cases and required failures

| Abuse or failure | Required result |
|---|---|
| Client sends 1 fen, altered currency, `PAID`, refund status, or someone else's order ID | validation/ownership failure; no state change |
| Replay the same create/prepay/mock-settle key or mock provider ID | same stored response/fact only; no duplicate transaction |
| Concurrent final two payments | one serializable delivery transition; complete pair set once; no partial unlock |
| One member fails or does not pay by `payBy` | nonpayer removed, all paid orders enter full refund; old round remains frozen until compensation finishes |
| Consent is revoked before delivery while a payment settles | refund freeze wins or delivery commits with a valid snapshot; no mixed partial disclosure |
| Revoke consent after delivery | future reads are denied as a whole; prior plaintext is not claimed to be retractable |
| Unverified/restricted/expired member, missing contact, or cross-campus record appears at delivery | no contact is decrypted; all paid orders are compensated |
| Retry/refund callback arrives after success or delivery | terminal state never regresses; no second refund record |
| Direct database insert tries to create an order/unlock outside valid state | additive PostgreSQL trigger rejects it |
| Mock endpoint is reached in staging/production | fail closed before provider or database effects |
| Response/log scan finds plaintext WeChat ID, mock secret, payment token, driver, vehicle, fare, or location | milestone fails |

## Mandatory verification

- Domain branch coverage stays at least 90%; API branch coverage stays at least 80%.
- M4 native PostgreSQL tests repeat concurrent final-payment/delivery, timeout/refund, and
  consent-revocation races at least 20 times each.
- Failure injection covers mock payment failure, mock refund failure/retry, transaction rollback,
  missing contacts, expired verification, and duplicate/out-of-order facts.
- Native tests prove an unauthorized user never sees contacts and an authorized response contains
  only other members' decrypted WeChat IDs after all delivery conditions pass.
- The additive M4 migration is applied on a fresh database and an M1+M2 snapshot; released M1 and
  M2 migration raw-byte digests remain unchanged.
- A dedicated M4 workflow saves raw logs, JSON test reports, result assertions, and a raw-byte
  SHA-256 manifest for 30 days.
