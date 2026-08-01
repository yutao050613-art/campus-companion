import { ReportCategory } from "@campus/database";
import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { extractBearer, parseBody } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import { type ReportResponse, TrustService } from "./trust.service";

const UuidSchema = z.string().uuid();
const CreateReportSchema = z
  .object({
    groupId: UuidSchema,
    subjectUserId: UuidSchema.nullish(),
    category: z.nativeEnum(ReportCategory),
    description: z.string().min(1).max(1_000),
  })
  .strict();

@Controller()
export class TrustController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TrustService) private readonly trust: TrustService,
  ) {}

  @Post("reports")
  @HttpCode(201)
  public async createReport(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ReportResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    const request = parseBody(CreateReportSchema, body);
    return this.trust.createReport(principal, request, idempotencyKey ?? "");
  }

  @Put("blocks/:userId")
  @HttpCode(204)
  public async blockUser(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("userId") userId: string,
  ): Promise<void> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    await this.trust.blockUser(principal, parseBody(UuidSchema, userId), idempotencyKey ?? "");
  }

  @Delete("blocks/:userId")
  @HttpCode(204)
  public async unblockUser(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("userId") userId: string,
  ): Promise<void> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    await this.trust.unblockUser(principal, parseBody(UuidSchema, userId), idempotencyKey ?? "");
  }
}
