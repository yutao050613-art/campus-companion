import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { adminSecurityContext } from "../admin/admin-auth.controller";
import { parseBody } from "../auth/auth.controller";
import { AdminCatalogService, CatalogService, type RouteCatalogResponse } from "./catalog.service";

const UuidSchema = z.string().uuid();
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const AdminRouteSchema = z
  .object({
    campusId: z.string().uuid(),
    originId: z.string().uuid(),
    destinationId: z.string().uuid(),
    schedules: z
      .array(
        z
          .object({
            weekday: z.number().int().min(1).max(7),
            startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
            endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
            windowMinutes: z.union([z.literal(15), z.literal(30)]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

@Controller("campuses")
export class CatalogController {
  public constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  public listCampuses(): Promise<readonly { readonly id: string; readonly name: string }[]> {
    return this.catalog.listCampuses();
  }

  @Get(":campusId/routes")
  public listRoutes(
    @Param("campusId") campusId: string,
    @Query("date") date: string,
  ): Promise<readonly RouteCatalogResponse[]> {
    return this.catalog.listRoutes(parseBody(UuidSchema, campusId), parseBody(DateSchema, date));
  }
}

@Controller("admin/routes")
export class AdminCatalogController {
  public constructor(@Inject(AdminCatalogService) private readonly catalog: AdminCatalogService) {}

  @Post()
  public createRoute(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.catalog.createRoute(
      adminSecurityContext({ cookie, csrfToken, origin, fetchSite }),
      parseBody(AdminRouteSchema, body),
      idempotencyKey ?? "",
      String(request.id),
    );
  }
}
