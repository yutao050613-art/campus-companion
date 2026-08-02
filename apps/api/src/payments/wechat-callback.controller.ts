import { Controller, Headers, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ApplicationError } from "../common/application-error";
import { WechatCallbackService } from "./wechat-callback.service";

type RawBodyRequest = FastifyRequest & { readonly rawBody?: Buffer };

@Controller()
export class WechatCallbackController {
  public constructor(
    @Inject(WechatCallbackService) private readonly callbacks: WechatCallbackService,
  ) {}

  @Post("payments/wechat/notify")
  @HttpCode(204)
  public async receiveTransactionSuccess(
    @Headers("wechatpay-signature") signature: unknown,
    @Headers("wechatpay-timestamp") timestamp: unknown,
    @Headers("wechatpay-nonce") nonce: unknown,
    @Headers("wechatpay-serial") serial: unknown,
    @Headers("wechatpay-signature-type") signatureType: unknown,
    @Req() request: RawBodyRequest,
  ): Promise<void> {
    if (
      !isSafeHeaderValue(signature) ||
      !isSafeHeaderValue(timestamp) ||
      !isSafeHeaderValue(nonce) ||
      !isSafeHeaderValue(serial) ||
      !Buffer.isBuffer(request.rawBody)
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "payment callback is malformed", 400);
    }
    if (signatureType !== undefined && !isSafeHeaderValue(signatureType)) {
      throw new ApplicationError("VALIDATION_ERROR", "payment callback is malformed", 400);
    }
    await this.callbacks.acceptTransactionSuccess(
      {
        signature,
        timestamp,
        nonce,
        serial,
        ...(signatureType === undefined ? {} : { signatureType }),
      },
      request.rawBody,
    );
  }

  @Post("refunds/wechat/notify")
  @HttpCode(204)
  public async receiveRefundSuccess(
    @Headers("wechatpay-signature") signature: unknown,
    @Headers("wechatpay-timestamp") timestamp: unknown,
    @Headers("wechatpay-nonce") nonce: unknown,
    @Headers("wechatpay-serial") serial: unknown,
    @Headers("wechatpay-signature-type") signatureType: unknown,
    @Req() request: RawBodyRequest,
  ): Promise<void> {
    if (
      !isSafeHeaderValue(signature) ||
      !isSafeHeaderValue(timestamp) ||
      !isSafeHeaderValue(nonce) ||
      !isSafeHeaderValue(serial) ||
      !Buffer.isBuffer(request.rawBody)
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "refund callback is malformed", 400);
    }
    if (signatureType !== undefined && !isSafeHeaderValue(signatureType)) {
      throw new ApplicationError("VALIDATION_ERROR", "refund callback is malformed", 400);
    }
    await this.callbacks.acceptRefundSuccess(
      {
        signature,
        timestamp,
        nonce,
        serial,
        ...(signatureType === undefined ? {} : { signatureType }),
      },
      request.rawBody,
    );
  }
}

function isSafeHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n]/u.test(value)
  );
}
