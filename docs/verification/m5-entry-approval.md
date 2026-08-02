# M5 entry approval

Date: 2026-08-01 (Asia/Shanghai)

Status: **APPROVED FOR OFFLINE IMPLEMENTATION; MERCHANT TEST EXECUTION PENDING**

Accountable approver: Cedric

Accepted M4 main commit: `7bdbcdc81f3f14a42e2a910ab3ddda1442e195b7`

Approval statement recorded in the project conversation:

> M4 已验收并合并完成。可以开始 M5；开始 M5。

## Entry evidence

- Pull request #9 was squash-merged into protected `main` at the accepted commit.
- The required `quality-gates`, `m3-quality-gates`, and `m4-quality-gates` completed successfully.
- M4 is the released mock-payment and contact-delivery baseline; its migration and historical
  milestone baselines remain immutable.
- M5 work is isolated on `agent/m5-wechat-risk` and starts from the accepted commit above.

## M5 scope

M5 may implement:

- WeChat Pay API v3 request signing and response/callback verification;
- JSAPI prepay, merchant-order query, refund submission/query, callback decryption, and
  reconciliation;
- provider-event idempotency and monotonic payment/refund transitions;
- reports, bilateral future-match blocking, durable rate limits, versioned risk events, holds,
  review, and appeal-safe release;
- M5-specific migrations, OpenAPI updates, negative/concurrency tests, CI evidence, and a final
  verification report.

M5 does not add drivers, vehicles, dispatch, transport fares, location tracking, ride fulfilment,
or any promise that the platform transports passengers. The 99-fen charge remains an information
service fee owned by the server.

## Merchant-test condition

The roadmap requires merchant test conditions before real-provider execution. No credential value
may be committed, printed in logs, included in an artifact, or pasted into an approval record.
Before any live request, the responsible operator must confirm through secret-presence checks that
the isolated test environment has all of the following:

- a test-capable merchant ID and mini-program AppID bound for JSAPI payment;
- a merchant API certificate serial and private key supplied by a secret manager;
- a 32-byte API v3 key supplied by a secret manager;
- the configured WeChat Pay public-key ID and public key used for response/callback verification;
- HTTPS payment and refund notification endpoints reachable by WeChat Pay;
- a designated owner who can inspect the merchant console and stop payment tests.

Machine-readable status:

- `M4AcceptedMain: 7bdbcdc81f3f14a42e2a910ab3ddda1442e195b7`
- `M5OfflineImplementation: APPROVED`
- `MerchantTestConditions: PENDING_CONFIRMATION`
- `LiveProviderCalls: FORBIDDEN_UNTIL_CONFIRMED`
- `M5FinalAcceptance: PENDING`

## Mandatory pause

M5 must pause after local and protected-CI evidence. It cannot be marked PASS and M6 cannot start
until test-merchant signing, verified response handling, callback decryption, order query, refund,
reconciliation, duplicate/late notification handling, and failure drills have auditable evidence.
