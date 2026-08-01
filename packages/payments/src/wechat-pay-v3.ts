import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { request as httpsRequest } from "node:https";

const AUTHORIZATION_SCHEME = "WECHATPAY2-SHA256-RSA2048";
const SIGNATURE_TYPE = "WECHATPAY2-SHA256-RSA2048";
const RESOURCE_ALGORITHM = "AEAD_AES_256_GCM";
const GCM_TAG_BYTES = 16;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;
const WECHAT_PAY_API_HOSTNAME = "api.mch.weixin.qq.com";
const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;

export interface WechatPayV3Credentials {
  readonly merchantId: string;
  readonly appId: string;
  readonly merchantCertificateSerial: string;
  readonly merchantPrivateKeyPem: string;
  readonly apiV3Key: string;
  readonly verifierPublicKeys: ReadonlyMap<string, string>;
}

export interface WechatPaySignatureHeaders {
  readonly signature: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly serial: string;
  readonly signatureType?: string;
}

export interface WechatPayEncryptedResource {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly associated_data?: string;
  readonly original_type?: string;
}

export interface WechatPayNotificationEnvelope {
  readonly id: string;
  readonly create_time: string;
  readonly event_type: string;
  readonly resource_type: string;
  readonly summary: string;
  readonly resource: WechatPayEncryptedResource;
}

export interface MiniProgramPaymentParameters {
  readonly timeStamp: string;
  readonly nonceStr: string;
  readonly package: string;
  readonly signType: "RSA";
  readonly paySign: string;
}

export class WechatPayProtocolError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_CONFIGURATION"
      | "INVALID_REQUEST"
      | "INVALID_SIGNATURE_HEADERS"
      | "UNKNOWN_VERIFIER_KEY"
      | "STALE_MESSAGE"
      | "INVALID_SIGNATURE"
      | "INVALID_RESOURCE"
      | "DECRYPTION_FAILED"
      | "INVALID_PROVIDER_RESPONSE"
      | "AMBIGUOUS_PROVIDER_OUTCOME"
      | "PROVIDER_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "WechatPayProtocolError";
  }
}

export interface WechatPayHttpRequest {
  readonly method: "GET" | "POST";
  readonly requestTarget: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface WechatPayHttpResponse {
  readonly status: number;
  readonly headers: WechatPaySignatureHeaders;
  readonly rawBody: string;
}

/**
 * A deliberately small transport seam.  Production code can wrap a pinned
 * HTTPS client, while tests inject signed in-memory replies.  The protocol
 * package never uses global fetch and never opens a network connection itself.
 */
export interface WechatPayHttpTransport {
  send(request: WechatPayHttpRequest): Promise<WechatPayHttpResponse>;
}

/**
 * The only production-capable transport in this package. Its destination is
 * intentionally not configurable: credentials can change, but a payment call
 * cannot be redirected to an arbitrary URL through configuration or input.
 * Callers must still explicitly construct this adapter; the default app and
 * worker configurations remain offline/mock until merchant activation.
 */
export class WechatPayHttpsTransport implements WechatPayHttpTransport {
  private readonly timeoutMs: number;

  public constructor(options: { readonly timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw configurationError("WeChat Pay transport timeout must be between 1,000 and 30,000 ms");
    }
  }

