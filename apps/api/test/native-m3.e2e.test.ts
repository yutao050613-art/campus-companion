import { Writable } from "node:stream";
import { issueMockWechatCode } from "@campus/auth";
import {
  createPrismaClient,
  DemandStatus,
  GenderDeclaration,
  GroupState,
  MemberStatus,
  PlaceType,
  PolicyType,
  RoundState,
  VerificationStatus,
} from "@campus/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const ids = {
  campus: "30000000-0000-4000-8000-000000000001",
  sensitivePolicy: "30000000-0000-4000-8000-000000000002",
  contactPolicy: "30000000-0000-4000-8000-000000000003",
  origin: "30000000-0000-4000-8000-000000000004",
  destination: "30000000-0000-4000-8000-000000000005",
  route: "30000000-0000-4000-8000-000000000006",
} as const;
const mockSecret = "m3-mock-wechat-signing-secret-longer-than-thirty-two-bytes";
const accessSecret = "m3-access-token-signing-secret-longer-than-thirty-two-bytes";
const studentSecret = "m3-student-number-hmac-secret-longer-than-thirty-two-bytes";
const uploadSecret = "m3-upload-token-signing-secret-longer-than-thirty-two-bytes";
const encryptionKey = Buffer.alloc(32, 11);

interface UserSessionBody {
  readonly accessToken: string;
  readonly user: { readonly id: string; readonly campusId: string };
}

interface DemandBody {
  readonly id: string;
  readonly groupId: string;
  readonly routeId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly status: string;
}

interface GroupBody {
  readonly id: string;
  readonly state: string;
  readonly accountCount: number;
  readonly occupiedSeats: number;
  readonly remainingSeats: number;
  readonly members: readonly { readonly displayName: string; readonly seatCount: number }[];
  readonly activeRoundId: string | null;
}

interface FormationBody {
  readonly id: string;
  readonly groupId: string;
  readonly state: string;
  readonly memberCount: number;
  readonly contactPolicyVersion: string;
}

interface InjectResponse {
  readonly statusCode: number;
  readonly rawPayload: Buffer;
  json<T = unknown>(): T;
}

