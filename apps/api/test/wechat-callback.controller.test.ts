import { describe, expect, it, vi } from "vitest";
import { WechatCallbackController } from "../src/payments/wechat-callback.controller";
import type { WechatCallbackService } from "../src/payments/wechat-callback.service";

type CallbackRequest = Parameters<WechatCallbackController["receiveTransactionSuccess"]>[5];
const request = { rawBody: Buffer.from("m5-callback-body", "utf8") } as unknown as CallbackRequest;
const headers = {
  signature: "m5-signature",
  timestamp: "1234567890",
  nonce: "m5-nonce",
  serial: "m5-serial",
} as const;

describe("M5 WeChat callback controller", () => {
  it("forwards only complete, safe transaction and refund headers", async () => {
    const callbacks = {
      acceptTransactionSuccess: vi.fn().mockResolvedValue(undefined),
      acceptRefundSuccess: vi.fn().mockResolvedValue(undefined),
    } as unknown as WechatCallbackService;
    const controller = new WechatCallbackController(callbacks);

    await expect(
      controller.receiveTransactionSuccess(
        headers.signature,
        headers.timestamp,
        headers.nonce,
        headers.serial,
        undefined,
        request,
      ),
    ).resolves.toBeUndefined();
    await expect(
      controller.receiveRefundSuccess(
        headers.signature,
        headers.timestamp,
        headers.nonce,
        headers.serial,
        "WECHATPAY2-SHA256-RSA2048",
        request,
      ),
    ).resolves.toBeUndefined();

    expect(callbacks.acceptTransactionSuccess).toHaveBeenCalledWith(
      expect.objectContaining(headers),
      request.rawBody,
    );
    expect(callbacks.acceptRefundSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ ...headers, signatureType: "WECHATPAY2-SHA256-RSA2048" }),
      request.rawBody,
    );
  });

  it("rejects malformed callback input before it reaches the service", async () => {
    const callbacks = {
      acceptTransactionSuccess: vi.fn(),
      acceptRefundSuccess: vi.fn(),
    } as unknown as WechatCallbackService;
    const controller = new WechatCallbackController(callbacks);
    const malformedInputs: ReadonlyArray<
      readonly [unknown, unknown, unknown, unknown, unknown, unknown]
    > = [
      [undefined, headers.timestamp, headers.nonce, headers.serial, undefined, request],
      [headers.signature, "", headers.nonce, headers.serial, undefined, request],
      [headers.signature, headers.timestamp, "m5\nnonce", headers.serial, undefined, request],
      [headers.signature, headers.timestamp, headers.nonce, 1, undefined, request],
      [headers.signature, headers.timestamp, headers.nonce, headers.serial, undefined, {}],
      [
        headers.signature,
        headers.timestamp,
        headers.nonce,
        headers.serial,
        "WECHATPAY\rBAD",
        request,
      ],
      [headers.signature, headers.timestamp, headers.nonce, headers.serial, "", request],
      [
        headers.signature,
        headers.timestamp,
        headers.nonce,
        headers.serial,
        "x".repeat(4_097),
        request,
      ],
    ];
    for (const [
      signature,
      timestamp,
      nonce,
      serial,
      signatureType,
      rawRequest,
    ] of malformedInputs) {
      await expect(
        controller.receiveTransactionSuccess(
          signature,
          timestamp,
          nonce,
          serial,
          signatureType,
          rawRequest as CallbackRequest,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
      await expect(
        controller.receiveRefundSuccess(
          signature,
          timestamp,
          nonce,
          serial,
          signatureType,
          rawRequest as CallbackRequest,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    }
    expect(callbacks.acceptTransactionSuccess).not.toHaveBeenCalled();
    expect(callbacks.acceptRefundSuccess).not.toHaveBeenCalled();
  });
});
