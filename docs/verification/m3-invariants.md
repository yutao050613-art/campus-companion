# M3 invariants, abuse cases, and failure conditions

## Scope

M3 implements the free passenger-to-passenger grouping boundary. A demand is always tied to an
enabled, fixed, directional route and one server-recognized time window. A group contains distinct
verified student accounts and one to four occupied passenger seats. It never contains a driver,
vehicle, fare, transport order, live location, or transport-completion state.

## Required invariants

1. **INV-001 — capacity:** each active member contributes one to three seats; the active total is
   one to four. The application checks the total inside a serializable transaction and the released
   database trigger independently serializes on the parent group and rejects a fifth seat.
2. **INV-002 — readiness:** `READY`, `CONFIRMING`, and `PAYING` require at least two distinct active
   accounts and two to four seats. One account requesting two or three seats remains `RECRUITING`.
3. **INV-003 — overlap:** one user cannot hold active membership in two groups whose half-open
   windows overlap. Concurrent publish or join requests must converge to one active membership.
4. **INV-004 — eligibility:** publish, join, start formation, and confirm require an active account
   plus a `VERIFIED` credential whose `expiresAt` is strictly later than the transaction time.
5. **INV-005 — preference:** if any active member requests `SAME_GENDER_ONLY`, every active member
   must have the same declared non-`UNDISCLOSED` gender. Preference checks are symmetric and run
   again before formation starts.
6. **INV-006 — immutable round:** a formation round locks a deterministic member snapshot and
   contact-sharing policy version. `CONFIRMING` forbids join, leave, and demand cancellation. A
   decline or timeout invalidates the round before the group can recruit or confirm again.

## State and deadline rules

- Publishing creates a demand and its initial one-account candidate group atomically.
- Moving that sole membership to another compatible group expires the empty source group.
- `RECRUITING` becomes `READY` only at two or more distinct active accounts; four seats is merely
  the capacity limit and is not required for formation.
- Formation confirmation lasts at most five minutes and never past the route window start.
- `ACCEPT` requires explicit consent to the exact locked contact-sharing policy version.
- All accepts move the round and group to `PAYING`, which is the hand-off boundary to M4. M3 never
  creates service orders, payment transactions, refunds, or contact unlocks.
- A decline removes the declining membership, invalidates the round, revokes round consent, and
  recomputes the group as `RECRUITING`, `READY`, or `EXPIRED`.
- Confirmation timeout keeps the candidate members, invalidates the old round, clears provisional
  confirmations and consent, and recomputes the group. Expired recruiting groups close their open
  demands and cannot be revived.

## Abuse cases and required failures

| Abuse or failure | Required result |
|---|---|
| Client submits a disabled/free-text/cross-campus route or arbitrary window | `400`, `404`, or `409`; no demand |
| Unverified, expired, restricted, or cross-campus account publishes or joins | fail closed; no membership |
| One account requests multiple identities by setting `seatCount` | seats may be 1–3 but account count remains one |
| Two concurrent joins compete for the final seats | at most one commits; active total remains at most four |
| Same user concurrently joins overlapping groups | at most one commits; the retry observes the conflict |
| Member IDs, group IDs, demand IDs, or versions are forged | ownership failure is a generic `404`; no existence leak |
| Unknown gender enters a group constrained to same gender | `GENDER_PREFERENCE_INCOMPATIBLE` |
| Join, leave, or cancel races with formation start | serializable retry converges to either the old member set or a locked round, never a mixed snapshot |
| Confirmation is replayed under another key or policy version | immutable decision conflict; old consent is not replaced |
| Timeout worker replays or runs late | conditional state update is idempotent and cannot invalidate `PAYING` |
| Database or outbox write fails | entire business transition rolls back |
| Response/log scan finds contact, token, student number, material address, driver, vehicle, fare, or location | milestone fails |

## Mandatory verification

- Domain branch coverage is at least 90%; API branch coverage remains at least 80%.
- Unit and integration tests cover every illegal state transition and boundary at 1, 2, 4, and 5 seats.
- Native PostgreSQL tests repeat final-seat and overlapping-membership races at least 20 times.
- Native API tests prove publish, transfer join, formation, consent, decline, and timeout behavior.
- A fresh database applies M1, M2, and no mutable rewrite; M1 and M2 raw migration digests remain
  unchanged.
- A dedicated M3 workflow publishes raw logs, JSON reports, step outcomes, and SHA-256 manifests.

