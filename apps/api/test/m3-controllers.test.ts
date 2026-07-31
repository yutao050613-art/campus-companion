import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/auth/auth.service";
import { AdminCatalogController, CatalogController } from "../src/catalog/catalog.controller";
import type { AdminCatalogService, CatalogService } from "../src/catalog/catalog.service";
import {
  DemandController,
  FormationController,
  GroupController,
} from "../src/grouping/grouping.controller";
import type { GroupingService } from "../src/grouping/grouping.service";

const campusId = randomUUID();
const routeId = randomUUID();
const demandId = randomUUID();
const groupId = randomUUID();
const roundId = randomUUID();
const originId = randomUUID();
const destinationId = randomUUID();
const token = "m3.access.token";
const principal = { userId: randomUUID(), sessionId: randomUUID(), campusId };
const demand = {
  id: demandId,
  routeId,
  groupId,
  windowStart: "2026-08-02T10:00:00.000Z",
  windowEnd: "2026-08-02T10:30:00.000Z",
  seatCount: 1,
  status: "GROUPED",
  createdAt: "2026-08-01T08:00:00.000Z",
};
const group = {
  id: groupId,
  campusId,
  routeId,
  windowStart: demand.windowStart,
  windowEnd: demand.windowEnd,
  state: "READY",
  accountCount: 2,
  occupiedSeats: 2,
  remainingSeats: 2,
  members: [],
  activeRoundId: null,
  version: 2,
};
const round = {
  id: roundId,
  groupId,
  state: "CONFIRMING",
  memberCount: 2,
  memberSnapshotHash: "a".repeat(64),
  contactPolicyVersion: "contact-v1",
  confirmBy: "2026-08-01T08:05:00.000Z",
  payBy: null,
  createdAt: "2026-08-01T08:00:00.000Z",
};

function auth(): AuthService {
  return { authenticate: vi.fn().mockResolvedValue(principal) } as unknown as AuthService;
}

