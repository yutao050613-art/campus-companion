# M5 WeChat Pay and trust-safety design

## Protocol boundary

`@campus/payments` owns protocol construction and verification but has no database dependency. The
API and worker inject an HTTP transport so unit tests use generated RSA keys and deterministic
responses without contacting WeChat Pay. Production uses the same verifier and DTO validation with
credentials loaded from a secret manager or mounted read-only files.

The implementation follows WeChat Pay API v3's RSA mode:

1. A merchant request signs `method + "\n" + canonical request target + "\n" + timestamp +
   "\n" + nonce + "\n" + exact body + "\n"` with SHA256-RSA and identifies the merchant
   certificate serial in `Authorization`.
2. Every API response and callback is verified before JSON is trusted, using the exact
   `Wechatpay-Serial` public-key ID and `timestamp + "\n" + nonce + "\n" + body + "\n"`.
3. Callback resources accept only `AEAD_AES_256_GCM` and decrypt with the 32-byte API v3 key,
   resource nonce, and associated data.
4. JSAPI client parameters are signed by the server. A mini-program success callback is UI-only
   and never becomes a settlement fact.

New integrations use the WeChat Pay public-key mode rather than treating a long-lived platform
certificate as permanently pinned. Key rotation is an atomic configuration change: an unknown key
ID fails closed; overlap is represented as an explicit bounded verifier set.

Official protocol references:

- <https://pay.wechatpay.cn/doc/v3/merchant/4012081606>
- <https://pay.wechatpay.cn/doc/v3/merchant/4012365342>
- <https://pay.wechatpay.cn/doc/v3/merchant/4012071382>
- <https://pay.wechatpay.cn/doc/v3/merchant/4013071031>

## Durable payment workflow

```text
database intent committed
  -> external prepay/query/refund call (no database transaction)
  -> response signature and schema verified
  -> provider fact applied in a new serializable transaction
  -> contact delivery or refund compensation re-evaluates all M4 invariants
```

A provider-event inbox uniquely binds notification ID, event type, key ID, merchant order/refund
number, provider transaction/refund number, and ciphertext/body digest. Replays with the same
identity and digest return success. Reuse with a different digest is a security conflict and enters
manual review. Raw provider payloads are not retained.

Ambiguous external outcomes are never blindly retried. The worker queries the stable merchant order
or refund number, verifies the response, and then either applies the fact, schedules a bounded
retry, or creates a reconciliation exception. Daily reconciliation compares provider-success facts
against internal orders/refunds and cannot itself unlock contacts unless the ordinary delivery
transaction still passes.

## Trust-safety workflow

Blocking is an immediate, reversible future-match exclusion. Reporting is a separate, immutable
event tied to a group relationship; it may create a versioned risk event but never exposes reporter
identity to the subject. Rules cover repeated payment timeout, daily contact unlock volume,
same-preference concentration, and corroborated reports. Counters are durable and updated
atomically using server time.

Before delivery, a restrictive decision transitions the group to `RISK_HOLD`. If money has already
settled, the existing M4 refund-compensation workflow owns recovery. After delivery, a valid report
may transition the group to `DISPUTED`, revoke future access, restrict future matching, and open an
appeal/review record; it cannot claim to retract plaintext already shown.

## Failure and logging rules

- No private key, API v3 key, Authorization header, decrypted resource, OpenID, WeChat ID, or raw
  provider body is logged.
- Signature, key-ID, timestamp-window, merchant, AppID, amount, currency, and state mismatches are
  security failures, not retryable business errors.
- Transport failures and 5xx responses are ambiguous and require provider query before retry.
- Provider 4xx responses are recorded as bounded codes and reviewed according to official guidance;
  secrets and response bodies stay out of logs and audit rows.
- Circuit breaking limits outbound pressure but never changes a financial fact.
