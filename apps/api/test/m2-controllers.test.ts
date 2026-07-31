import { randomUUID } from "node:crypto";
import type { VerificationObjectStore } from "@campus/verification";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdminAuthController, adminSecurityContext } from "../src/admin/admin-auth.controller";
import type { AdminAuthService } from "../src/admin/admin-auth.service";
import {
  AdminVerificationAssetController,
  AdminVerificationController,
} from "../src/admin/admin-verification.controller";
import type { AdminVerificationService } from "../src/admin/admin-verification.service";
import {
  AuthController,
  extractBearer,
  MeController,
  parseBody,
} from "../src/auth/auth.controller";
import type { AuthService } from "../src/auth/auth.service";
import type { AppConfig } from "../src/config";
import {
  MockVerificationUploadController,
  VerificationController,
} from "../src/verification/verification.controller";
import type { VerificationService } from "../src/verification/verification.service";

const campusId = randomUUID();
const verificationId = randomUUID();
const accessToken = "access.token.value";
const principal = { userId: randomUUID(), sessionId: randomUUID(), campusId };

function reply() {
  const value = {
    header: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
  };
  value.header.mockReturnValue(value);
  value.type.mockReturnValue(value);
  value.send.mockReturnValue(value);
  return value;
}

describe("M2 controllers", () => {
  it("adapts user auth, profile and validation requests", async () => {
    const session = {
      accessToken,
      refreshToken: "refresh-token-value-that-is-long-enough",
      expiresInSeconds: 900,
      user: { id: principal.userId },
    };
    const auth = {
      loginWithWechatCode: vi.fn().mockResolvedValue(session),
      refresh: vi.fn().mockResolvedValue(session),
      logout: vi.fn().mockResolvedValue(undefined),
      authenticate: vi.fn().mockResolvedValue(principal),
      getUserProfile: vi.fn().mockResolvedValue(session.user),
    } as unknown as AuthService;
    const controller = new AuthController(auth);
    await expect(controller.login({ code: "wechat-code" })).resolves.toEqual(session);
    await expect(
      controller.refresh({ refreshToken: "refresh-token-value-that-is-long-enough" }),
    ).resolves.toEqual(session);
    await expect(controller.logout(`Bearer ${accessToken}`)).resolves.toBeUndefined();
    await expect(new MeController(auth).getMe(`Bearer ${accessToken}`)).resolves.toEqual(
      session.user,
    );
    expect(extractBearer(`Bearer ${accessToken}`)).toBe(accessToken);
    expect(() => extractBearer("Basic bad")).toThrow();
    expect(parseBody(z.object({ value: z.string() }), { value: "ok" })).toEqual({ value: "ok" });
    expect(() => parseBody(z.object({ value: z.string() }), { value: 1 })).toThrow();
  });

  it("adapts student verification creation, status, submit and resubmission", async () => {
    const response = {
      id: verificationId,
      campusId,
      studentNumberLast4: "9001",
      status: "PENDING",
      submittedAt: null,
      latestSubmittedAt: null,
      reviewedAt: null,
      expiresAt: null,
      reasonCode: null,
      evidenceTypes: ["STUDENT_CARD"],
    };
    const upload = {
      verification: response,
      uploads: [
        {
          type: "STUDENT_CARD",
          uploadUrl: "http://127.0.0.1/upload",
          uploadExpiresAt: new Date().toISOString(),
        },
      ],
    };
    const auth = { authenticate: vi.fn().mockResolvedValue(principal) } as unknown as AuthService;
    const verifications = {
      create: vi.fn().mockResolvedValue(upload),
      current: vi.fn().mockResolvedValue(response),
      submit: vi.fn().mockResolvedValue(response),
      createResubmissionUpload: vi.fn().mockResolvedValue(upload),
    } as unknown as VerificationService;
    const controller = new VerificationController(auth, verifications);
    await expect(
      controller.create(`Bearer ${accessToken}`, "verification-create-key", {
        campusId,
        studentNumber: "M2STUDENT9001",
        genderDeclaration: "UNDISCLOSED",
        sensitiveInfoConsentVersion: "v1",
        evidenceTypes: ["STUDENT_CARD"],
      }),
    ).resolves.toEqual(upload);
    await expect(controller.current(`Bearer ${accessToken}`)).resolves.toEqual(response);
    await expect(
      controller.submit(`Bearer ${accessToken}`, "verification-submit-key", verificationId, {
        uploads: [{ type: "STUDENT_CARD", uploadEtag: "a".repeat(64) }],
      }),
    ).resolves.toEqual(response);
    await expect(
      controller.createResubmissionUpload(
        `Bearer ${accessToken}`,
        "verification-resubmit-key",
        verificationId,
        { evidenceTypes: ["WECOM_SCREENSHOT"] },
      ),
    ).resolves.toEqual(upload);
  });

  it("keeps mock binary upload restricted to test and development", async () => {
    const metadata = { contentDigest: "a".repeat(64), contentType: "image/png", sizeBytes: 8 };
    const store = {
      putByUploadToken: vi.fn().mockResolvedValue(metadata),
    } as unknown as VerificationObjectStore;
    const response = reply();
    const config = { nodeEnv: "test", wechatAuthProvider: "mock" } as AppConfig;
    await expect(
      new MockVerificationUploadController(config, store).upload(
        "upload-token",
        "image/png",
        Buffer.alloc(8),
        response as never,
      ),
    ).resolves.toBeUndefined();
    expect(response.header).toHaveBeenCalledWith("etag", metadata.contentDigest);
    await expect(
      new MockVerificationUploadController({ ...config, nodeEnv: "production" }, store).upload(
        "upload-token",
        "image/png",
        Buffer.alloc(8),
        response as never,
      ),
    ).rejects.toThrow("disabled");
  });

  it("sets and clears strict administrator cookies and forwards CSRF context", async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({
        sessionToken: `${randomUUID()}.${Buffer.alloc(32).toString("base64url")}`,
        csrfToken: "csrf",
        csrfExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        sessionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
      rotateCsrf: vi.fn().mockResolvedValue({ csrfToken: "next", csrfExpiresAt: "later" }),
      logout: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdminAuthService;
    const controller = new AdminAuthController(auth);
    const response = reply();
    const request = { id: "req-admin" };
    await expect(
      controller.login(
        { username: "reviewer", password: "administrator password", totpCode: "123456" },
        request as never,
        response as never,
      ),
    ).resolves.toMatchObject({ csrfToken: "csrf" });
    expect(response.header).toHaveBeenCalledWith(
      "set-cookie",
      expect.stringContaining("Secure; HttpOnly; SameSite=Strict"),
    );
    await expect(
      controller.rotateCsrf("__Host-admin_session=session", "http://127.0.0.1:5173", "same-origin"),
    ).resolves.toMatchObject({ csrfToken: "next" });
    await expect(
      controller.logout(
        "__Host-admin_session=session",
        "csrf",
        "http://127.0.0.1:5173",
        "same-origin",
        response as never,
      ),
    ).resolves.toBeUndefined();
    expect(adminSecurityContext({})).toEqual({ sessionToken: "", origin: "" });
  });

  it("adapts administrator review, grant and controlled proxy endpoints", async () => {
    const item = { id: verificationId, campusId, status: "PENDING" };
    const verifications = {
      list: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
      get: vi.fn().mockResolvedValue(item),
      review: vi.fn().mockResolvedValue(item),
      issueAssetAccess: vi.fn().mockResolvedValue({
        consumePath: "/v1/admin/verification-assets/consume",
        grantToken: "grant",
        expiresAt: "later",
        singleUse: true,
      }),
      consumeAssetAccess: vi.fn().mockResolvedValue({
        content: Buffer.from("material"),
        contentType: "image/png",
      }),
    } as unknown as AdminVerificationService;
    const controller = new AdminVerificationController(verifications);
    const headers = [
      "__Host-admin_session=session",
      "csrf",
      "http://127.0.0.1:5173",
      "same-origin",
    ] as const;
    await expect(controller.list(...headers, campusId)).resolves.toMatchObject({ items: [item] });
    await expect(controller.get(...headers, verificationId)).resolves.toEqual(item);
    expect(() => controller.get(...headers, "not-a-uuid")).toThrow();
    await expect(
      controller.review(
        ...headers,
        "admin-review-key-0001",
        verificationId,
        { decision: "APPROVE" },
        { id: "req-review" } as never,
      ),
    ).resolves.toEqual(item);
    await expect(
      controller.issueAssetAccess(
        ...headers,
        "admin-grant-key-0001",
        verificationId,
        { assetType: "STUDENT_CARD", reauthTotpCode: "123456" },
        { id: "req-grant" } as never,
      ),
    ).resolves.toMatchObject({ singleUse: true });

    const response = reply();
    await expect(
      new AdminVerificationAssetController(verifications).consume(
        ...headers,
        "grant",
        { id: "req-consume" } as never,
        response as never,
      ),
    ).resolves.toBeUndefined();
    expect(response.header).toHaveBeenCalledWith("cache-control", "private, no-store");
    expect(response.type).toHaveBeenCalledWith("image/png");
    expect(response.send).toHaveBeenCalledWith(Buffer.from("material"));
  });
});
