import { RefundReason } from "@campus/database";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { extractBearer, parseBody } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import { PaymentsService, type RefundResponse } from "./payments.service";

const UuidSchema = z.string().uuid();
const RefundRequestSchema = z
  .object({
    orderId: UuidSchema,
    reason: z.enum([
      RefundReason.PLATFORM_NOT_DELIVERED,
      RefundReason.DUPLICATE_CHARGE,
      RefundReason.OTHER,
    ]),
  })
  .strict();

@Controller()
export class RefundsController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  @Post("refunds")
  @HttpCode(202)
  public async requestRefund(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<RefundResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    const request = parseBody(RefundRequestSchema, body);
    return this.payments.requestRefund(
      principal,
      request.orderId,
      request.reason,
      idempotencyKey ?? "",
    );
  }

  @Get("refunds/:refundId")
  public async getRefund(
    @Headers("authorization") authorization: string | undefined,
    @Param("refundId") refundId: string,
  ): Promise<RefundResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.getRefund(principal, parseBody(UuidSchema, refundId));
  }
}
