# M3 free-grouping design

## Transaction boundaries

PostgreSQL remains the sole source of truth. All business writes run through the existing encrypted
idempotency service at `SERIALIZABLE` isolation with bounded retry for Prisma `P2034`. The action
inside a retry contains database work only. The released `enforce_group_seat_limit` trigger is the
last-line capacity guard even if application validation regresses.

The service uses half-open overlap semantics: `[windowStart, windowEnd)`. A retry after a predicate
serialization failure must re-read membership, eligibility, route state, capacity, and preference;
it may not reuse an earlier authorization decision.

## Catalog and window validation

Routes are directional and composed only from stored places. Public catalog reads return active
campuses, active routes, active places, and date-specific windows computed from `RouteSchedule` in
the campus IANA timezone. Demand creation independently converts the submitted UTC timestamps back
to the campus timezone and checks weekday, active dates, slot alignment, and exact duration.

`ROUTE_MANAGER` administrators may create a route from existing same-campus places and bounded
15- or 30-minute schedules. The write requires the existing administrator cookie, trusted origin,
CSRF token, role, campus scope, idempotency key, and an audit record.

## Privacy boundary

Candidate-group responses expose no contact, declared gender, student number, verification material,
or account ID. Each member is represented by a group-scoped anonymous label and membership ID. The
server uses declared gender only inside compatibility checks. Round responses expose only aggregate
member count, the locked snapshot digest, policy version, and deadlines.

## Worker behavior

The worker periodically claims expired `CONFIRMING` rounds and expired `RECRUITING`/`READY` groups
using conditional serializable transactions. It never changes `PAYING`, financial, unlocked, or
disputed states. Replays are no-ops. Outbox records are written in the originating transaction so a
future notification transport can be added without changing the group transition.

## M4 hand-off

After the final acceptance, M3 writes `RoundState.PAYING`, `GroupState.PAYING`, a bounded `payBy`,
and `MemberStatus.PAYMENT_PENDING`. It does not create or simulate money. M4 must consume this exact
state, add orders and mock payments, and implement payment timeout compensation before any contact
can be disclosed.

