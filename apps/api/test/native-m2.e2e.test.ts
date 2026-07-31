import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  AesGcmProtector,
  generateTotpCode,
  hashAdminPassword,
  issueMockWechatCode,
} from "@campus/auth";
import { createPrismaClient, PolicyType } from "@campus/database";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";

const runNative = process.env["NATIVE_POSTGRES_TESTS"] === "true";
const prisma = createPrismaClient();
const ids = {
  campus: "20000000-0000-4000-8000-000000000001",
  otherCampus: "20000000-0000-4000-8000-000000000002",
  policy: "20000000-0000-4000-8000-000000000010",
  admin: "20000000-0000-4000-8000-000000000020",
  role: "20000000-0000-4000-8000-000000000021",
} as const;
const mockSecret = "m2-mock-wechat-signing-secret-longer-than-thirty-two-bytes";
const accessSecret = "m2-access-token-signing-secret-longer-than-thirty-two-bytes";
const studentSecret = "m2-student-number-hmac-secret-longer-than-thirty-two-bytes";
const uploadSecret = "m2-upload-token-signing-secret-longer-than-thirty-two-bytes";
const encryptionKey = Buffer.alloc(32, 7);
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const origin = "http://127.0.0.1:5173";
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface UserSessionBody {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: { readonly id: string; readonly campusId: string };
}

interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawPayload: Buffer;
  json<T = unknown>(): T;
}

