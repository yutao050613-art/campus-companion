import { createCipheriv, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import type { PaymentsService } from "../src/payments/payments.service";
import { WechatCallbackService } from "../src/payments/wechat-callback.service";

const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const apiV3Key = "0123456789abcdef0123456789abcdef";
const keyId = "PUB_KEY_ID_0000000000000000000000000000000001";
const now = new Date("2029-03-18T02:00:00.000Z");

function config(): AppConfig {
  return {
    nodeEnv: "test",
    wechatPayCallbacks: {
      merchantId: "1900007291",
      appId: "wx2421b1c4370ec43b",
      merchantCertificateSerial: "408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB",
      merchantPrivateKeyPem: merchant.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      apiV3Key,
      verifierPublicKeys: new Map([
        [keyId, platform.publicKey.export({ type: "spki", format: "pem" }).toString()],
      ]),
    },
  } as unknown as AppConfig;
}

function signedNotification(
  input: {
    readonly eventType?: "TRANSACTION.SUCCESS" | "REFUND.SUCCESS";
    readonly plaintext?: string;
  } = {},
) {
  const plaintext =
    input.plaintext ??
    JSON.stringify({
      mchid: "1900007291",
      appid: "wx2421b1c4370ec43b",
      out_trade_no: "m5_0123456789abcdef",
      transaction_id: "4200000000000000000000000001",
      trade_state: "SUCCESS",
      success_time: "2029-03-18T10:00:00+08:00",
      amount: { total: 99, currency: "CNY" },
    });
  const resource = encryptResource(plaintext);
  const rawBody = JSON.stringify({
    id: "EV-20290318-00000001",
    create_time: "2029-03-18T10:00:00+08:00",
    event_type: input.eventType ?? "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    summary: "payment completed",
    resource,
  });
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const nonce = "notificationNonce000000000001";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`, "utf8");
  signer.end();
  return {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: {
      timestamp,
      nonce,
      serial: keyId,
      signatureType: "WECHATPAY2-SHA256-RSA2048" as const,
      signature: signer.sign(platform.privateKey, "base64"),
    },
  };
}

describe("M5 WeChat callback boundary", () => {
  it("verifies raw bytes before it creates a durable event and applies it", async () => {
    const payments = {
      ingestVerifiedWechatPaymentEvent: vi.fn().mockResolvedValue({
        providerEventId: "00000000-0000-0000-0000-000000000001",
        status: "RECEIVED",
      }),
      applyVerifiedWechatPaymentEvent: vi.fn().mockResolvedValue({
        providerEventId: "00000000-0000-0000-0000-000000000001",
        status: "APPLIED",
      }),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, config());
    const notification = signedNotification();

    await expect(
      subject.acceptTransactionSuccess(notification.headers, notification.rawBody, now),
    ).resolves.toBeUndefined();

    expect(payments.ingestVerifiedWechatPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "EV-20290318-00000001",
        merchantOrderNo: "m5_0123456789abcdef",
        providerTransactionId: "4200000000000000000000000001",
        amountFen: 99,
        currency: "CNY",
      }),
    );
    expect(payments.applyVerifiedWechatPaymentEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects tampered raw bytes before they reach the payment service", async () => {
    const payments = {
      ingestVerifiedWechatPaymentEvent: vi.fn(),
      applyVerifiedWechatPaymentEvent: vi.fn(),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, config());
    const notification = signedNotification();
    const tampered = Buffer.concat([notification.rawBody, Buffer.from(" ", "utf8")]);

    await expect(
      subject.acceptTransactionSuccess(notification.headers, tampered, now),
    ).rejects.toMatchObject({
      code: "RESOURCE_FORBIDDEN",
      statusCode: 403,
    });
    expect(payments.ingestVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
    expect(payments.applyVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 before signature verification can decode a different body", async () => {
    const payments = {
      ingestVerifiedWechatPaymentEvent: vi.fn(),
      applyVerifiedWechatPaymentEvent: vi.fn(),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, config());
    const notification = signedNotification();
    const malformed = Buffer.concat([notification.rawBody, Buffer.from([0xc3, 0x28])]);

    await expect(
      subject.acceptTransactionSuccess(notification.headers, malformed, now),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(payments.ingestVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
    expect(payments.applyVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
  });

  it("requires an explicitly enabled callback verifier before accepting either callback", async () => {
    const payments = {
      ingestVerifiedWechatPaymentEvent: vi.fn(),
      ingestVerifiedWechatRefundEvent: vi.fn(),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, {} as AppConfig);
    const notification = signedNotification();

    await expect(
      subject.acceptTransactionSuccess(notification.headers, notification.rawBody, now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    await expect(
      subject.acceptRefundSuccess(notification.headers, notification.rawBody, now),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    expect(payments.ingestVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
    expect(payments.ingestVerifiedWechatRefundEvent).not.toHaveBeenCalled();
  });

  it("accepts a verified refund and does not reapply an already-recorded transaction", async () => {
    const payments = {
      ingestVerifiedWechatRefundEvent: vi.fn().mockResolvedValue({
        providerEventId: "00000000-0000-0000-0000-000000000002",
        status: "RECEIVED",
      }),
      applyVerifiedWechatRefundEvent: vi.fn().mockResolvedValue({
        providerEventId: "00000000-0000-0000-0000-000000000002",
        status: "APPLIED",
      }),
      ingestVerifiedWechatPaymentEvent: vi.fn().mockResolvedValue({
        providerEventId: "00000000-0000-0000-0000-000000000001",
        status: "APPLIED",
      }),
      applyVerifiedWechatPaymentEvent: vi.fn(),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, config());
    const refund = signedNotification({
      eventType: "REFUND.SUCCESS",
      plaintext: JSON.stringify({
        out_refund_no: "m5_refund_0123456789",
        out_trade_no: "m5_0123456789abcdef",
        refund_id: "m5_provider_refund_012345",
        status: "SUCCESS",
        success_time: "2029-03-18T10:00:00+08:00",
        amount: { refund: 99, total: 99, currency: "CNY" },
      }),
    });

    await expect(
      subject.acceptRefundSuccess(refund.headers, refund.rawBody, now),
    ).resolves.toBeUndefined();
    expect(payments.ingestVerifiedWechatRefundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantRefundNo: "m5_refund_0123456789",
        merchantOrderNo: "m5_0123456789abcdef",
        providerRefundId: "m5_provider_refund_012345",
      }),
    );
    expect(payments.applyVerifiedWechatRefundEvent).toHaveBeenCalledTimes(1);

    const transaction = signedNotification();
    await expect(
      subject.acceptTransactionSuccess(transaction.headers, transaction.rawBody, now),
    ).resolves.toBeUndefined();
    expect(payments.applyVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
  });

  it("rejects verified callbacks whose event or payment state cannot complete the service", async () => {
    const payments = {
      ingestVerifiedWechatPaymentEvent: vi.fn(),
      ingestVerifiedWechatRefundEvent: vi.fn(),
    } as unknown as PaymentsService;
    const subject = new WechatCallbackService(payments, config());
    const wrongEvent = signedNotification({ eventType: "REFUND.SUCCESS" });
    const incompletePayment = signedNotification({
      plaintext: JSON.stringify({
        mchid: "1900007291",
        appid: "wx2421b1c4370ec43b",
        out_trade_no: "m5_0123456789abcdef",
        trade_state: "NOTPAY",
        amount: { total: 99, currency: "CNY" },
      }),
    });
    const incompleteRefund = signedNotification({
      eventType: "REFUND.SUCCESS",
      plaintext: JSON.stringify({
        out_refund_no: "m5_refund_0123456789",
        out_trade_no: "m5_0123456789abcdef",
        status: "PROCESSING",
        amount: { refund: 99, total: 99, currency: "CNY" },
      }),
    });

    await expect(
      subject.acceptTransactionSuccess(wrongEvent.headers, wrongEvent.rawBody, now),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    await expect(
      subject.acceptTransactionSuccess(incompletePayment.headers, incompletePayment.rawBody, now),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    await expect(
      subject.acceptRefundSuccess(incompleteRefund.headers, incompleteRefund.rawBody, now),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(payments.ingestVerifiedWechatPaymentEvent).not.toHaveBeenCalled();
    expect(payments.ingestVerifiedWechatRefundEvent).not.toHaveBeenCalled();
  });
});

function encryptResource(plaintext: string) {
  const nonce = "0123456789ab";
  const associatedData = "transaction";
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