  public send(input: WechatPayHttpRequest): Promise<WechatPayHttpResponse> {
    const requestTarget = validateRequestTarget(input.requestTarget);
    const body = input.body === undefined ? undefined : validateRawBody(input.body);
    return new Promise<WechatPayHttpResponse>((resolve, reject) => {
      const request = httpsRequest(
        {
          protocol: "https:",
          hostname: WECHAT_PAY_API_HOSTNAME,
          port: 443,
          method: input.method,
          path: requestTarget,
          headers: input.headers,
          rejectUnauthorized: true,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          let rejectedResponse = false;
          response.on("data", (chunk: Buffer) => {
            if (!Buffer.isBuffer(chunk)) {
              rejectedResponse = true;
              response.destroy(
                new WechatPayProtocolError(
                  "INVALID_PROVIDER_RESPONSE",
                  "WeChat Pay response body is not binary data",
                ),
              );
              return;
            }
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
              rejectedResponse = true;
              response.destroy(
                new WechatPayProtocolError(
                  "INVALID_PROVIDER_RESPONSE",
                  "WeChat Pay response exceeds the maximum size",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              if (rejectedResponse) return;
              const status = response.statusCode;
              if (status === undefined) {
                throw new WechatPayProtocolError(
                  "INVALID_PROVIDER_RESPONSE",
                  "WeChat Pay response lacks an HTTP status",
                );
              }
              const rawBytes = Buffer.concat(chunks);
              const rawBody = rawBytes.toString("utf8");
              if (!Buffer.from(rawBody, "utf8").equals(rawBytes)) {
                throw new WechatPayProtocolError(
                  "INVALID_PROVIDER_RESPONSE",
                  "WeChat Pay response is not valid UTF-8",
                );
              }
              resolve({
                status,
                headers: responseSignatureHeaders(response.headers),
                rawBody,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("error", reject);
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(
          new WechatPayProtocolError("AMBIGUOUS_PROVIDER_OUTCOME", "WeChat Pay request timed out"),
        );
      });
      if (body !== undefined) request.write(body, "utf8");
      request.end();
    });
  }
}

export interface WechatPayJsapiPrepayRequest {
  readonly merchantOrderNo: string;
  readonly payerOpenId: string;
  readonly amountFen: 99;
  readonly notifyUrl: string;
  readonly description?: string;
}

export interface WechatPayJsapiPrepayResponse {
  readonly prepayId: string;
}

export interface WechatPayOrderQuery {
  readonly merchantOrderNo: string;
  readonly transactionId?: string;
  readonly tradeState: "SUCCESS" | "REFUND" | "NOTPAY" | "CLOSED" | "REVOKED" | "PAYERROR";
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly successTime?: string;
}

export interface WechatPayRefundRequest {
  readonly merchantOrderNo: string;
  readonly merchantRefundNo: string;
  readonly amountFen: 99;
  readonly totalFen: 99;
  readonly reason: string;
  readonly notifyUrl: string;
}

export interface WechatPayRefundQuery {
  readonly merchantOrderNo: string;
  readonly merchantRefundNo: string;
  readonly providerRefundId?: string;
  readonly status: "SUCCESS" | "CLOSED" | "PROCESSING" | "ABNORMAL";
  readonly amountFen: number;
  readonly totalFen: number;
  readonly currency: "CNY";
  readonly successTime?: string;
}

/**
 * Implements the cryptographic wire rules for WeChat Pay API v3. It deliberately
 * has no HTTP or database dependency so callers cannot accidentally turn a
 * transport response into a business fact before signature and schema checks.
 */
export class WechatPayV3Protocol {
  private readonly merchantPrivateKey: KeyObject;
  private readonly verifierPublicKeys: ReadonlyMap<string, KeyObject>;
  private readonly apiV3Key: Buffer;

  public readonly merchantId: string;
  public readonly appId: string;
  public readonly merchantCertificateSerial: string;

  public constructor(credentials: WechatPayV3Credentials) {
    this.merchantId = requireToken(
      credentials.merchantId,
      "merchant ID",
      6,
      32,
      /^[0-9]+$/u,
      configurationError,
    );
    this.appId = requireToken(
      credentials.appId,
      "AppID",
      3,
      64,
      /^[A-Za-z0-9_-]+$/u,
      configurationError,
    );
    this.merchantCertificateSerial = requireToken(
      credentials.merchantCertificateSerial,
      "merchant certificate serial",
      16,
      128,
      /^[A-Fa-f0-9]+$/u,
      configurationError,
    );
    this.apiV3Key = Buffer.from(credentials.apiV3Key, "utf8");
    if (this.apiV3Key.length !== 32) {
      throw configurationError("API v3 key must contain exactly 32 UTF-8 bytes");
    }
    try {
      this.merchantPrivateKey = createPrivateKey(credentials.merchantPrivateKeyPem);
    } catch {
      throw configurationError("merchant private key is not a valid PEM private key");
    }
    if (
      this.merchantPrivateKey.type !== "private" ||
      this.merchantPrivateKey.asymmetricKeyType !== "rsa"
    ) {
      throw configurationError("merchant private key must be an RSA private key");
    }
    requireRsaStrength(this.merchantPrivateKey, "merchant private key");
    if (credentials.verifierPublicKeys.size < 1 || credentials.verifierPublicKeys.size > 4) {
      throw configurationError("one to four verifier public keys are required");
    }
    const parsedKeys = new Map<string, KeyObject>();
    for (const [id, pem] of credentials.verifierPublicKeys) {
      const keyId = requireToken(
        id,
        "verifier key ID",
        8,
        128,
        /^[A-Za-z0-9_-]+$/u,
        configurationError,
      );
      let key: KeyObject;
      try {
        key = createPublicKey(pem);
      } catch {
        throw configurationError(`verifier public key ${keyId} is not valid PEM`);
      }
      if (key.type !== "public" || key.asymmetricKeyType !== "rsa") {
        throw configurationError(`verifier public key ${keyId} must be RSA`);
      }
      requireRsaStrength(key, `verifier public key ${keyId}`);
      parsedKeys.set(keyId, key);
    }
    this.verifierPublicKeys = parsedKeys;
  }

  public createAuthorization(input: {
    readonly method: string;
    readonly requestTarget: string;
    readonly body?: string;
    readonly timestamp?: number;
    readonly nonce?: string;
  }): {
    readonly authorization: string;
    readonly timestamp: string;
    readonly nonce: string;
    readonly signature: string;
  } {
    const method = validateMethod(input.method);
    const requestTarget = validateRequestTarget(input.requestTarget);
    const body = validateRawBody(input.body ?? "");
    const timestamp = validateUnixTimestamp(input.timestamp ?? Math.floor(Date.now() / 1_000));
    const nonce = validateNonce(
      input.nonce ?? randomBytes(16).toString("hex"),
      (message) => new WechatPayProtocolError("INVALID_REQUEST", message),
    );
    const message = `${method}\n${requestTarget}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = this.sign(message);
    const authorization = `${AUTHORIZATION_SCHEME} mchid="${this.merchantId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.merchantCertificateSerial}"`;
    return { authorization, timestamp: String(timestamp), nonce, signature };
  }

  public verifySignedMessage(
    headers: WechatPaySignatureHeaders,
    rawBody: string,
    options: { readonly now?: Date; readonly maxClockSkewSeconds?: number } = {},
  ): void {
    const timestamp = parseHeaderTimestamp(headers.timestamp);
    const nonce = validateNonce(headers.nonce, signatureHeaderError);
    const serial = requireToken(
      headers.serial,
      "Wechatpay-Serial",
      8,
      128,
      /^[A-Za-z0-9_-]+$/u,
      signatureHeaderError,
    );
    const signature = requireBase64(headers.signature, "Wechatpay-Signature", 8_192);
    if (headers.signatureType !== undefined && headers.signatureType !== SIGNATURE_TYPE) {
      throw signatureHeaderError("unsupported Wechatpay-Signature-Type");
    }
    const maxClockSkewSeconds = options.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;
    if (
      !Number.isInteger(maxClockSkewSeconds) ||
      maxClockSkewSeconds < 1 ||
      maxClockSkewSeconds > 900
    ) {
      throw signatureHeaderError("clock-skew window must be between 1 and 900 seconds");
    }
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
    if (Math.abs(nowSeconds - timestamp) > maxClockSkewSeconds) {
      throw new WechatPayProtocolError("STALE_MESSAGE", "WeChat Pay message timestamp is stale");
    }
    const verifier = this.verifierPublicKeys.get(serial);
    if (verifier === undefined) {
      throw new WechatPayProtocolError(
        "UNKNOWN_VERIFIER_KEY",
        "unknown WeChat Pay verifier key ID",
      );
    }
    const body = validateRawBody(rawBody);
    const verification = createVerify("RSA-SHA256");
    verification.update(`${timestamp}\n${nonce}\n${body}\n`, "utf8");
    verification.end();
    if (!verification.verify(verifier, signature, "base64")) {
      throw new WechatPayProtocolError(
        "INVALID_SIGNATURE",
        "WeChat Pay signature verification failed",
      );
    }
  }

  public parseAndVerifyNotification(
    headers: WechatPaySignatureHeaders,
    rawBody: string,
    options: { readonly now?: Date; readonly maxClockSkewSeconds?: number } = {},
  ): {
    readonly envelope: WechatPayNotificationEnvelope;
    readonly plaintext: string;
    readonly rawDigest: string;
  } {
    this.verifySignedMessage(headers, rawBody, options);
    const envelope = parseNotificationEnvelope(rawBody);
    return {
      envelope,
      plaintext: this.decryptResource(envelope.resource),
      rawDigest: sha256Hex(rawBody),
    };
  }

  public decryptResource(resource: WechatPayEncryptedResource): string {
    if (resource.algorithm !== RESOURCE_ALGORITHM) {
      throw resourceError("unsupported encrypted resource algorithm");
    }
    const nonce = Buffer.from(
      requireToken(resource.nonce, "resource nonce", 12, 32, /^[A-Za-z0-9]+$/u),
      "utf8",
    );
    if (nonce.length !== 12) throw resourceError("resource nonce must contain exactly 12 bytes");
    const encrypted = decodeBase64(resource.ciphertext, "resource ciphertext", 1_048_576);
    if (encrypted.length <= GCM_TAG_BYTES) throw resourceError("resource ciphertext is too short");
    const ciphertext = encrypted.subarray(0, encrypted.length - GCM_TAG_BYTES);
    const authTag = encrypted.subarray(encrypted.length - GCM_TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.apiV3Key, nonce);
      decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new WechatPayProtocolError(
        "DECRYPTION_FAILED",
        "WeChat Pay resource decryption failed",
      );
    }
  }

  public createMiniProgramPaymentParameters(input: {
    readonly prepayId: string;
    readonly timestamp?: number;
    readonly nonce?: string;
  }): MiniProgramPaymentParameters {
    const prepayId = requireToken(
      input.prepayId,
      "prepay ID",
      1,
      128,
      /^[A-Za-z0-9_-]+$/u,
      (message) => new WechatPayProtocolError("INVALID_REQUEST", message),
    );
    const timeStamp = String(
      validateUnixTimestamp(input.timestamp ?? Math.floor(Date.now() / 1_000)),
    );
    const nonceStr = validateNonce(
      input.nonce ?? randomBytes(16).toString("hex"),
      (message) => new WechatPayProtocolError("INVALID_REQUEST", message),
    );
    const packageValue = `prepay_id=${prepayId}`;
    const paySign = this.sign(`${this.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`);
    return { timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign };
  }

  private sign(message: string): string {
    const signer = createSign("RSA-SHA256");
    signer.update(message, "utf8");
    signer.end();
    return signer.sign(this.merchantPrivateKey, "base64");
  }
}

/**
 * The API v3 client preserves the exact bytes it signs and verifies every
 * reply before returning a provider fact.  It intentionally does not make a
 * database decision: callers must persist an intent first and apply the
 * verified result in a separate serializable transaction.
 */
export class WechatPayV3Client {
  public constructor(
    private readonly protocol: WechatPayV3Protocol,
    private readonly transport: WechatPayHttpTransport,
  ) {}

  public async createJsapiPrepay(
    input: WechatPayJsapiPrepayRequest,
  ): Promise<WechatPayJsapiPrepayResponse> {
    const merchantOrderNo = requireMerchantReference(
      input.merchantOrderNo,
      "merchant order number",
    );
    const payerOpenId = requireToken(
      input.payerOpenId,
      "payer OpenID",
      8,
      128,
      /^[A-Za-z0-9_-]+$/u,
      invalidRequest,
    );
    const notifyUrl = requireHttpsNotifyUrl(input.notifyUrl);
    if (input.amountFen !== 99) throw invalidRequest("JSAPI prepay amount must be exactly 99 fen");
    const description = requireString(
      input.description ?? "Campus companion information service",
      "payment description",
      1,
      127,
    );
    const reply = await this.request("POST", "/v3/pay/transactions/jsapi", {
      appid: this.protocol.appId,
      mchid: this.protocol.merchantId,
      description,
      out_trade_no: merchantOrderNo,
      notify_url: notifyUrl,
      amount: { total: 99, currency: "CNY" },
      payer: { openid: payerOpenId },
    });
    const body = parseProviderJson(reply.rawBody);
    return {
      prepayId: requireToken(
        body["prepay_id"],
        "prepay_id",
        1,
        128,
        /^[A-Za-z0-9_-]+$/u,
        invalidProviderResponse,
      ),
    };
  }

  public async queryOrder(merchantOrderNo: string): Promise<WechatPayOrderQuery> {
    const orderNumber = requireMerchantReference(merchantOrderNo, "merchant order number");
    const reply = await this.request(
      "GET",
      `/v3/pay/transactions/out-trade-no/${orderNumber}?mchid=${this.protocol.merchantId}`,
    );
    const result = parseOrderQuery(parseProviderJson(reply.rawBody), this.protocol);
    if (result.merchantOrderNo !== orderNumber) {
      throw invalidProviderResponse("provider order number does not match the query target");
    }
    return result;
  }

  public async createRefund(input: WechatPayRefundRequest): Promise<WechatPayRefundQuery> {
    const merchantOrderNo = requireMerchantReference(
      input.merchantOrderNo,
      "merchant order number",
    );
    const merchantRefundNo = requireMerchantReference(
      input.merchantRefundNo,
      "merchant refund number",
    );
    const notifyUrl = requireHttpsNotifyUrl(input.notifyUrl);
    if (input.amountFen !== 99 || input.totalFen !== 99) {
      throw invalidRequest("refund amount must equal the server-owned 99-fen order total");
    }
    const reason = requireString(input.reason, "refund reason", 1, 80);
    const reply = await this.request("POST", "/v3/refund/domestic/refunds", {
      out_trade_no: merchantOrderNo,
      out_refund_no: merchantRefundNo,
      reason,
      notify_url: notifyUrl,
      amount: { refund: 99, total: 99, currency: "CNY" },
    });
    return parseRefundQuery(parseProviderJson(reply.rawBody));
  }

  public async queryRefund(merchantRefundNo: string): Promise<WechatPayRefundQuery> {
    const refundNumber = requireMerchantReference(merchantRefundNo, "merchant refund number");
    const reply = await this.request("GET", `/v3/refund/domestic/refunds/${refundNumber}`);
    const result = parseRefundQuery(parseProviderJson(reply.rawBody));
    if (result.merchantRefundNo !== refundNumber) {
      throw invalidProviderResponse("provider refund number does not match the query target");
    }
    return result;
  }

  private async request(
    method: "GET" | "POST",
    requestTarget: string,
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<WechatPayHttpResponse> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const signed = this.protocol.createAuthorization({ method, requestTarget, body });
    const request: WechatPayHttpRequest = {
      method,
      requestTarget,
      headers: {
        Authorization: signed.authorization,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "campus-companion/wechat-pay-v3",
      },
      ...(body === "" ? {} : { body }),
    };
    let response: WechatPayHttpResponse;
    try {
      response = await this.transport.send(request);
    } catch (error) {
      if (error instanceof WechatPayProtocolError) throw error;
      throw new WechatPayProtocolError(
        "AMBIGUOUS_PROVIDER_OUTCOME",
        "WeChat Pay transport outcome is unknown; query before retrying",
      );
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw invalidProviderResponse("provider HTTP status is invalid");
    }
    this.protocol.verifySignedMessage(response.headers, response.rawBody);
    if (response.status >= 500) {
      throw new WechatPayProtocolError(
        "AMBIGUOUS_PROVIDER_OUTCOME",
        "WeChat Pay server outcome is unknown; query before retrying",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WechatPayProtocolError(
        "PROVIDER_REJECTED",
        "WeChat Pay rejected the signed request",
      );
    }
    return response;
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function responseSignatureHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): WechatPaySignatureHeaders {
  const valueFor = (name: string): string => {
    const value = headers[name];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 8_192 ||
      /[\r\n]/u.test(value)
    ) {
      throw new WechatPayProtocolError(
        "INVALID_PROVIDER_RESPONSE",
        `WeChat Pay response lacks a valid ${name} header`,
      );
    }
    return value;
  };
  const signatureType = headers["wechatpay-signature-type"];
  if (
    signatureType !== undefined &&
    (typeof signatureType !== "string" ||
      signatureType.length < 1 ||
      signatureType.length > 128 ||
      /[\r\n]/u.test(signatureType))
  ) {
    throw new WechatPayProtocolError(
      "INVALID_PROVIDER_RESPONSE",
      "WeChat Pay response has an invalid signature-type header",
    );
  }
  return {
    signature: valueFor("wechatpay-signature"),
    timestamp: valueFor("wechatpay-timestamp"),
    nonce: valueFor("wechatpay-nonce"),
    serial: valueFor("wechatpay-serial"),
    ...(signatureType === undefined ? {} : { signatureType }),
  };
}

function parseNotificationEnvelope(rawBody: string): WechatPayNotificationEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw resourceError("notification body is not valid JSON");
  }
  if (!isRecord(value) || !isRecord(value["resource"])) {
    throw resourceError("notification envelope is invalid");
  }
  const resource = value["resource"];
  return {
    id: requireToken(value["id"], "notification ID", 1, 128, /^[A-Za-z0-9_-]+$/u),
    create_time: requireRfc3339(value["create_time"], "notification create_time"),
    event_type: requireToken(
      value["event_type"],
      "notification event_type",
      1,
      64,
      /^[A-Z0-9_.-]+$/u,
    ),
    resource_type: requireToken(
      value["resource_type"],
      "notification resource_type",
      1,
      64,
      /^[A-Za-z0-9_.-]+$/u,
    ),
    summary: requireString(value["summary"], "notification summary", 0, 256),
    resource: {
      algorithm: requireString(resource["algorithm"], "resource algorithm", 1, 64),
      ciphertext: requireString(resource["ciphertext"], "resource ciphertext", 1, 1_048_576),
      nonce: requireString(resource["nonce"], "resource nonce", 1, 64),
      ...(resource["associated_data"] === undefined
        ? {}
        : {
            associated_data: requireString(
              resource["associated_data"],
              "resource associated_data",
              0,
              256,
            ),
          }),
      ...(resource["original_type"] === undefined
        ? {}
        : {
            original_type: requireString(
              resource["original_type"],
              "resource original_type",
              1,
              64,
            ),
          }),
    },
  };
}

export function parseWechatPayTransaction(
  plaintext: string,
  expected: {
    readonly merchantOrderNo: string;
    readonly merchantId: string;
    readonly appId: string;
    readonly amountFen: 99;
  },
): WechatPayOrderQuery {
  const result = parseOrderQuery(parseProviderJson(plaintext), {
    merchantId: expected.merchantId,
    appId: expected.appId,
  });
  if (result.merchantOrderNo !== undefined && result.merchantOrderNo !== expected.merchantOrderNo) {
    throw invalidProviderResponse(
      "transaction merchant order number does not match the local intent",
    );
  }
  if (result.amountFen !== expected.amountFen) {
    throw invalidProviderResponse("transaction amount does not match the local intent");
  }
  return result;
}

/**
 * Parses a decrypted notification before a local order is known. It validates
 * the WeChat merchant/AppID and provider schema, but intentionally does not
 * treat its order number or amount as an internal business fact. The caller
 * must persist the verified external event and compare it with a local order.
 */
export function parseWechatPayTransactionNotice(
  plaintext: string,
  expected: { readonly merchantId: string; readonly appId: string },
): WechatPayOrderQuery {
  return parseOrderQuery(parseProviderJson(plaintext), expected);
}

export function parseWechatPayRefund(
  plaintext: string,
  expected: {
    readonly merchantRefundNo: string;
    readonly merchantOrderNo: string;
    readonly amountFen: 99;
  },
): WechatPayRefundQuery {
  const result = parseRefundQuery(parseProviderJson(plaintext));
  if (
    result.merchantRefundNo !== undefined &&
    result.merchantRefundNo !== expected.merchantRefundNo
  ) {
    throw invalidProviderResponse("refund merchant refund number does not match the local intent");
  }
  if (result.merchantOrderNo !== undefined && result.merchantOrderNo !== expected.merchantOrderNo) {
    throw invalidProviderResponse("refund merchant order number does not match the local intent");
  }
  if (result.amountFen !== expected.amountFen || result.totalFen !== expected.amountFen) {
    throw invalidProviderResponse("refund amount does not match the local intent");
  }
  return result;
}

/** Parses a verified refund notification before it is matched to local state. */
export function parseWechatPayRefundNotice(plaintext: string): WechatPayRefundQuery {
  return parseRefundQuery(parseProviderJson(plaintext));
}

function parseOrderQuery(
  body: Record<string, unknown>,
  expected: { readonly merchantId: string; readonly appId: string },
): WechatPayOrderQuery {
  const merchantId = requireToken(
    body["mchid"],
    "mchid",
    6,
    32,
    /^[0-9]+$/u,
    invalidProviderResponse,
  );
  const appId = requireToken(
    body["appid"],
    "appid",
    3,
    64,
    /^[A-Za-z0-9_-]+$/u,
    invalidProviderResponse,
  );
  if (merchantId !== expected.merchantId || appId !== expected.appId) {
    throw invalidProviderResponse(
      "provider merchant or AppID does not match the local configuration",
    );
  }
  const amount = requireRecord(body["amount"], "transaction amount");
  const amountFen = requireFen(amount["total"], "transaction amount total");
  const currency = requireCurrency(amount["currency"]);
  const tradeState = requireEnum(body["trade_state"], "trade_state", [
    "SUCCESS",
    "REFUND",
    "NOTPAY",
    "CLOSED",
    "REVOKED",
    "PAYERROR",
  ] as const);
  return {
    merchantOrderNo: requireMerchantReference(
      body["out_trade_no"],
      "transaction merchant order number",
      invalidProviderResponse,
    ),
    ...(body["transaction_id"] === undefined
      ? {}
      : {
          transactionId: requireMerchantReference(
            body["transaction_id"],
            "transaction ID",
            invalidProviderResponse,
          ),
        }),
    tradeState,
    amountFen,
    currency,
    ...(body["success_time"] === undefined
      ? {}
      : { successTime: requireRfc3339(body["success_time"], "transaction success_time") }),
  };
}

function parseRefundQuery(body: Record<string, unknown>): WechatPayRefundQuery {
  const amount = requireRecord(body["amount"], "refund amount");
  return {
    merchantRefundNo: requireMerchantReference(
      body["out_refund_no"],
      "refund merchant refund number",
      invalidProviderResponse,
    ),
    merchantOrderNo: requireMerchantReference(
      body["out_trade_no"],
      "refund merchant order number",
      invalidProviderResponse,
    ),
    ...(body["refund_id"] === undefined
      ? {}
      : {
          providerRefundId: requireMerchantReference(
            body["refund_id"],
            "provider refund ID",
            invalidProviderResponse,
          ),
        }),
    status: requireEnum(body["status"], "refund status", [
      "SUCCESS",
      "CLOSED",
      "PROCESSING",
      "ABNORMAL",
    ] as const),
    amountFen: requireFen(amount["refund"], "refund amount refund"),
    totalFen: requireFen(amount["total"], "refund amount total"),
    currency: requireCurrency(amount["currency"]),
    ...(body["success_time"] === undefined
      ? {}
      : { successTime: requireRfc3339(body["success_time"], "refund success_time") }),
  };
}

function parseProviderJson(rawBody: string): Record<string, unknown> {
  validateRawBody(rawBody);
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw invalidProviderResponse("provider response is not valid JSON");
  }
  return requireRecord(value, "provider response");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidProviderResponse(`${field} is invalid`);
  return value;
}

function requireFen(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw invalidProviderResponse(`${field} is invalid`);
  }
  return value;
}

function requireCurrency(value: unknown): "CNY" {
  if (value !== "CNY") throw invalidProviderResponse("currency is invalid");
  return "CNY";
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  field: string,
  choices: T,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw invalidProviderResponse(`${field} is invalid`);
  }
  return value as T[number];
}

function requireMerchantReference(
  value: unknown,
  field: string,
  errorFactory: (message: string) => WechatPayProtocolError = invalidRequest,
): string {
  return requireToken(value, field, 8, 64, /^[A-Za-z0-9_-]+$/u, errorFactory);
}

function requireHttpsNotifyUrl(value: string): string {
  if (value.length < 8 || value.length > 2_048 || /[\r\n\0]/u.test(value)) {
    throw invalidRequest("payment notification URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest("payment notification URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.hostname === "" ||
    isLoopbackHost(url.hostname)
  ) {
    throw invalidRequest("payment notification URL must be a non-loopback HTTPS URL");
  }
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    /^0(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function validateMethod(value: string): string {
  const method = value.toUpperCase();
  if (!/^(?:GET|POST|PUT|PATCH|DELETE)$/u.test(method)) {
    throw new WechatPayProtocolError("INVALID_REQUEST", "unsupported HTTP method");
  }
  return method;
}

function validateRequestTarget(value: string): string {
  if (
    value.length < 2 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\r\n#]/u.test(value) ||
    /^[^?]*%2f/iu.test(value)
  ) {
    throw new WechatPayProtocolError("INVALID_REQUEST", "request target is not canonical");
  }
  return value;
}

function validateRawBody(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 1_048_576) {
    throw new WechatPayProtocolError("INVALID_REQUEST", "raw message body exceeds one MiB");
  }
  return value;
}

function validateUnixTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_500_000_000 || value > 4_102_444_800) {
    throw new WechatPayProtocolError("INVALID_REQUEST", "timestamp is outside the supported range");
  }
  return value;
}

function parseHeaderTimestamp(value: string): number {
  if (!/^[0-9]{10}$/u.test(value)) throw signatureHeaderError("Wechatpay-Timestamp is invalid");
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp))
    throw signatureHeaderError("Wechatpay-Timestamp is invalid");
  return timestamp;
}

function validateNonce(
  value: string,
  errorFactory: (message: string) => WechatPayProtocolError,
): string {
  return requireToken(value, "nonce", 8, 64, /^[A-Za-z0-9_-]+$/u, errorFactory);
}

function requireBase64(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") throw signatureHeaderError(`${field} is missing`);
  decodeBase64(value, field, maxBytes);
  return value;
}

function decodeBase64(value: unknown, field: string, maxBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4
  ) {
    throw resourceError(`${field} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maxBytes || decoded.toString("base64") !== value) {
    throw resourceError(`${field} is not canonical base64`);
  }
  return decoded;
}

function requireToken(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  pattern: RegExp,
  errorFactory: (message: string) => WechatPayProtocolError = resourceError,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n\0]/u.test(value)
  ) {
    throw errorFactory(`${field} is invalid`);
  }
  const text = value;
  if (!pattern.test(text)) throw errorFactory(`${field} contains unsupported characters`);
  return text;
}

function requireString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n\0]/u.test(value)
  ) {
    throw resourceError(`${field} is invalid`);
  }
  return value;
}

function requireRfc3339(value: unknown, field: string): string {
  const text = requireString(value, field, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    throw resourceError(`${field} is not RFC3339`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRsaStrength(key: KeyObject, field: string): void {
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2_048) {
    throw configurationError(`${field} must use an RSA modulus of at least 2048 bits`);
  }
}

function configurationError(message: string): WechatPayProtocolError {
  return new WechatPayProtocolError("INVALID_CONFIGURATION", message);
}

function signatureHeaderError(message: string): WechatPayProtocolError {
  return new WechatPayProtocolError("INVALID_SIGNATURE_HEADERS", message);
}

function resourceError(message: string): WechatPayProtocolError {
  return new WechatPayProtocolError("INVALID_RESOURCE", message);
}

function invalidRequest(message: string): WechatPayProtocolError {
  return new WechatPayProtocolError("INVALID_REQUEST", message);
}

function invalidProviderResponse(message: string): WechatPayProtocolError {
  return new WechatPayProtocolError("INVALID_PROVIDER_RESPONSE", message);
}