describe.runIf(runNative)("M2 native PostgreSQL API", () => {
  let app: NestFastifyApplication;
  let objectRoot = "";

  beforeAll(async () => {
    objectRoot = await mkdtemp(join(tmpdir(), "campus-m2-api-"));
    Object.assign(process.env, {
      NODE_ENV: "test",
      WECHAT_AUTH_PROVIDER: "mock",
      WECHAT_MOCK_DEFAULT_CAMPUS_ID: ids.campus,
      WECHAT_MOCK_SIGNING_SECRET: mockSecret,
      AUTH_ACCESS_TOKEN_SECRET: accessSecret,
      STUDENT_NUMBER_HMAC_SECRET: studentSecret,
      DATA_ENCRYPTION_KEY_BASE64: encryptionKey.toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "m2-native-test",
      LOCAL_OBJECT_UPLOAD_SECRET: uploadSecret,
      LOCAL_OBJECT_STORE_ROOT: objectRoot,
      PUBLIC_API_BASE_URL: "http://127.0.0.1:3000",
      ADMIN_TRUSTED_ORIGINS: origin,
    });
    await cleanup();
    const protector = new AesGcmProtector(encryptionKey, "m2-native-test");
    const encryptedTotp = protector.encrypt(totpSecret);
    await prisma.$transaction([
      prisma.campus.create({ data: { id: ids.campus, name: "M2 Native Campus" } }),
      prisma.campus.create({ data: { id: ids.otherCampus, name: "M2 Other Campus" } }),
      prisma.policyVersion.create({
        data: {
          id: ids.policy,
          type: PolicyType.SENSITIVE_INFO,
          version: "sensitive-info-m2-native",
          contentDigest: "a".repeat(64),
          effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
      prisma.role.create({
        data: {
          id: ids.role,
          code: "VERIFICATION_REVIEWER",
          description: "M2 native reviewer",
        },
      }),
    ]);
    await prisma.adminUser.create({
      data: {
        id: ids.admin,
        username: "m2-native-admin",
        passwordHash: await hashAdminPassword("m2 native administrator password"),
        totpSecretCiphertext: Uint8Array.from(encryptedTotp.ciphertext),
        keyVersion: encryptedTotp.keyVersion,
        roles: { create: { roleId: ids.role } },
        campusScopes: { create: { campusId: ids.campus } },
      },
    });
    app = await createApp({
      level: "silent",
      destination: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
      await cleanup();
    } finally {
      await prisma.$disconnect();
      if (objectRoot !== "") await rm(objectRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("consumes a mock WeChat code once and revokes a refresh family on a race", async () => {
    const code = issueMockCode("refresh_race");
    const login = await request("POST", "/v1/auth/wechat/login", { code });
    expect(login.statusCode).toBe(200);
    const session = login.json<UserSessionBody>();
    expect((await request("POST", "/v1/auth/wechat/login", { code })).statusCode).toBe(400);

    const refreshed = await Promise.all([
      request("POST", "/v1/auth/refresh", { refreshToken: session.refreshToken }),
      request("POST", "/v1/auth/refresh", { refreshToken: session.refreshToken }),
    ]);
    expect(refreshed.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(refreshed.filter((response) => response.statusCode === 401)).toHaveLength(1);
    const winning = refreshed.find((response) => response.statusCode === 200);
    if (winning === undefined) throw new Error("refresh race has no winner");
    const winningAccessToken = winning.json<UserSessionBody>().accessToken;
    expect((await request("GET", "/v1/me", undefined, bearer(winningAccessToken))).statusCode).toBe(
      401,
    );
  });

  it("runs login, private upload, submission, review and single-use material access", async () => {
    const user = await loginUser("verification_flow");
    const created = await request(
      "POST",
      "/v1/verifications",
      {
        campusId: ids.campus,
        studentNumber: "M2STUDENT9001",
        genderDeclaration: "UNDISCLOSED",
        sensitiveInfoConsentVersion: "sensitive-info-m2-native",
        evidenceTypes: ["STUDENT_CARD", "WECOM_SCREENSHOT"],
      },
      { ...bearer(user.accessToken), "idempotency-key": "m2-create-verification-0001" },
    );
    expect(created.statusCode).toBe(201);
    const upload = created.json<{
      verification: { id: string };
      uploads: readonly { type: "STUDENT_CARD" | "WECOM_SCREENSHOT"; uploadUrl: string }[];
    }>();
    expect(upload).not.toHaveProperty("objectKey");
    expect(upload.uploads).toHaveLength(2);
    expect(upload.uploads.every((credential) => !("objectKey" in credential))).toBe(true);
    const uploadedEvidence: { type: "STUDENT_CARD" | "WECOM_SCREENSHOT"; uploadEtag: string }[] =
      [];
    for (const credential of upload.uploads) {
      const uploaded = await request("PUT", new URL(credential.uploadUrl).pathname, pngBytes, {
        "content-type": "image/png",
      });
      expect(uploaded.statusCode).toBe(204);
      uploadedEvidence.push({
        type: credential.type,
        uploadEtag: String(uploaded.headers["etag"]),
      });
    }
    const submitted = await request(
      "POST",
      `/v1/verifications/${upload.verification.id}/submit`,
      { uploads: uploadedEvidence },
      { ...bearer(user.accessToken), "idempotency-key": "m2-submit-verification-0001" },
    );
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json()).toMatchObject({
      status: "PENDING",
      submittedAt: expect.any(String),
      evidenceTypes: ["STUDENT_CARD", "WECOM_SCREENSHOT"],
    });
    expect(
      (
        await request(
          "POST",
          `/v1/verifications/${upload.verification.id}/submit`,
          { uploads: uploadedEvidence },
          { ...bearer(user.accessToken), "idempotency-key": "m2-submit-verification-0001" },
        )
      ).statusCode,
    ).toBe(202);

    const admin = await loginAdmin();
    const adminHeaders = adminSecurity(admin.cookie, admin.csrfToken);
    expect(
      (
        await request(
          "GET",
          `/v1/admin/verifications?campusId=${ids.otherCampus}`,
          undefined,
          adminHeaders,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("GET", `/v1/admin/verifications?campusId=${ids.campus}`, undefined, {
          ...adminHeaders,
          origin: "https://attacker.invalid",
        })
      ).statusCode,
    ).toBe(403);

    const access = await request(
      "POST",
      `/v1/admin/verifications/${upload.verification.id}/asset-access`,
      { assetType: "STUDENT_CARD", reauthTotpCode: generateTotpCode(totpSecret, Date.now()) },
      { ...adminHeaders, "idempotency-key": "m2-asset-access-grant-0001" },
    );
    expect(access.statusCode).toBe(201);
    const grant = access.json<{ grantToken: string }>();
    const consumed = await request("POST", "/v1/admin/verification-assets/consume", undefined, {
      ...adminHeaders,
      "x-verification-asset-grant": grant.grantToken,
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.rawPayload).toEqual(pngBytes);
    expect(consumed.headers["cache-control"]).toBe("private, no-store");
    expect(
      (
        await request("POST", "/v1/admin/verification-assets/consume", undefined, {
          ...adminHeaders,
          "x-verification-asset-grant": grant.grantToken,
        })
      ).statusCode,
    ).toBe(404);

    const decision = await request(
      "POST",
      `/v1/admin/verifications/${upload.verification.id}/decision`,
      { decision: "APPROVE" },
      { ...adminHeaders, "idempotency-key": "m2-review-verification-0001" },
    );
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      status: "VERIFIED",
      availableAssetTypes: ["STUDENT_CARD", "WECOM_SCREENSHOT"],
    });
  });

  it("allows only one of two users to claim the same student identity for 20 rounds", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [left, right] = await Promise.all([
        loginUser(`identity_left_${attempt}`),
        loginUser(`identity_right_${attempt}`),
      ]);
      const studentNumber = `M2RACE${attempt.toString().padStart(4, "0")}`;
      const create = (session: UserSessionBody, suffix: string) =>
        request(
          "POST",
          "/v1/verifications",
          {
            campusId: ids.campus,
            studentNumber,
            genderDeclaration: "UNDISCLOSED",
            sensitiveInfoConsentVersion: "sensitive-info-m2-native",
            evidenceTypes: ["STUDENT_CARD"],
          },
          {
            ...bearer(session.accessToken),
            "idempotency-key": `m2-identity-race-${attempt.toString().padStart(2, "0")}-${suffix}`,
          },
        );
      const responses = await Promise.all([create(left, "left"), create(right, "right")]);
      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
    }
  }, 60_000);

  async function loginUser(subject: string): Promise<UserSessionBody> {
    const response = await request("POST", "/v1/auth/wechat/login", {
      code: issueMockCode(subject),
    });
    expect(response.statusCode).toBe(200);
    return response.json<UserSessionBody>();
  }

  async function loginAdmin(): Promise<{ cookie: string; csrfToken: string }> {
    const response = await request("POST", "/v1/admin/auth/login", {
      username: "m2-native-admin",
      password: "m2 native administrator password",
      totpCode: generateTotpCode(totpSecret, Date.now() - 30_000),
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    if (cookie === undefined) throw new Error("administrator login did not set a cookie");
    return { cookie, csrfToken: response.json<{ csrfToken: string }>().csrfToken };
  }

  function issueMockCode(subject: string): string {
    return issueMockWechatCode(subject, mockSecret, new Date(Date.now() + 60_000));
  }

  async function request(
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<InjectResponse> {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as never }),
      });
    return response as InjectResponse;
  }
});

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

function adminSecurity(cookie: string, csrfToken: string): Record<string, string> {
  return {
    cookie,
    "x-csrf-token": csrfToken,
    origin,
    "sec-fetch-site": "same-origin",
  };
}

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ campusId: ids.campus }, { actorAdminId: ids.admin }] },
  });
  await prisma.verificationAssetAccessGrant.deleteMany({ where: { campusId: ids.campus } });
  await prisma.idempotencyRecord.deleteMany({
    where: { OR: [{ campusId: ids.campus }, { adminUserId: ids.admin }] },
  });
  await prisma.outboxEvent.deleteMany({ where: { campusId: ids.campus } });
  await prisma.adminSession.deleteMany({ where: { adminUserId: ids.admin } });
  await prisma.adminUser.deleteMany({ where: { id: ids.admin } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await prisma.verificationAsset.deleteMany({ where: { campusId: ids.campus } });
  await prisma.studentVerification.deleteMany({ where: { campusId: ids.campus } });
  await prisma.userSession.deleteMany({ where: { campusId: ids.campus } });
  await prisma.user.deleteMany({ where: { campusId: ids.campus } });
  await prisma.policyVersion.deleteMany({ where: { id: ids.policy } });
  await prisma.campus.deleteMany({ where: { id: { in: [ids.campus, ids.otherCampus] } } });
}