describe("M3 controllers", () => {
  it("adapts public catalog and audited route creation", async () => {
    const catalog = {
      listCampuses: vi.fn().mockResolvedValue([{ id: campusId, name: "白云校区" }]),
      listRoutes: vi.fn().mockResolvedValue([{ id: routeId }]),
    } as unknown as CatalogService;
    const publicController = new CatalogController(catalog);
    await expect(publicController.listCampuses()).resolves.toHaveLength(1);
    await expect(publicController.listRoutes(campusId, "2026-08-02")).resolves.toEqual([
      { id: routeId },
    ]);
    expect(() => publicController.listRoutes("bad", "2026-02-30")).toThrow();

    const admin = {
      createRoute: vi.fn().mockResolvedValue({ id: routeId }),
    } as unknown as AdminCatalogService;
    const adminController = new AdminCatalogController(admin);
    await expect(
      adminController.createRoute(
        "__Host-admin_session=session",
        "csrf",
        "https://admin.example",
        "same-origin",
        "m3-route-controller-key",
        {
          campusId,
          originId,
          destinationId,
          schedules: [{ weekday: 7, startTime: "18:00", endTime: "19:00", windowMinutes: 30 }],
        },
        { id: "request-m3-route" } as never,
      ),
    ).resolves.toEqual({ id: routeId });
    expect(admin.createRoute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: "session", csrfToken: "csrf" }),
      expect.anything(),
      "m3-route-controller-key",
      "request-m3-route",
    );
  });

  it("adapts demand create, list, get and cancellation with strict DTO validation", async () => {
    const grouping = {
      createDemand: vi.fn().mockResolvedValue(demand),
      listMyDemands: vi.fn().mockResolvedValue({ items: [demand], nextCursor: null }),
      getDemand: vi.fn().mockResolvedValue(demand),
      cancelDemand: vi.fn().mockResolvedValue(undefined),
    } as unknown as GroupingService;
    const controller = new DemandController(auth(), grouping);
    await expect(
      controller.create(`Bearer ${token}`, "m3-demand-controller-key", {
        routeId,
        windowStart: demand.windowStart,
        windowEnd: demand.windowEnd,
        seatCount: 1,
        luggage: "NONE",
        genderPreference: "ANY",
      }),
    ).resolves.toEqual(demand);
    await expect(
      controller.create(`Bearer ${token}`, undefined, {
        routeId,
        windowStart: demand.windowStart,
        windowEnd: demand.windowEnd,
        seatCount: 1,
        luggage: "SMALL",
        genderPreference: "SAME_GENDER_ONLY",
      }),
    ).resolves.toEqual(demand);
    await expect(controller.list(`Bearer ${token}`)).resolves.toMatchObject({ items: [demand] });
    await expect(controller.list(`Bearer ${token}`, demandId)).resolves.toMatchObject({
      items: [demand],
    });
    await expect(controller.get(`Bearer ${token}`, demandId)).resolves.toEqual(demand);
    await expect(
      controller.cancel(`Bearer ${token}`, "m3-cancel-controller-key", demandId),
    ).resolves.toBeUndefined();
    await expect(
      controller.cancel(`Bearer ${token}`, undefined, demandId),
    ).resolves.toBeUndefined();
    await expect(
      controller.create(`Bearer ${token}`, undefined, {
        routeId,
        windowStart: demand.windowStart,
        windowEnd: demand.windowEnd,
        seatCount: 5,
        luggage: "NONE",
        genderPreference: "ANY",
      }),
    ).rejects.toThrow();
  });

  it("adapts group browse, join, leave and formation start", async () => {
    const grouping = {
      listGroups: vi.fn().mockResolvedValue({ items: [group], nextCursor: null }),
      getGroup: vi.fn().mockResolvedValue(group),
      joinGroup: vi.fn().mockResolvedValue(group),
      leaveGroup: vi.fn().mockResolvedValue(group),
      startFormation: vi.fn().mockResolvedValue(round),
    } as unknown as GroupingService;
    const controller = new GroupController(auth(), grouping);
    await expect(
      controller.list(`Bearer ${token}`, routeId, demand.windowStart),
    ).resolves.toMatchObject({ items: [group] });
    await expect(
      controller.list(`Bearer ${token}`, routeId, demand.windowStart, groupId),
    ).resolves.toMatchObject({ items: [group] });
    await expect(controller.get(`Bearer ${token}`, groupId)).resolves.toEqual(group);
    await expect(
      controller.join(`Bearer ${token}`, "m3-join-controller-key", groupId, { demandId }),
    ).resolves.toEqual(group);
    await expect(
      controller.join(`Bearer ${token}`, undefined, groupId, { demandId }),
    ).resolves.toEqual(group);
    await expect(
      controller.leave(`Bearer ${token}`, "m3-leave-controller-key", groupId),
    ).resolves.toEqual(group);
    await expect(controller.leave(`Bearer ${token}`, undefined, groupId)).resolves.toEqual(group);
    await expect(
      controller.startFormation(`Bearer ${token}`, "m3-start-controller-key", groupId),
    ).resolves.toEqual(round);
    await expect(controller.startFormation(`Bearer ${token}`, undefined, groupId)).resolves.toEqual(
      round,
    );
    await expect(
      controller.join(`Bearer ${token}`, undefined, groupId, { demandId: "bad" }),
    ).rejects.toThrow();
  });

  it("adapts member-only round reads and both immutable decisions", async () => {
    const grouping = {
      getFormation: vi.fn().mockResolvedValue(round),
      confirmFormation: vi.fn().mockResolvedValue(round),
    } as unknown as GroupingService;
    const controller = new FormationController(auth(), grouping);
    await expect(controller.get(`Bearer ${token}`, roundId)).resolves.toEqual(round);
    await expect(
      controller.confirm(`Bearer ${token}`, "m3-confirm-controller-key", roundId, {
        decision: "ACCEPT",
        contactConsent: { granted: true, policyVersion: "contact-v1" },
      }),
    ).resolves.toEqual(round);
    await expect(
      controller.confirm(`Bearer ${token}`, undefined, roundId, { decision: "DECLINE" }),
    ).resolves.toEqual(round);
    await expect(
      controller.confirm(`Bearer ${token}`, undefined, roundId, {
        decision: "ACCEPT",
        contactConsent: { granted: false, policyVersion: "contact-v1" },
      }),
    ).rejects.toThrow();
  });
});
