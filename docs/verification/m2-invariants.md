# M2 invariants and abuse cases

## Identity and sessions

1. A simulated WeChat code is single-use. Reuse, including concurrent reuse, creates no second
   session and returns the same generic authentication failure.
2. The simulator is impossible to enable in staging or production.
3. Access tokens are signed, short-lived, issuer/audience bound, and include a session identifier.
4. Refresh tokens contain a public session identifier and a high-entropy secret. Only a SHA-256
   digest is stored. Rotation is compare-and-swap; replay revokes the current token family.
5. Restricted, deletion-pending, deleted, expired-session, and revoked-session principals receive no
   authenticated capability.
6. Student and administrator token namespaces, signing context, cookies, and routes are disjoint.

## Student verification

1. Student numbers are normalized only for surrounding whitespace and ASCII case, then stored as a
   keyed HMAC digest plus the final four alphanumeric characters. Plain student numbers are never
   stored or logged.
2. A campus/student-number digest pair is unique. Concurrent duplicate submissions yield one draft.
3. New drafts are `AWAITING_UPLOAD`. Each draft has one or two uniquely typed assets:
   `STUDENT_CARD`, `WECOM_SCREENSHOT`, or both. Submission requires at least one asset and an
   unexpired server-issued upload grant plus server-side metadata/digest/type/size checks for every
   submitted asset.
4. Upload expiry never produces `PENDING`; it produces `UPLOAD_EXPIRED`, makes the object unreadable,
   and schedules deletion.
5. Review transitions follow the documented state machine. Approval always has a finite credential
   expiry. Rejection and resubmission always carry a bounded reason code.
6. A submitted asset has no deletion deadline while its verification is reviewable. Review
   atomically changes status, sets each current asset deadline to `reviewedAt + 24 hours`, enqueues
   deletion events, and appends an audit record. An audited exception may extend retention, but the
   exceptional material deadline must not exceed seven days after review.
7. Material metadata returned to ordinary users and list/detail administration endpoints never
   contains an object key, filesystem path, storage URL, student-number digest, or contact value.

## Administrator security

1. Passwords use versioned Argon2id PHC strings with a random salt. Authentication errors do not
   reveal whether username, password, TOTP, role, or campus scope failed.
2. A TOTP counter can be consumed only once per administrator and purpose. Adjacent clock windows
   are accepted only within the configured skew and are still replay-protected.
3. Administrator sessions use an opaque `__Host-admin_session` cookie. Only its digest is stored.
4. State-changing administrator requests require a trusted Origin, same-site Fetch Metadata, the
   current CSRF token, an active session, required role, and campus scope.
5. A verification asset grant requires fresh TOTP reauthentication, lasts no more than 60 seconds,
   is bound to administrator/session/campus/verification/exact asset, and is atomically consumable
   once. A grant for one evidence type can never disclose another type.
6. Invalid, expired, replayed, cross-session, cross-campus, deleted-object, and wrong-role asset
   reads all fail closed without disclosing which condition failed.
7. Sensitive reads and all review decisions append an audit event. Audit payloads contain digests,
   never secrets or material locations.

## Failure and leakage assertions

- Database, storage, hashing, encryption, or audit failure rolls back the business transition.
- Object proxy failure after grant consumption never restores the grant.
- Logs and error bodies are scanned for login codes, access/refresh tokens, student numbers,
  passwords, TOTP codes/secrets, CSRF tokens, grant tokens, object keys, and storage paths.
- The released M1 migration is checked by raw-byte SHA-256 in every M2 quality run.
- Permission-matrix, duplicate-identity, expiry-boundary, replay, forged-token, cross-campus,
  cross-account, state-forgery, and deletion tests are mandatory before M2 acceptance.
