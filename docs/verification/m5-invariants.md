# M5 payment and trust-safety invariants

## Provider authenticity and money state

- **INV-017 Provider authenticity** — No WeChat Pay response or callback affects business state
  until its timestamp window, key ID, SHA256-RSA signature, schema, merchant ID, AppID, merchant
  order number, currency, and server-owned amount are verified.
- **INV-018 Confidential callback processing** — Encrypted callback resources accept only
  `AEAD_AES_256_GCM`; the API v3 key is exactly 32 bytes; plaintext exists only in process memory;
  logs and durable provider-event rows contain bounded identifiers and SHA-256 digests, never the
  callback body or key material.
- **INV-019 Monotonic provider facts** — Payment and refund transitions are monotonic. Duplicate,
  delayed, reordered, or conflicting callbacks cannot move a terminal fact backwards or create a
  second charge/refund/delivery.
- **INV-020 Query-before-ambiguity** — A timeout, transport failure, non-2xx response, or invalid
  response never proves failure. The system queries the provider by its stable merchant order or
  refund number before retrying an external financial operation.
- **INV-021 Reconciliation** — Every provider-success fact must match exactly one internal order or
  refund. Missing, amount-mismatched, duplicate, or state-divergent facts create a reviewable
  reconciliation exception and cannot unlock contacts automatically.
- **INV-022 External calls outside transactions** — Network calls are never made while a database
  transaction is open. A durable intent is committed first; the verified external fact is applied
  in a separate serializable transaction.

## Reports, blocks, rate limits, and holds

- **INV-023 Report association** — A reporter may report only a user or group connected to a
  historical group membership visible to that reporter. Cross-campus, arbitrary-user, duplicate
  abuse, and self-report requests fail without disclosing resource existence.
- **INV-024 Future-match block** — Blocking is campus-scoped, rejects self-blocks, and prevents both
  directions from entering the same future group. It does not rewrite immutable historical groups
  or expose who blocked whom.
- **INV-025 Durable abuse limits** — Join, unlock, report, and payment-abandonment limits use
  versioned rules and server time. Concurrent requests cannot exceed a limit by racing independent
  application instances.
- **INV-026 Explainable risk holds** — A hold cites a versioned rule and evidence digest, never
  sensitive plaintext. Before contact delivery, a restrictive decision freezes the affected group;
  paid members enter the existing compensation/refund path rather than losing funds silently.
- **INV-027 Appeal-safe release** — Risk release is explicit, audited, and cannot restore an expired
  round or bypass current verification, consent, membership, payment, or block checks.

## Safety boundary

- M5 introduces no driver, vehicle, dispatch, actual ride fare, route tracking, in-transit,
  arrival, or transport-completion state.
- Mock payment remains available only in development and test. Real-provider mode fails closed
  unless every required credential and verifier is configured.
- Sensitive configuration is referenced by environment/secret-manager handles. It is never stored
  in source control, verification baselines, test snapshots, or CI artifacts.

