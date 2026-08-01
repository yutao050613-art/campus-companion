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
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { parseBody } from "../auth/auth.controller";
import { adminSecurityContext } from "./admin-auth.controller";
import { type AdminReportResponse, AdminTrustService } from "./admin-trust.service";

const UuidSchema = z.string().uuid();
const DecisionSchema = z
  .object({
    decision: z.enum(["REVIEW", "RESOLVE", "REJECT", "RESTRICT_SUBJECT"]),
    reasonCode: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_:-]+$/u),
  })
  .strict();

@Controller("admin/reports")
export class AdminTrustController {
  public constructor(@Inject(AdminTrustService) private readonly trust: AdminTrustService) {}

  @Get()
  public list(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Query("campusId") campusId: string,
    @Query("cursor") cursor?: string,
  ): Promise<{
    readonly items: readonly AdminReportResponse[];
    readonly nextCursor: string | null;
  }> {
    return this.trust.listReports(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, campusId),
      cursor === undefined ? undefined : parseBody(UuidSchema, cursor),
    );
  }

  @Post(":reportId/decision")
  @HttpCode(200)
  public decide(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AdminReportResponse> {
    return this.trust.decideReport(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(UuidSchema, reportId),
      parseBody(DecisionSchema, body),
      idempotencyKey ?? "",
      String(request.id),
    );
  }
}
