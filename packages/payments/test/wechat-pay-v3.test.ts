import { createCipheriv, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  parseWechatPayRefund,
  parseWechatPayRefundNotice,
  parseWechatPayTransaction,
  parseWechatPayTransactionNotice,
  type WechatPayHttpRequest,
  WechatPayHttpsTransport,
  WechatPayProtocolError,
  type WechatPaySignatureHeaders,
  WechatPayV3Client,
  WechatPayV3Protocol,
} from "../src/wechat-pay-v3";

const httpsMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: httpsMock.request }));

const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivateKeyPem = merchant.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const platformPublicKeyPem = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
const apiV3Key = "0123456789abcdef0123456789abcdef";
const keyId = "PUB_KEY_ID_0000000000000000000000000000000001";

function protocol(): WechatPayV3Protocol {
  return new WechatPayV3Protocol({
    merchantId: "1900007291",
    appId: "wx2421b1c4370ec43b",
    merchantCertificateSerial: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
    merchantPrivateKeyPem,
    apiV3Key,
    verifierPublicKeys: new Map([[keyId, platformPublicKeyPem]]),
  });
}

describe("WeChat Pay API v3 protocol", () => {
  it("does not permit an unbounded outbound HTTPS timeout", () => {
    expect(() => new WechatPayHttpsTransport({ timeoutMs: 999 })).toThrowError("transport timeout");
    expect(() => new WechatPayHttpsTransport({ timeoutMs: 30_001 })).toThrowError(
      "transport timeout",
    );
  });

  it("uses only the fixed verified HTTPS endpoint and bounds provider responses", async () => {
    const transport = new WechatPayHttpsTransport();
    const request = mockHttpsReply({
      status: 200,
      rawBody: '{"prepay_id":"wx201410272009395522657a690389285100"}',
      headers: signPlatformMessage(
        String(Math.floor(Date.now() / 1_000)),
        "httpsResponseNonce000000000001",
        '{"prepay_id":"wx201410272009395522657a690389285100"}',
      ),
    });
    await expect(
      transport.send({
        method: "POST",
        requestTarget: "/v3/pay/transactions/jsapi",
        headers: { Authorization: "test" },
        body: "{}",
      }),
    ).resolves.toMatchObject({
      status: 200,
      rawBody: '{"prepay_id":"wx201410272009395522657a690389285100"}',
    });
    expect(httpsMock.request).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "https:",
        hostname: "api.mch.weixin.qq.com",
        port: 443,
        rejectUnauthorized: true,
        agent: false,
      }),
      expect.any(Function),
    );
    expect(request.request.write).toHaveBeenCalledWith("{}", "utf8");

    const oversized = mockHttpsReply({
      status: 200,
      rawBody: "x".repeat(1_048_577),
      headers: signPlatformMessage(
        String(Math.floor(Date.now() / 1_000)),
        "httpsResponseNonce000000000002",
        "{}",
      ),
    });
    await expect(
      transport.send({
        method: "GET",
        requestTarget: "/v3/pay/transactions/out-trade-no/test",
        headers: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(oversized.destroy).toHaveBeenCalledOnce();

    mockHttpsReply({
      status: 200,
      rawBody: "{}",
      headers: {} as WechatPaySignatureHeaders,
    });
    await expect(
      transport.send({
        method: "GET",
        requestTarget: "/v3/pay/transactions/out-trade-no/test",
        headers: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });

    mockHttpsReply({
      status: 200,
      rawBody: "{}",
      headers: {
        ...signPlatformMessage(
          String(Math.floor(Date.now() / 1_000)),
          "httpsResponseNonce000000000004",
          "{}",
        ),
        signatureType: "WECHATPAY2-SHA256-RSA2048\nspoofed",
      },
    });
    await expect(
      transport.send({
        method: "GET",
        requestTarget: "/v3/pay/transactions/out-trade-no/test",
        headers: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });

    mockHttpsReply({
      status: undefined as never,
      rawBody: "{}",
      headers: signPlatformMessage(
        String(Math.floor(Date.now() / 1_000)),
        "httpsResponseNonce000000000003",
        "{}",
      ),
    });
    await expect(
      transport.send({
        method: "GET",
        requestTarget: "/v3/pay/transactions/out-trade-no/test",
        headers: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("constructs the exact five-line request signature and authorization", () => {
    const body = '{"appid":"wx2421b1c4370ec43b","mchid":"1900007291"}';
    const signed = protocol().createAuthorization({
      method: "POST",
      requestTarget: "/v3/pay/transactions/jsapi",
      body,
      timestamp: 1_554_208_460,
      nonce: "593BEC0C930BF1AFEB40B4A08C8FB242",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(
      `POST\n/v3/pay/transactions/jsapi\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\n${body}\n`,
      "utf8",
    );
    verifier.end();
    expect(verifier.verify(merchant.publicKey, signed.signature, "base64")).toBe(true);
    expect(signed.authorization).toContain('mchid="1900007291"');
    expect(signed.authorization).toContain('serial_no="408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB"');
    expect(signed.authorization).not.toContain(body);
  });

  it("verifies the unmodified raw response and rejects tampering, stale time, and unknown keys", () => {
    const rawBody = '{"prepay_id":"wx201410272009395522657a690389285100"}';
    const now = new Date("2029-03-18T10:00:00.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const nonce = "d824f2e086d3c1df967785d13fcd22ef";
    const headers = signPlatformMessage(timestamp, nonce, rawBody);
    expect(() => protocol().verifySignedMessage(headers, rawBody, { now })).not.toThrow();
    expect(() => protocol().verifySignedMessage(headers, `${rawBody} `, { now })).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
    expect(() =>
      protocol().verifySignedMessage(headers, rawBody, {
        now: new Date(now.getTime() + 301_000),
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_MESSAGE" }));
    expect(() =>
      protocol().verifySignedMessage({ ...headers, serial: "PUB_KEY_ID_UNKNOWN" }, rawBody, {
        now,
      }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_VERIFIER_KEY" }));
  });

  it("verifies before decrypting an AEAD_AES_256_GCM notification resource", () => {
    const plaintext = JSON.stringify({
      mchid: "1900007291",
      appid: "wx2421b1c4370ec43b",
      out_trade_no: "m5_0123456789abcdef",
      transaction_id: "4200000000000000000000000001",
      trade_state: "SUCCESS",
      amount: { total: 99, payer_total: 99, currency: "CNY", payer_currency: "CNY" },
    });
    const resource = encryptResource(plaintext, "transaction");
    const rawBody = JSON.stringify({
      id: "EV-20290318-00000001",
      create_time: "2029-03-18T10:00:00+08:00",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      summary: "支付成功",
      resource,
    });
    const now = new Date("2029-03-18T02:00:00.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const headers = signPlatformMessage(timestamp, "notificationNonce000000000001", rawBody);
    const result = protocol().parseAndVerifyNotification(headers, rawBody, { now });
    expect(result.plaintext).toBe(plaintext);
    expect(result.envelope.id).toBe("EV-20290318-00000001");
    expect(result.rawDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      parseWechatPayTransaction(result.plaintext, {
        merchantOrderNo: "m5_0123456789abcdef",
        merchantId: "1900007291",
        appId: "wx2421b1c4370ec43b",
        amountFen: 99,
      }),
    ).toMatchObject({
      merchantOrderNo: "m5_0123456789abcdef",
      transactionId: "4200000000000000000000000001",
      tradeState: "SUCCESS",
      amountFen: 99,
    });
    expect(
      parseWechatPayTransactionNotice(result.plaintext, {
        merchantId: "1900007291",
        appId: "wx2421b1c4370ec43b",
      }),
    ).toMatchObject({
      merchantOrderNo: "m5_0123456789abcdef",
      transactionId: "4200000000000000000000000001",
      tradeState: "SUCCESS",
      amountFen: 99,
    });

    const corrupted = { ...resource, ciphertext: `${resource.ciphertext.slice(0, -4)}AAAA` };
    expect(() => protocol().decryptResource(corrupted)).toThrowError(
      expect.objectContaining({ code: "DECRYPTION_FAILED" }),
    );
  });

  it("creates mini-program parameters signed over AppID, time, nonce, and prepay package", () => {
    const result = protocol().createMiniProgramPaymentParameters({
      prepayId: "wx201410272009395522657a690389285100",
      timestamp: 1_554_208_460,
      nonce: "593BEC0C930BF1AFEB40B4A08C8FB242",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(
      "wx2421b1c4370ec43b\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\nprepay_id=wx201410272009395522657a690389285100\n",
      "utf8",
    );
    verifier.end();
    expect(verifier.verify(merchant.publicKey, result.paySign, "base64")).toBe(true);
    expect(result).toMatchObject({
      timeStamp: "1554208460",
      nonceStr: "593BEC0C930BF1AFEB40B4A08C8FB242",
      package: "prepay_id=wx201410272009395522657a690389285100",
      signType: "RSA",
    });
  });

  it("fails closed for malformed keys, bodies, headers, and algorithms", () => {
    expect(
      () =>
        new WechatPayV3Protocol({
          merchantId: "1900007291",
          appId: "wx2421b1c4370ec43b",
          merchantCertificateSerial: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
          merchantPrivateKeyPem,
          apiV3Key: "short",
          verifierPublicKeys: new Map([[keyId, platformPublicKeyPem]]),
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() =>
      protocol().createAuthorization({
        method: "POST",
        requestTarget: "https://api.mch.weixin.qq.com/v3/pay",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      protocol().verifySignedMessage(
        {
          signature: "not base64",
          timestamp: "123",
          nonce: "short",
          serial: keyId,
        },
        "{}",
      ),
    ).toThrowError(WechatPayProtocolError);
    expect(() =>
      protocol().decryptResource({
        algorithm: "AES_CBC",
        nonce: "123456789012",
        associated_data: "",
        ciphertext: Buffer.alloc(32).toString("base64"),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(
      () =>
        new WechatPayV3Protocol({
          merchantId: "1900007291",
          appId: "wx2421b1c4370ec43b",
          merchantCertificateSerial: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
          merchantPrivateKeyPem: weak.privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
          apiV3Key,
          verifierPublicKeys: new Map([[keyId, platformPublicKeyPem]]),
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("rejects invalid request construction and malformed notification envelopes without network I/O", () => {
    expect(() =>
      protocol().createAuthorization({
        method: "TRACE",
        requestTarget: "/v3/pay/transactions/jsapi",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      protocol().createAuthorization({
        method: "POST",
        requestTarget: "//api.mch.weixin.qq.com/v3/pay",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      protocol().createAuthorization({
        method: "POST",
        requestTarget: "/v3/pay#fragment",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      protocol().createAuthorization({
        method: "POST",
        requestTarget: "/v3/pay",
        body: "x".repeat(1_048_577),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      protocol().createMiniProgramPaymentParameters({
        prepayId: "bad space",
        timestamp: 1_554_208_460,
        nonce: "593BEC0C930BF1AFEB40B4A08C8FB242",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    const now = new Date("2029-03-18T02:00:00.000Z");
    const headers = signPlatformMessage(
      String(Math.floor(now.getTime() / 1_000)),
      "notificationNonce000000000009",
      "not json",
    );
    expect(() => protocol().parseAndVerifyNotification(headers, "not json", { now })).toThrowError(
      expect.objectContaining({ code: "INVALID_RESOURCE" }),
    );
    expect(
      () =>
        new WechatPayV3Protocol({
          merchantId: "1900007291",
          appId: "wx2421b1c4370ec43b",
          merchantCertificateSerial: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
          merchantPrivateKeyPem,
          apiV3Key,
          verifierPublicKeys: new Map(),
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() =>
      new WechatPayHttpsTransport().send({
        method: "POST",
        requestTarget: "//redirected.example.test/v3/pay",
        headers: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("accepts optional protocol fields only in their canonical safe forms", () => {
    const subject = protocol();
    expect(
      subject.createAuthorization({
        method: "get",
        requestTarget: "/v3/pay/transactions/out-trade-no/test",
      }),
    ).toMatchObject({ authorization: expect.stringContaining('mchid="1900007291"') });
    expect(
      subject.createMiniProgramPaymentParameters({
        prepayId: "wx201410272009395522657a690389285100",
      }),
    ).toMatchObject({ signType: "RSA", package: expect.stringContaining("prepay_id=") });
    const plaintext = "optional resource fields";
    const encrypted = encryptResource(plaintext, "");
    const resource = {
      algorithm: encrypted.algorithm,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
    };
    expect(subject.decryptResource(resource)).toBe(plaintext);
    const now = new Date("2029-03-18T02:00:00.000Z");
    const rawBody = JSON.stringify({
      id: "EV-20290318-00000009",
      create_time: "2029-03-18T10:00:00+08:00",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      summary: "",
      resource,
    });
    const headers = signPlatformMessage(
      String(Math.floor(now.getTime() / 1_000)),
      "notificationNonce000000000010",
      rawBody,
    );
    const { signatureType: _signatureType, ...headersWithoutType } = headers;
    expect(subject.parseAndVerifyNotification(headersWithoutType, rawBody, { now }).plaintext).toBe(
      plaintext,
    );
  });

  it("signs server-owned JSAPI fields and verifies the signed prepay reply", async () => {
    const requests: WechatPayHttpRequest[] = [];
    const client = new WechatPayV3Client(protocol(), {
      async send(request) {
        requests.push(request);
        return signedReply(200, '{"prepay_id":"wx201410272009395522657a690389285100"}');
      },
    });

    await expect(
      client.createJsapiPrepay({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        payerOpenId: "oUpF8uMuAJO_M2pxb1Q9zNjWeS6o",
        amountFen: 99,
        notifyUrl: "https://payments.example.edu/v1/payments/wechat/notify",
      }),
    ).resolves.toEqual({ prepayId: "wx201410272009395522657a690389285100" });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.requestTarget).toBe("/v3/pay/transactions/jsapi");
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      appid: "wx2421b1c4370ec43b",
      mchid: "1900007291",
      out_trade_no: "m5_0123456789abcdef0123456789abcdef",
      amount: { total: 99, currency: "CNY" },
    });
    expect(request?.headers["Authorization"]).toContain("WECHATPAY2-SHA256-RSA2048");
    expect(request?.headers["Authorization"]).not.toContain("oUpF8uMuAJO_M2pxb1Q9zNjWeS6o");
  });

  it("treats transport and signed 5xx outcomes as query-before-retry ambiguity", async () => {
    const transportFailure = new WechatPayV3Client(protocol(), {
      async send() {
        throw new Error("network unavailable");
      },
    });
    await expect(
      transportFailure.queryOrder("m5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_PROVIDER_OUTCOME",
    });

    const malformedTransportReply = new WechatPayV3Client(protocol(), {
      async send() {
        throw new WechatPayProtocolError("INVALID_PROVIDER_RESPONSE", "response was malformed");
      },
    });
    await expect(
      malformedTransportReply.queryOrder("m5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });

    const serverFailure = new WechatPayV3Client(protocol(), {
      async send() {
        return signedReply(503, '{"code":"SYSTEMERROR"}');
      },
    });
    await expect(
      serverFailure.queryOrder("m5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_PROVIDER_OUTCOME",
    });
  });

  it("rejects unsigned replies and provider facts that do not match server-owned values", async () => {
    const unsigned = new WechatPayV3Client(protocol(), {
      async send() {
        return {
          status: 200,
          headers: {
            timestamp: String(Math.floor(Date.now() / 1_000)),
            nonce: "nonce0000000000000000000000000000",
            serial: keyId,
            signature: Buffer.alloc(32).toString("base64"),
          },
          rawBody: '{"prepay_id":"wx201410272009395522657a690389285100"}',
        };
      },
    });
    await expect(
      unsigned.createJsapiPrepay({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        payerOpenId: "oUpF8uMuAJO_M2pxb1Q9zNjWeS6o",
        amountFen: 99,
        notifyUrl: "https://payments.example.edu/v1/payments/wechat/notify",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });

    const mismatched = new WechatPayV3Client(protocol(), {
      async send() {
        return signedReply(
          200,
          JSON.stringify({
            mchid: "1900007291",
            appid: "wx2421b1c4370ec43b",
            out_trade_no: "m5_ffffffffffffffffffffffffffffffff",
            trade_state: "SUCCESS",
            amount: { total: 1, currency: "CNY" },
          }),
        );
      },
    });
    await expect(
      mismatched.queryOrder("m5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("queries signed terminal facts and rejects provider protocol, schema, and business mismatches", async () => {
    const client = new WechatPayV3Client(protocol(), {
      async send(request) {
        if (request.requestTarget.startsWith("/v3/pay/transactions/out-trade-no/")) {
          return signedReply(
            200,
            JSON.stringify({
              mchid: "1900007291",
              appid: "wx2421b1c4370ec43b",
              out_trade_no: "m5_0123456789abcdef0123456789abcdef",
              transaction_id: "4200000000000000000000000001",
              trade_state: "SUCCESS",
              success_time: "2029-03-18T10:00:00+08:00",
              amount: { total: 99, currency: "CNY" },
            }),
          );
        }
        return signedReply(
          200,
          JSON.stringify({
            out_trade_no: "m5_0123456789abcdef0123456789abcdef",
            out_refund_no: "r5_0123456789abcdef0123456789abcdef",
            refund_id: "5000000000000000000000000001",
            status: "SUCCESS",
            success_time: "2029-03-18T10:00:00+08:00",
            amount: { refund: 99, total: 99, currency: "CNY" },
          }),
        );
      },
    });
    await expect(client.queryOrder("m5_0123456789abcdef0123456789abcdef")).resolves.toMatchObject({
      tradeState: "SUCCESS",
      amountFen: 99,
      currency: "CNY",
    });
    await expect(client.queryRefund("r5_0123456789abcdef0123456789abcdef")).resolves.toMatchObject({
      status: "SUCCESS",
      amountFen: 99,
      totalFen: 99,
    });

    const rejected = new WechatPayV3Client(protocol(), {
      async send() {
        return signedReply(400, '{"code":"PARAM_ERROR"}');
      },
    });
    await expect(rejected.queryOrder("m5_0123456789abcdef0123456789abcdef")).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
    });
    const malformed = new WechatPayV3Client(protocol(), {
      async send() {
        return signedReply(200, "[]");
      },
    });
    await expect(
      malformed.queryRefund("r5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });

    const impossibleStatus = new WechatPayV3Client(protocol(), {
      async send() {
        return { status: 99, headers: {} as WechatPaySignatureHeaders, rawBody: "{}" };
      },
    });
    await expect(
      impossibleStatus.queryOrder("m5_0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("requires a non-loopback HTTPS callback and constructs a full-refund request", async () => {
    const requests: WechatPayHttpRequest[] = [];
    const client = new WechatPayV3Client(protocol(), {
      async send(request) {
        requests.push(request);
        return signedReply(
          200,
          JSON.stringify({
            out_trade_no: "m5_0123456789abcdef0123456789abcdef",
            out_refund_no: "r5_0123456789abcdef0123456789abcdef",
            refund_id: "5000000000000000000000000001",
            status: "PROCESSING",
            amount: { refund: 99, total: 99, currency: "CNY" },
          }),
        );
      },
    });
    await expect(
      client.createRefund({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        merchantRefundNo: "r5_0123456789abcdef0123456789abcdef",
        amountFen: 99,
        totalFen: 99,
        reason: "ROUND_INVALIDATED",
        notifyUrl: "https://payments.example.edu/v1/payments/wechat/refund-notify",
      }),
    ).resolves.toMatchObject({ status: "PROCESSING", amountFen: 99, totalFen: 99 });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      out_trade_no: "m5_0123456789abcdef0123456789abcdef",
      out_refund_no: "r5_0123456789abcdef0123456789abcdef",
      amount: { refund: 99, total: 99, currency: "CNY" },
    });
    expect(
      parseWechatPayRefundNotice(
        JSON.stringify({
          out_trade_no: "m5_0123456789abcdef0123456789abcdef",
          out_refund_no: "r5_0123456789abcdef0123456789abcdef",
          refund_id: "5000000000000000000000000001",
          status: "SUCCESS",
          amount: { refund: 99, total: 99, currency: "CNY" },
        }),
      ),
    ).toMatchObject({
      merchantRefundNo: "r5_0123456789abcdef0123456789abcdef",
      status: "SUCCESS",
    });
    await expect(
      client.createRefund({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        merchantRefundNo: "r5_0123456789abcdef0123456789abcdef",
        amountFen: 99,
        totalFen: 99,
        reason: "ROUND_INVALIDATED",
        notifyUrl: "https://127.0.0.1/notify",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.createJsapiPrepay({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        payerOpenId: "short",
        amountFen: 99,
        notifyUrl: "https://payments.example.edu/notify",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.createJsapiPrepay({
        merchantOrderNo: "m5_0123456789abcdef0123456789abcdef",
        payerOpenId: "oUpF8uMuAJO_M2pxb1Q9zNjWeS6o",
        amountFen: 98 as 99,
        notifyUrl: "http://payments.example.edu/notify",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("enforces strict notice and intent matching for transactions and refunds", () => {
    const transaction = JSON.stringify({
      mchid: "1900007291",
      appid: "wx2421b1c4370ec43b",
      out_trade_no: "m5_0123456789abcdef",
      trade_state: "SUCCESS",
      amount: { total: 98, currency: "CNY" },
    });
    expect(() =>
      parseWechatPayTransaction(transaction, {
        merchantOrderNo: "m5_0123456789abcdef",
        merchantId: "1900007291",
        appId: "wx2421b1c4370ec43b",
        amountFen: 99,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROVIDER_RESPONSE" }));
    expect(() =>
      parseWechatPayTransactionNotice(
        JSON.stringify({
          mchid: "1900007291",
          appid: "wx2421b1c4370ec43b",
          out_trade_no: "m5_0123456789abcdef",
          trade_state: "UNKNOWN",
          amount: { total: 99, currency: "CNY" },
        }),
        { merchantId: "1900007291", appId: "wx2421b1c4370ec43b" },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROVIDER_RESPONSE" }));
    expect(() =>
      parseWechatPayRefund(
        JSON.stringify({
          out_trade_no: "m5_0123456789abcdef",
          out_refund_no: "r5_0123456789abcdef",
          status: "SUCCESS",
          amount: { refund: 99, total: 98, currency: "CNY" },
        }),
        {
          merchantOrderNo: "m5_0123456789abcdef",
          merchantRefundNo: "r5_0123456789abcdef",
          amountFen: 99,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PROVIDER_RESPONSE" }));
  });

  it("rejects non-canonical cryptographic, textual, and timestamp encodings", () => {
    const now = new Date("2029-03-18T02:00:00.000Z");
    const headers = signPlatformMessage(
      String(Math.floor(now.getTime() / 1_000)),
      "encodingNonce000000000000000001",
      "{}",
    );
    expect(() =>
      protocol().verifySignedMessage({ ...headers, signature: "!!!!" }, "{}", { now }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    expect(() =>
      protocol().verifySignedMessage({ ...headers, signature: "a" }, "{}", { now }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    const invalidSummaryEnvelope = JSON.stringify({
      id: "EV-20290318-00000011",
      create_time: "2029-03-18T10:00:00+08:00",
      event_type: "TRANSACTION.SUCCESS",
      resource_type: "encrypt-resource",
      summary: "x".repeat(257),
      resource: {},
    });
    const invalidSummaryHeaders = signPlatformMessage(
      String(Math.floor(now.getTime() / 1_000)),
      "encodingNonce000000000000000002",
      invalidSummaryEnvelope,
    );
    expect(() =>
      protocol().parseAndVerifyNotification(invalidSummaryHeaders, invalidSummaryEnvelope, { now }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    expect(() =>
      parseWechatPayRefundNotice(
        JSON.stringify({
          out_trade_no: "m5_0123456789abcdef",
          out_refund_no: "r5_0123456789abcdef",
          status: "SUCCESS",
          success_time: "2029/03/18",
          amount: { refund: 99, total: 99, currency: "CNY" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
  });
});

function signPlatformMessage(
  timestamp: string,
  nonce: string,
  rawBody: string,
): WechatPaySignatureHeaders {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
  signer.end();
  return {
    timestamp,
    nonce,
    serial: keyId,
    signatureType: "WECHATPAY2-SHA256-RSA2048",
    signature: signer.sign(platform.privateKey, "base64"),
  };
}

function signedReply(status: number, rawBody: string) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = "responseNonce000000000000000000000001";
  return { status, headers: signPlatformMessage(timestamp, nonce, rawBody), rawBody };
}

function encryptResource(plaintext: string, associatedData: string) {
  const nonce = "0123456789ab";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  return {
    original_type: "transaction",
    algorithm: "AEAD_AES_256_GCM",
    ciphertext,
    associated_data: associatedData,
    nonce,
  };
}

function mockHttpsReply(input: {
  readonly status: number;
  readonly rawBody: string;
  readonly headers: WechatPaySignatureHeaders;
}) {
  const response = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    headers: Record<string, string>;
    destroy: ReturnType<typeof vi.fn>;
  };
  response.statusCode = input.status;
  response.headers = {
    "wechatpay-signature": input.headers.signature,
    "wechatpay-timestamp": input.headers.timestamp,
    "wechatpay-nonce": input.headers.nonce,
    "wechatpay-serial": input.headers.serial,
    ...(input.headers.signatureType === undefined
      ? {}
      : { "wechatpay-signature-type": input.headers.signatureType }),
  };
  response.destroy = vi.fn((error?: Error) => {
    if (error !== undefined) queueMicrotask(() => response.emit("error", error));
  });
  const request = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  request.write = vi.fn();
  request.setTimeout = vi.fn();
  request.destroy = vi.fn((error?: Error) => {
    if (error !== undefined) queueMicrotask(() => request.emit("error", error));
  });
  request.end = vi.fn(() => {
    queueMicrotask(() => {
      response.emit("data", Buffer.from(input.rawBody, "utf8"));
      response.emit("end");
    });
  });
  httpsMock.request.mockImplementation(
    (_options: unknown, callback: (value: typeof response) => void) => {
      callback(response);
      return request;
    },
  );
  return { request, destroy: response.destroy };
}
