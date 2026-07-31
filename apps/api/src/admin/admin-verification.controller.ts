import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseBody } from "../auth/auth.controller";
import { adminSecurityContext } from "./admin-auth.controller";
import {
  type AdminVerificationResponse,
  AdminVerificationService,
} from "./admin-verification.service";

const UuidSchema = z.string().uuid();
const ReviewSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "REQUIRE_RESUBMISSION"]),
    reasonCode: z.string().max(100).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
const ReauthSchema = z
  .object({
    assetType: z.enum(["STUDENT_CARD", "WECOM_SCREENSHOT"]),
    reauthTotpCode: z.string().regex(/^\d{6}$/u),
  })
  .strict();

@Controller("admin/verifications")
export class AdminVerificationController {
  public constructor(
    @Inject(AdminVerificationService) private readonly verifications: AdminVerificationService,
  ) {}

  @Get()
  public list(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Query("campusId") campusId: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ items: readonly AdminVerificationResponse[]; nextCursor: string | null }> {
    return this.verifications.list(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, campusId),
      cursor === undefined ? undefined : parseBody(UuidSchema, cursor),
    );
  }

  @Get(":verificationId")
  public get(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Param("verificationId") verificationId: string,
  ): Promise<AdminVerificationResponse> {
    return this.verifications.get(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, verificationId),
    );
  }

  @Post(":verificationId/decision")
  @HttpCode(200)
  public review(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("verificationId") verificationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminVerificationResponse> {
    return this.verifications.review(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, verificationId),
      parseBody(ReviewSchema, body),
      idempotencyKey ?? "",
      String(request.id),
    );
  }

  @Post(":verificationId/asset-access")
  public issueAssetAccess(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("verificationId") verificationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{
    readonly consumePath: "/v1/admin/verification-assets/consume";
    readonly grantToken: string;
    readonly expiresAt: string;
    readonly singleUse: true;
  }> {
    const input = parseBody(ReauthSchema, body);
    return this.verifications.issueAssetAccess(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, verificationId),
      input.assetType,
      input.reauthTotpCode,
      idempotencyKey ?? "",
      String(request.id),
    );
  }
}

@Controller("admin/verification-assets")
export class AdminVerificationAssetController {
  public constructor(
    @Inject(AdminVerificationService) private readonly verifications: AdminVerificationService,
  ) {}

  @Post("consume")
  @HttpCode(200)
  public async consume(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Headers("x-verification-asset-grant") grantToken: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.verifications.consumeAssetAccess(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      grantToken ?? "",
      String(request.id),
    );
    void reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .type(result.contentType)
      .send(result.content);
  }
}
