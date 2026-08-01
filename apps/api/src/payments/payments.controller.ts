import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { extractBearer, parseBody } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import {
  PaymentsService,
  type PrepayResponse,
  type ServiceOrderResponse,
} from "./payments.service";

const UuidSchema = z.string().uuid();
const CreateOrderSchema = z.object({ roundId: z.string().uuid() }).strict();
const MockSettlementSchema = z
  .object({ intentId: z.string().regex(/^mock_intent_[a-f0-9]{40}$/u) })
  .strict();
const WechatContactSchema = z.object({ wechatId: z.string().min(6).max(20) }).strict();

@Controller()
export class PaymentsController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  @Post("me/contact")
  @HttpCode(200)
  public async setContact(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<{ readonly hasWechatContact: true }> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.setMyWechatContact(
      principal,
      parseBody(WechatContactSchema, body).wechatId,
      idempotencyKey ?? "",
    );
  }

  @Post("groups/:groupId/service-orders")
  public async createOrder(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<ServiceOrderResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.createOrder(
      principal,
      parseBody(UuidSchema, groupId),
      parseBody(CreateOrderSchema, body).roundId,
      idempotencyKey ?? "",
    );
  }

  @Get("service-orders/:orderId")
  public async getOrder(
    @Headers("authorization") authorization: string | undefined,
    @Param("orderId") orderId: string,
  ): Promise<ServiceOrderResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.getOrder(principal, parseBody(UuidSchema, orderId));
  }

  @Post("service-orders/:orderId/prepay")
  @HttpCode(200)
  public async createPrepay(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("orderId") orderId: string,
  ): Promise<PrepayResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.createPrepay(
      principal,
      parseBody(UuidSchema, orderId),
      idempotencyKey ?? "",
    );
  }

  @Post("service-orders/:orderId/mock-settlement")
  @HttpCode(200)
  public async settleMock(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ): Promise<ServiceOrderResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.completeMockPayment(
      principal,
      parseBody(UuidSchema, orderId),
      parseBody(MockSettlementSchema, body).intentId,
      idempotencyKey ?? "",
    );
  }

  @Delete("formation-rounds/:roundId/contact-consent")
  @HttpCode(204)
  public async revokeConsent(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("roundId") roundId: string,
  ): Promise<void> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    await this.payments.revokeContactConsent(
      principal,
      parseBody(UuidSchema, roundId),
      idempotencyKey ?? "",
    );
  }

  @Get("groups/:groupId/contacts")
  public async getContacts(
    @Headers("authorization") authorization: string | undefined,
    @Param("groupId") groupId: string,
  ) {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.payments.getUnlockedContacts(principal, parseBody(UuidSchema, groupId));
  }
}
