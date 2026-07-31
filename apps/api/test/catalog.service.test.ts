import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AdminAuthService } from "../src/admin/admin-auth.service";
import { AdminCatalogService, CatalogService } from "../src/catalog/catalog.service";
import type { PrismaService } from "../src/database/prisma.service";
import type { IdempotencyService } from "../src/m2/idempotency.service";

const campusId = randomUUID();
const originId = randomUUID();
const destinationId = randomUUID();
const routeId = randomUUID();
const adminUserId = randomUUID();
const now = new Date("2026-08-01T08:00:00.000Z");

function prisma(value: Record<string, unknown>): PrismaService {
  return value as unknown as PrismaService;
}

function idempotency(transaction: Record<string, unknown>): IdempotencyService {
  return {
    execute: vi.fn(async (_operation, _key, _actor, _request, action) => ({
      ...(await action(transaction as never)),
      replayed: false,
    })),
  } as unknown as IdempotencyService;
}

describe("catalog services", () => {
  it("lists only enabled campuses and generates exact fixed route windows", async () => {
    const service = new CatalogService(
      prisma({
        campus: {
          findMany: vi.fn().mockResolvedValue([{ id: campusId, name: "白云校区" }]),
          findFirst: vi.fn().mockResolvedValue({ id: campusId, timezone: "Asia/Shanghai" }),
        },
        route: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: routeId,
              campusId,
              originId,
              destinationId,
              origin: { id: originId, name: "主门", type: "CAMPUS_GATE" },
              destination: { id: destinationId, name: "交通站", type: "TRANSIT_HUB" },
              schedules: [
                {
                  id: randomUUID(),
                  startMinute: 1_020,
                  endMinute: 1_080,
                  windowMinutes: 30,
                },
              ],
            },
          ]),
        },
      }),
    );
    await expect(service.listCampuses()).resolves.toEqual([{ id: campusId, name: "白云校区" }]);
    await expect(service.listRoutes(campusId, "2026-08-01")).resolves.toEqual([
      expect.objectContaining({
        id: routeId,
        windows: [
          { start: "2026-08-01T09:00:00.000Z", end: "2026-08-01T09:30:00.000Z" },
          { start: "2026-08-01T09:30:00.000Z", end: "2026-08-01T10:00:00.000Z" },
        ],
      }),
    ]);
  });

  it("fails closed for invalid dates and missing campuses", async () => {
    const service = new CatalogService(
      prisma({
        campus: { findFirst: vi.fn().mockResolvedValue(null) },
        route: { findMany: vi.fn() },
      }),
    );
    await expect(service.listRoutes(campusId, "2026-02-29")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.listRoutes(campusId, "2026-08-01")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("creates an audited campus-scoped route through administrator auth and idempotency", async () => {
    const route = {
      id: routeId,
      campusId,
      originId,
      destinationId,
      status: "ACTIVE",
      schedules: [{ weekday: 6, startMinute: 1_020, endMinute: 1_080, windowMinutes: 30 }],
    };
    const transaction = {
      campus: { findFirst: vi.fn().mockResolvedValue({ id: campusId, timezone: "Asia/Shanghai" }) },
      place: { findMany: vi.fn().mockResolvedValue([{ id: originId }, { id: destinationId }]) },
      route: { create: vi.fn().mockResolvedValue(route) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const auth = {
      authenticate: vi.fn().mockResolvedValue({ adminUserId, roles: ["ROUTE_MANAGER"] }),
    } as unknown as AdminAuthService;
    const result = await new AdminCatalogService(auth, idempotency(transaction)).createRoute(
      { sessionToken: "session", csrfToken: "csrf", origin: "https://admin.example" },
      {
        campusId,
        originId,
        destinationId,
        schedules: [{ weekday: 6, startTime: "17:00", endTime: "18:00", windowMinutes: 30 }],
      },
      "m3-admin-route-create-0001",
      "request-route",
      now,
    );
    expect(result).toMatchObject({ id: routeId, campusId, status: "ACTIVE" });
    expect(auth.authenticate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCsrf: true, role: "ROUTE_MANAGER", campusId }),
      now,
    );
    expect(transaction.auditLog.create).toHaveBeenCalledOnce();
  });

  it("rejects malformed schedules and cross-campus or identical places before mutation", async () => {
    const auth = {
      authenticate: vi.fn().mockResolvedValue({ adminUserId }),
    } as unknown as AdminAuthService;
    const execute = idempotency({});
    const service = new AdminCatalogService(auth, execute);
    await expect(
      service.createRoute(
        { sessionToken: "session", origin: "https://admin.example" },
        {
          campusId,
          originId,
          destinationId,
          schedules: [{ weekday: 6, startTime: "18:00", endTime: "17:00", windowMinutes: 30 }],
        },
        "m3-admin-route-invalid-01",
        "request-invalid",
        now,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const transaction = {
      campus: { findFirst: vi.fn().mockResolvedValue({ id: campusId, timezone: "Asia/Shanghai" }) },
      place: { findMany: vi.fn().mockResolvedValue([{ id: originId }]) },
    };
    await expect(
      new AdminCatalogService(auth, idempotency(transaction)).createRoute(
        { sessionToken: "session", origin: "https://admin.example" },
        {
          campusId,
          originId,
          destinationId,
          schedules: [{ weekday: 6, startTime: "17:00", endTime: "18:00", windowMinutes: 30 }],
        },
        "m3-admin-route-missing-01",
        "request-missing",
        now,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
