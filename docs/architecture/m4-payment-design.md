# M4 mock payment and contact-delivery design

## Transaction model

PostgreSQL remains the fact source. Every user write uses the existing encrypted idempotency
service at serializable isolation; a retry re-reads the round, group, membership, consent,
verification, contact presence, and all order facts. The M4 mock gateway is deterministic and
side-effect free, so its local identifier derivation may run during that transaction without
contacting an external system. M5 must perform real provider calls outside database transactions,
then verify and reconcile the provider callback/query response through a durable payment fact.
Prepay creates only an internal pending intent; a dedicated development/test endpoint submits a
settlement fact. M5 will replace that adapter without changing the order or delivery aggregate API.

`ServiceOrder` is opened only for a `PAYING` member whose order expiry equals the round's `payBy`.
The API owns `amountFen=99`, `currency=CNY`, `pricingVersion=m4-99-fen-v1`, merchant order number,
and provider selection. The mini-program never receives a generic state-transition endpoint.

## Delivery and compensation

On each successful mock settlement the service records one `PaymentTransaction` and advances the
owned order monotonically. The final paid member invokes a serializable all-member delivery check.
It locks the round/group state, verifies every member/order/consent/contact, creates all directed
`ContactUnlock` rows, marks delivered order/member state, and changes group/round state together.
Any failure before commit rolls back the whole delivery; no row implies a contact was delivered.

Pre-delivery invalidation (payment deadline, revoked consent, failed eligibility/contact check)
uses a separate frozen compensation state. It closes unpaid orders and creates full refund work for
each paid order, then a worker performs mock refunds. Until all refunds are terminally successful,
the original snapshot remains non-joinable and non-readable. Refund failure remains in
`REFUND_RETRY`; a retry is idempotent and cannot reopen recruiting.

## Contact confidentiality

Contact ciphertext is read only after the complete read authorization decision succeeds. The
service decrypts the current member set only in process memory, returns other members' WeChat IDs,
and writes a request-scoped access log with a sorted-subject SHA-256 digest rather than addresses.
Success is all-or-nothing. A later consent revocation does not claim to retract already displayed
plaintext, but it makes every future group contact read fail and log a denied attempt.

## PostgreSQL last-line guards

The M4 additive migration adds state-aware triggers that reject direct order creation outside a
matching `PAYING` round/group/member, and direct contact-unlock insertion without a delivered
round and active matching member pair. Application services remain responsible for the richer
cross-order/consent/contact checks, but a regression cannot turn an arbitrary database insert into
an unlock or chargeable order.

## Explicit non-goals

M4 contains no real payment credential, signing key, Webhook verification, external settlement,
bank/card details, driver, vehicle, taxi fare, actual carpool fare split, location trace, or
transport fulfilment state. Those remain outside the platform boundary or belong to M5.
