import { CatalogStatus, Prisma } from "@campus/database";
import { Inject, Injectable } from "@nestjs/common";
import { AdminAuthService } from "../admin/admin-auth.service";
import { ApplicationError } from "../common/application-error";
import { PrismaService } from "../database/prisma.service";
import { IdempotencyService } from "../m2/idempotency.service";
import {
  dateDetailsInZone,
  generateWindowsForDate,
  isoWeekday,
  parseIsoDate,
} from "./route-windows";

export interface RouteCatalogResponse {
  readonly id: string;
  readonly campusId: string;
  readonly origin: { readonly id: string; readonly name: string; readonly type: string };
  readonly destination: { readonly id: string; readonly name: string; readonly type: string };
  readonly windows: readonly { readonly start: string; readonly end: string }[];
}

export interface AdminRouteInput {
  readonly campusId: string;
  readonly originId: string;
  readonly destinationId: string;
  readonly schedules: readonly {
    readonly weekday: number;
    readonly startTime: string;
    readonly endTime: string;
    readonly windowMinutes: 15 | 30;
  }[];
}

export interface AdminSecurityInput {
  readonly sessionToken: string;
  readonly csrfToken?: string;
  readonly origin: string;
  readonly fetchSite?: string;
}

@Injectable()
export class CatalogService {
  public constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  public async listCampuses(): Promise<readonly { readonly id: string; readonly name: string }[]> {
    return this.prisma.campus.findMany({
      where: { status: CatalogStatus.ACTIVE },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    });
  }

  public async listRoutes(
    campusId: string,
    requestedDate: string,
  ): Promise<readonly RouteCatalogResponse[]> {
    let date: string;
    try {
      date = parseIsoDate(requestedDate);
    } catch {
      throw new ApplicationError("VALIDATION_ERROR", "route date is invalid", 400, {
        field: "date",
        constraint: "date",
      });
    }
    const campus = await this.prisma.campus.findFirst({
      where: { id: campusId, status: CatalogStatus.ACTIVE },
      select: { id: true, timezone: true },
    });
    if (campus === null) throw catalogNotFound();
    const calendarDate = new Date(`${date}T00:00:00.000Z`);
    const weekday = isoWeekday(date);
    const routes = await this.prisma.route.findMany({
      where: {
        campusId,
        status: CatalogStatus.ACTIVE,
        origin: { status: CatalogStatus.ACTIVE },
        destination: { status: CatalogStatus.ACTIVE },
      },
      include: {
        origin: true,
        destination: true,
        schedules: {
          where: {
            weekday,
            activeFrom: { lte: calendarDate },
            OR: [{ activeUntil: null }, { activeUntil: { gte: calendarDate } }],
          },
          orderBy: [{ startMinute: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ originId: "asc" }, { destinationId: "asc" }, { id: "asc" }],
    });
    return routes
      .map((route) => ({
        id: route.id,
        campusId: route.campusId,
        origin: { id: route.origin.id, name: route.origin.name, type: route.origin.type },
        destination: {
          id: route.destination.id,
          name: route.destination.name,
          type: route.destination.type,
        },
        windows: route.schedules.flatMap((schedule) =>
          generateWindowsForDate(date, campus.timezone, schedule).map((window) => ({
            start: window.start.toISOString(),
            end: window.end.toISOString(),
          })),
        ),
      }))
      .filter((route) => route.windows.length > 0);
  }
}

@Injectable()
export class AdminCatalogService {
  public constructor(
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  public async createRoute(
    security: AdminSecurityInput,
    input: AdminRouteInput,
    idempotencyKey: string,
    requestId: string,
    now = new Date(),
  ): Promise<Readonly<Record<string, unknown>>> {
    const principal = await this.adminAuth.authenticate(
      security,
      {
        requireCsrf: true,
        role: "ROUTE_MANAGER",
        campusId: input.campusId,
      },
      now,
    );
    const schedules = input.schedules.map((schedule) => ({
      weekday: schedule.weekday,
      startMinute: parseClock(schedule.startTime),
      endMinute: parseClock(schedule.endTime),
      windowMinutes: schedule.windowMinutes,
    }));
    if (
      schedules.length === 0 ||
      schedules.some(
        (schedule) =>
          schedule.startMinute >= schedule.endMinute ||
          schedule.startMinute + schedule.windowMinutes > schedule.endMinute,
      )
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "route schedule is invalid", 400, {
        field: "schedules",
        constraint: "window",
      });
    }
    try {
      const result = await this.idempotency.execute(
        "createRoute",
        idempotencyKey,
        { adminUserId: principal.adminUserId, campusId: input.campusId },
        input,
        async (transaction) => {
          const campus = await transaction.campus.findFirst({
            where: { id: input.campusId, status: CatalogStatus.ACTIVE },
          });
          if (campus === null) throw catalogNotFound();
          const places = await transaction.place.findMany({
            where: {
              id: { in: [input.originId, input.destinationId] },
              campusId: input.campusId,
              status: CatalogStatus.ACTIVE,
            },
          });
          if (input.originId === input.destinationId || places.length !== 2) {
            throw catalogNotFound();
          }
          const activeFromDate = dateDetailsInZone(now, campus.timezone).date;
          const activeFrom = new Date(`${activeFromDate}T00:00:00.000Z`);
          const route = await transaction.route.create({
            data: {
              campusId: input.campusId,
              originId: input.originId,
              destinationId: input.destinationId,
              schedules: {
                create: schedules.map((schedule) => ({
                  campusId: input.campusId,
                  ...schedule,
                  activeFrom,
                })),
              },
            },
            include: { schedules: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] } },
          });
          await transaction.auditLog.create({
            data: {
              actorAdminId: principal.adminUserId,
              campusId: input.campusId,
              action: "ROUTE_CREATED",
              targetType: "Route",
              targetId: route.id,
              requestId,
            },
          });
          return {
            status: 201,
            body: {
              id: route.id,
              campusId: route.campusId,
              originId: route.originId,
              destinationId: route.destinationId,
              status: route.status,
              schedules: route.schedules.map((schedule) => ({
                weekday: schedule.weekday,
                startMinute: schedule.startMinute,
                endMinute: schedule.endMinute,
                windowMinutes: schedule.windowMinutes,
              })),
            },
          };
        },
        now,
      );
      return result.body as Readonly<Record<string, unknown>>;
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ApplicationError("IDEMPOTENCY_CONFLICT", "route already exists", 409);
      }
      throw error;
    }
  }
}

function parseClock(value: string): number {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  if (match === null) {
    throw new ApplicationError("VALIDATION_ERROR", "route schedule is invalid", 400, {
      field: "schedules",
      constraint: "time",
    });
  }
  return Number.parseInt(match[1] ?? "", 10) * 60 + Number.parseInt(match[2] ?? "", 10);
}

function catalogNotFound(): ApplicationError {
  return new ApplicationError("RESOURCE_NOT_FOUND", "catalog resource was not found", 404);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