describe.runIf(runNative)("M3 native PostgreSQL grouping API", () => {
  let app: NestFastifyApplication;
  let windowStart = "";
  let windowEnd = "";
  const sessions: Record<string, UserSessionBody> = {};

  beforeAll(async () => {
    const date = futureLocalDate();
    windowStart = `${date}T10:00:00.000Z`;
    windowEnd = `${date}T10:30:00.000Z`;
    const weekdayRaw = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const weekday = weekdayRaw === 0 ? 7 : weekdayRaw;
    Object.assign(process.env, {
      NODE_ENV: "test",
      WECHAT_AUTH_PROVIDER: "mock",
      WECHAT_MOCK_DEFAULT_CAMPUS_ID: ids.campus,
      WECHAT_MOCK_SIGNING_SECRET: mockSecret,
      AUTH_ACCESS_TOKEN_SECRET: accessSecret,
      STUDENT_NUMBER_HMAC_SECRET: studentSecret,
      DATA_ENCRYPTION_KEY_BASE64: encryptionKey.toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "m3-native-test",
      LOCAL_OBJECT_UPLOAD_SECRET: uploadSecret,
      LOCAL_OBJECT_STORE_ROOT: "D:\\campus-companion-m3-native-objects",
      PUBLIC_API_BASE_URL: "http://127.0.0.1:3000",
      ADMIN_TRUSTED_ORIGINS: "http://127.0.0.1:5173",
    });
    await cleanup();
    await prisma.campus.create({
      data: { id: ids.campus, name: "M3 Native Campus", timezone: "Asia/Shanghai" },
    });
    await prisma.policyVersion.createMany({
      data: [
        {
          id: ids.sensitivePolicy,
          type: PolicyType.SENSITIVE_INFO,
          version: "sensitive-info-m3-native",
          contentDigest: "a".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
        {
          id: ids.contactPolicy,
          type: PolicyType.CONTACT_SHARING,
          version: "contact-sharing-m3-native",
          contentDigest: "b".repeat(64),
          effectiveAt: new Date(Date.now() - 60_000),
        },
      ],
    });
    await prisma.place.createMany({
      data: [
        { id: ids.origin, campusId: ids.campus, name: "白云校区主门", type: PlaceType.CAMPUS_GATE },
        {
          id: ids.destination,
          campusId: ids.campus,
          name: "固定交通站",
          type: PlaceType.TRANSIT_HUB,
        },
      ],
    });
    await prisma.route.create({
      data: {
        id: ids.route,
        campusId: ids.campus,
        originId: ids.origin,
        destinationId: ids.destination,
        schedules: {
          create: {
            campusId: ids.campus,
            weekday,
            startMinute: 1_080,
            endMinute: 1_200,
            windowMinutes: 30,
            activeFrom: new Date(`${date}T00:00:00.000Z`),
          },
        },
      },
    });
    app = await createApp({
      level: "silent",
      destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    for (const subject of ["a", "b", "c", "d", "e", "unverified"]) {
      sessions[subject] = await login(subject);
    }
    const verifiedSubjects = ["a", "b", "c", "d", "e"];
    for (const [index, subject] of verifiedSubjects.entries()) {
      const session = sessions[subject];
      if (session === undefined) throw new Error("missing native session");
      await prisma.user.update({
        where: { id: session.user.id },
        data: { genderDeclaration: GenderDeclaration.FEMALE },
      });
      await prisma.studentVerification.create({
        data: {
          userId: session.user.id,
          campusId: ids.campus,
          studentNumberDigest: (index + 1).toString(16).padStart(64, "0"),
          studentNumberLast4: (index + 1).toString().padStart(4, "0"),
          status: VerificationStatus.VERIFIED,
          consentPolicyId: ids.sensitivePolicy,
          submittedAt: new Date(),
          latestSubmittedAt: new Date(),
          reviewedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  }, 30_000);

  it("repeats the concurrent fourth-seat race for 20 rounds without overselling", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const demands: Record<string, DemandBody> = {};
        for (const subject of ["a", "b", "c", "d", "e"]) {
          const response = await request(
            "POST",
            "/v1/demands",
            {
              routeId: ids.route,
              windowStart,
              windowEnd,
              seatCount: 1,
              luggage: "NONE",
              genderPreference: "SAME_GENDER_ONLY",
            },
            {
              ...auth(subject),
              "idempotency-key": `m3-race-${attempt}-${subject}-create-demand`,
            },
          );
          expect(response.statusCode).toBe(201);
          demands[subject] = response.json<DemandBody>();
        }
        const targetGroupId = demands["a"]?.groupId;
        if (targetGroupId === undefined) throw new Error("race target group was not created");

        for (const subject of ["b", "c"]) {
          const response = await request(
            "POST",
            `/v1/groups/${targetGroupId}/join`,
            { demandId: demands[subject]?.id },
            {
              ...auth(subject),
              "idempotency-key": `m3-race-${attempt}-${subject}-join-group`,
            },
          );
          expect(response.statusCode).toBe(200);
        }
        const contenders = await Promise.all(
          ["d", "e"].map((subject) =>
            request(
              "POST",
              `/v1/groups/${targetGroupId}/join`,
              { demandId: demands[subject]?.id },
              {
                ...auth(subject),
                "idempotency-key": `m3-race-${attempt}-${subject}-join-group`,
              },
            ),
          ),
        );
        expect(contenders.filter((response) => response.statusCode === 200)).toHaveLength(1);
        expect(contenders.filter((response) => response.statusCode === 409)).toHaveLength(1);

        const activeMembers = await prisma.groupMember.findMany({
          where: {
            groupId: targetGroupId,
            status: {
              in: [
                MemberStatus.JOINED,
                MemberStatus.CONFIRMED,
                MemberStatus.PAYMENT_PENDING,
                MemberStatus.PAID,
                MemberStatus.CONTACT_UNLOCKED,
              ],
            },
          },
          select: { userId: true, seatCount: true },
        });
        expect(new Set(activeMembers.map((member) => member.userId)).size).toBe(4);
        expect(activeMembers.reduce((sum, member) => sum + member.seatCount, 0)).toBe(4);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 120_000);

  it("repeats overlapping-group membership races for 20 rounds", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const demands: Record<string, DemandBody> = {};
        for (const subject of ["a", "b", "c"]) {
          const response = await request(
            "POST",
            "/v1/demands",
            {
              routeId: ids.route,
              windowStart,
              windowEnd,
              seatCount: 1,
              luggage: "NONE",
              genderPreference: "SAME_GENDER_ONLY",
            },
            { ...auth(subject), "idempotency-key": `m3-overlap-${attempt}-${subject}-demand` },
          );
          expect(response.statusCode).toBe(201);
          demands[subject] = response.json<DemandBody>();
        }
        const demandA = demands["a"];
        const groupB = demands["b"]?.groupId;
        const groupC = demands["c"]?.groupId;
        const sessionA = sessions["a"];
        if (
          demandA === undefined ||
          groupB === undefined ||
          groupC === undefined ||
          sessionA === undefined
        ) {
          throw new Error("overlap race fixtures were not created");
        }
        const contenders = await Promise.all(
          [groupB, groupC].map((groupId, index) =>
            request(
              "POST",
              `/v1/groups/${groupId}/join`,
              { demandId: demandA.id },
              {
                ...auth("a"),
                "idempotency-key": `m3-overlap-${attempt}-a-target-${index}`,
              },
            ),
          ),
        );
        expect(contenders.filter((response) => response.statusCode === 200)).toHaveLength(1);
        expect(contenders.filter((response) => response.statusCode === 409)).toHaveLength(1);
        expect(
          await prisma.groupMember.count({
            where: { userId: sessionA.user.id, status: MemberStatus.JOINED },
          }),
        ).toBe(1);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 120_000);

  it("repeats four-member concurrent confirmation for 20 rounds", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const demands: Record<string, DemandBody> = {};
        for (const subject of ["a", "b", "c", "d"]) {
          const response = await request(
            "POST",
            "/v1/demands",
            {
              routeId: ids.route,
              windowStart,
              windowEnd,
              seatCount: 1,
              luggage: "NONE",
              genderPreference: "SAME_GENDER_ONLY",
            },
            {
              ...auth(subject),
              "idempotency-key": `m3-confirm-race-${attempt}-${subject}-demand`,
            },
          );
          expect(response.statusCode).toBe(201);
          demands[subject] = response.json<DemandBody>();
        }
        const targetGroupId = demands["a"]?.groupId;
        if (targetGroupId === undefined) throw new Error("confirmation target was not created");
        for (const subject of ["b", "c", "d"]) {
          const response = await request(
            "POST",
            `/v1/groups/${targetGroupId}/join`,
            { demandId: demands[subject]?.id },
            {
              ...auth(subject),
              "idempotency-key": `m3-confirm-race-${attempt}-${subject}-join`,
            },
          );
          expect(response.statusCode).toBe(200);
        }
        const started = await request(
          "POST",
          `/v1/groups/${targetGroupId}/formation-rounds`,
          undefined,
          { ...auth("a"), "idempotency-key": `m3-confirm-race-${attempt}-start` },
        );
        expect(started.statusCode).toBe(201);
        const round = started.json<FormationBody>();
        const confirmations = await Promise.all(
          ["a", "b", "c", "d"].map((subject) =>
            confirm(subject, round.id, `m3-confirm-race-${attempt}-${subject}-accept`, {
              decision: "ACCEPT",
              contactConsent: { granted: true, policyVersion: round.contactPolicyVersion },
            }),
          ),
        );
        expect(confirmations.every((response) => response.statusCode === 200)).toBe(true);
        expect(
          confirmations.filter((response) => response.json<FormationBody>().state === "PAYING"),
        ).toHaveLength(1);
        expect(await prisma.formationRound.findUnique({ where: { id: round.id } })).toMatchObject({
          state: "PAYING",
        });
        expect(await prisma.memberConfirmation.count({ where: { roundId: round.id } })).toBe(4);
        expect(await prisma.contactConsent.count({ where: { roundId: round.id } })).toBe(4);
      } finally {
        await cleanupGroupingData();
      }
    }
  }, 180_000);

  it("invalidates a declined round and returns the remaining member to recruiting", async () => {
    try {
      const demands: Record<string, DemandBody> = {};
      for (const subject of ["a", "b"]) {
        const response = await request(
          "POST",
          "/v1/demands",
          {
            routeId: ids.route,
            windowStart,
            windowEnd,
            seatCount: 1,
            luggage: "NONE",
            genderPreference: "SAME_GENDER_ONLY",
          },
          { ...auth(subject), "idempotency-key": `m3-decline-${subject}-demand` },
        );
        expect(response.statusCode).toBe(201);
        demands[subject] = response.json<DemandBody>();
      }
      const targetGroupId = demands["a"]?.groupId;
      const demandB = demands["b"];
      if (targetGroupId === undefined || demandB === undefined) {
        throw new Error("decline target was not created");
      }
      expect(
        (
          await request(
            "POST",
            `/v1/groups/${targetGroupId}/join`,
            { demandId: demandB.id },
            { ...auth("b"), "idempotency-key": "m3-decline-b-join-group" },
          )
        ).statusCode,
      ).toBe(200);
      const started = await request(
        "POST",
        `/v1/groups/${targetGroupId}/formation-rounds`,
        undefined,
        { ...auth("a"), "idempotency-key": "m3-decline-start-round" },
      );
      expect(started.statusCode).toBe(201);
      const round = started.json<FormationBody>();
      const declined = await confirm("b", round.id, "m3-decline-b-decision", {
        decision: "DECLINE",
      });
      expect(declined.statusCode).toBe(200);
      expect(await prisma.formationRound.findUnique({ where: { id: round.id } })).toMatchObject({
        state: RoundState.INVALIDATED,
        invalidationReason: "MEMBER_DECLINED",
      });
      expect(
        await prisma.companionGroup.findUnique({ where: { id: targetGroupId } }),
      ).toMatchObject({
        state: GroupState.RECRUITING,
      });
      expect(await prisma.groupMember.findFirst({ where: { demandId: demandB.id } })).toMatchObject(
        {
          status: MemberStatus.DECLINED,
        },
      );
      expect(await prisma.travelDemand.findUnique({ where: { id: demandB.id } })).toMatchObject({
        status: DemandStatus.OPEN,
      });
      expect(await prisma.serviceOrder.count({ where: { roundId: round.id } })).toBe(0);
    } finally {
      await cleanupGroupingData();
    }
  });

  it("runs fixed-route grouping through the M4 boundary without oversell or disclosure", async () => {
    const date = windowStart.slice(0, 10);
    const catalog = await request("GET", `/v1/campuses/${ids.campus}/routes?date=${date}`);
    expect(catalog.statusCode).toBe(200);
    expect(
      catalog.json<readonly { id: string; windows: readonly { start: string }[] }[]>(),
    ).toEqual([
      expect.objectContaining({
        id: ids.route,
        windows: expect.arrayContaining([expect.objectContaining({ start: windowStart })]),
      }),
    ]);

    expect(
      (
        await request(
          "GET",
          `/v1/groups?routeId=${ids.route}&windowStart=${encodeURIComponent(windowStart)}`,
          undefined,
          auth("unverified"),
        )
      ).statusCode,
    ).toBe(403);

    const demands: Record<string, DemandBody> = {};
    for (const subject of ["a", "b", "c", "d", "e"]) {
      const response = await request(
        "POST",
        "/v1/demands",
        {
          routeId: ids.route,
          windowStart,
          windowEnd,
          seatCount: 1,
          luggage: "NONE",
          genderPreference: "SAME_GENDER_ONLY",
        },
        { ...auth(subject), "idempotency-key": `m3-create-demand-${subject}-0001` },
      );
      expect(response.statusCode).toBe(201);
      demands[subject] = response.json<DemandBody>();
    }
    const targetGroupId = demands["a"]?.groupId;
    if (targetGroupId === undefined) throw new Error("target group was not created");

    for (const subject of ["b", "c"]) {
      const response = await join(subject, targetGroupId, demands[subject]?.id ?? "");
      expect(response.statusCode, `${subject}: ${response.rawPayload.toString("utf8")}`).toBe(200);
    }
    const contenders = await Promise.all([
      join("d", targetGroupId, demands["d"]?.id ?? ""),
      join("e", targetGroupId, demands["e"]?.id ?? ""),
    ]);
    expect(contenders.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(contenders.filter((response) => response.statusCode === 409)).toHaveLength(1);
    const winner = contenders[0]?.statusCode === 200 ? "d" : "e";
    const loser = winner === "d" ? "e" : "d";

    const groupResponse = await request("GET", `/v1/groups/${targetGroupId}`, undefined, auth("a"));
    expect(groupResponse.statusCode).toBe(200);
    const group = groupResponse.json<GroupBody>();
    expect(group).toMatchObject({
      state: "READY",
      accountCount: 4,
      occupiedSeats: 4,
      remainingSeats: 0,
    });
    expect(group.members).toHaveLength(4);
    const serializedGroup = groupResponse.rawPayload.toString("utf8");
    expect(serializedGroup).not.toMatch(/wechat|contact|userId|gender/i);
    expect(group.members.every((member) => member.displayName.startsWith("同行成员-"))).toBe(true);

    const started = await request(
      "POST",
      `/v1/groups/${targetGroupId}/formation-rounds`,
      undefined,
      { ...auth("a"), "idempotency-key": "m3-start-formation-0001" },
    );
    expect(started.statusCode).toBe(201);
    const round = started.json<FormationBody>();
    expect(round).toMatchObject({
      state: "CONFIRMING",
      memberCount: 4,
      contactPolicyVersion: "contact-sharing-m3-native",
    });
    expect(
      (await request("GET", `/v1/formation-rounds/${round.id}`, undefined, auth("b"))).statusCode,
    ).toBe(200);
    expect(
      (await request("GET", `/v1/formation-rounds/${round.id}`, undefined, auth(loser))).statusCode,
    ).toBe(404);

    const wrongPolicy = await confirm("b", round.id, "m3-confirm-wrong-policy", {
      decision: "ACCEPT",
      contactConsent: { granted: true, policyVersion: "attacker-version" },
    });
    expect(wrongPolicy.statusCode).toBe(409);
    expect(await prisma.memberConfirmation.count({ where: { roundId: round.id } })).toBe(0);
    expect(await prisma.contactConsent.count({ where: { roundId: round.id } })).toBe(0);

    const members = ["a", "b", "c", winner];
    const confirmations = await Promise.all(
      members.map((subject) =>
        confirm(subject, round.id, `m3-confirm-${subject}-0001`, {
          decision: "ACCEPT",
          contactConsent: { granted: true, policyVersion: round.contactPolicyVersion },
        }),
      ),
    );
    for (const response of confirmations) {
      expect(response.statusCode, response.rawPayload.toString("utf8")).toBe(200);
      expect(["CONFIRMING", "PAYING"]).toContain(response.json<FormationBody>().state);
    }
    expect(
      confirmations.filter((response) => response.json<FormationBody>().state === "PAYING"),
    ).toHaveLength(1);
    expect(await prisma.formationRound.findUnique({ where: { id: round.id } })).toMatchObject({
      state: "PAYING",
    });
    const replay = await confirm("a", round.id, "m3-confirm-a-0001", {
      decision: "ACCEPT",
      contactConsent: { granted: true, policyVersion: round.contactPolicyVersion },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<FormationBody>()).toEqual(confirmations[0]?.json<FormationBody>());

    expect(await prisma.serviceOrder.count({ where: { roundId: round.id } })).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.refund.count()).toBe(0);
    expect(await prisma.contactUnlock.count({ where: { roundId: round.id } })).toBe(0);
    expect(
      (await request("GET", `/v1/groups/${targetGroupId}/contacts`, undefined, auth("a")))
        .statusCode,
    ).toBe(404);
  }, 60_000);

  async function login(subject: string): Promise<UserSessionBody> {
    const response = await request("POST", "/v1/auth/wechat/login", {
      code: issueMockWechatCode(`m3-${subject}`, mockSecret, new Date(Date.now() + 60_000)),
    });
    expect(response.statusCode).toBe(200);
    return response.json<UserSessionBody>();
  }

  function auth(subject: string): Record<string, string> {
    const session = sessions[subject];
    if (session === undefined) throw new Error(`missing session ${subject}`);
    return { authorization: `Bearer ${session.accessToken}` };
  }

  function join(subject: string, groupId: string, demandId: string): Promise<InjectResponse> {
    return request(
      "POST",
      `/v1/groups/${groupId}/join`,
      { demandId },
      {
        ...auth(subject),
        "idempotency-key": `m3-join-${subject}-0000001`,
      },
    );
  }

  function confirm(
    subject: string,
    roundId: string,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<InjectResponse> {
    return request("POST", `/v1/formation-rounds/${roundId}/confirm`, payload, {
      ...auth(subject),
      "idempotency-key": idempotencyKey,
    });
  }

  async function request(
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<InjectResponse> {
    return (await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as never }),
      })) as InjectResponse;
  }
});

function futureLocalDate(): string {
  const date = new Date(Date.now() + 3 * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function cleanup(): Promise<void> {
  await prisma.contactAccessLog.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactUnlock.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactConsent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.memberConfirmation.deleteMany({ where: { campusId: ids.campus } });
  await prisma.refund.deleteMany({ where: { campusId: ids.campus } });
  await prisma.paymentTransaction.deleteMany({ where: { order: { campusId: ids.campus } } });
  await prisma.serviceOrder.deleteMany({ where: { campusId: ids.campus } });
  await prisma.formationRound.deleteMany({ where: { campusId: ids.campus } });
  await prisma.groupMember.deleteMany({ where: { campusId: ids.campus } });
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.companionGroup.deleteMany({ where: { campusId: ids.campus } });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.idempotencyRecord.deleteMany({ where: { campusId: ids.campus } });
  await prisma.routeSchedule.deleteMany({ where: { campusId: ids.campus } });
  await prisma.route.deleteMany({ where: { campusId: ids.campus } });
  await prisma.place.deleteMany({ where: { campusId: ids.campus } });
  await prisma.studentVerification.deleteMany({ where: { campusId: ids.campus } });
  await prisma.userSession.deleteMany({ where: { campusId: ids.campus } });
  await prisma.user.deleteMany({ where: { campusId: ids.campus } });
  await prisma.policyVersion.deleteMany({
    where: { id: { in: [ids.sensitivePolicy, ids.contactPolicy] } },
  });
  await prisma.campus.deleteMany({ where: { id: ids.campus } });
}

async function cleanupGroupingData(): Promise<void> {
  await prisma.contactAccessLog.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactUnlock.deleteMany({ where: { campusId: ids.campus } });
  await prisma.contactConsent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.memberConfirmation.deleteMany({ where: { campusId: ids.campus } });
  await prisma.refund.deleteMany({ where: { campusId: ids.campus } });
  await prisma.paymentTransaction.deleteMany({ where: { order: { campusId: ids.campus } } });
  await prisma.serviceOrder.deleteMany({ where: { campusId: ids.campus } });
  await prisma.formationRound.deleteMany({ where: { campusId: ids.campus } });
  await prisma.groupMember.deleteMany({ where: { campusId: ids.campus } });
  await prisma.travelDemand.deleteMany({ where: { campusId: ids.campus } });
  await prisma.companionGroup.deleteMany({ where: { campusId: ids.campus } });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
}
