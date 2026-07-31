import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AesGcmProtector,
  generateTotpCode,
  generateTotpSecret,
  hashAdminPassword,
  hmacSha256Hex,
  issueMockWechatCode,
  issueRefreshToken,
  normalizeAndDigestStudentNumber,
  parseRefreshToken,
  randomOpaqueToken,
  sha256Hex,
  signUserAccessToken,
  verifyAdminPassword,
  verifyMockWechatCode,
  verifyTotpCode,
  verifyUserAccessToken,
} from "../src";

const signingSecret = "access-signing-secret-that-is-longer-than-thirty-two-bytes";

describe("M2 authentication primitives", () => {
  it("signs a scoped access token and rejects tampering and expiry", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const principal = { userId: randomUUID(), sessionId: randomUUID(), campusId: randomUUID() };
    const token = signUserAccessToken(principal, signingSecret, now, 60);
    const finalCharacter = token.at(-1);
    if (finalCharacter === undefined) throw new Error("test token is unexpectedly empty");
    const tamperedToken = `${token.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;

    expect(verifyUserAccessToken(token, signingSecret, now)).toEqual(principal);
    expect(verifyUserAccessToken(tamperedToken, signingSecret, now)).toBeNull();
    expect(
      verifyUserAccessToken(token, signingSecret, new Date(now.getTime() + 60_000)),
    ).toBeNull();
    expect(verifyUserAccessToken("not-a-token", signingSecret, now)).toBeNull();
    const [, encodedPayload] = token.split(".");
    if (encodedPayload === undefined) throw new Error("test token has no payload");
    const malformedInput = `not-json.${encodedPayload}`;
    const malformedSignature = createHmac("sha256", signingSecret)
      .update(malformedInput, "ascii")
      .digest("base64url");
    expect(
      verifyUserAccessToken(`${malformedInput}.${malformedSignature}`, signingSecret, now),
    ).toBeNull();
  });

  it("creates parseable refresh tokens while retaining only a digest", () => {
    const sessionId = randomUUID();
    const token = issueRefreshToken(sessionId);
    expect(parseRefreshToken(token)).toEqual({ sessionId, digest: sha256Hex(token) });
    expect(parseRefreshToken(`${sessionId}.short`)).toBeNull();
    expect(parseRefreshToken("broken")).toBeNull();
    expect(() => issueRefreshToken("not-a-uuid")).toThrow(/sessionId/u);
  });

  it("issues short-lived signed mock WeChat codes with a stable subject", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const secret = "mock-wechat-signing-secret-with-at-least-thirty-two-bytes";
    const code = issueMockWechatCode("student_001", secret, new Date(now.getTime() + 60_000));
    expect(code.length).toBeLessThanOrEqual(128);
    expect(verifyMockWechatCode(code, secret, now)).toBe("student_001");
    expect(verifyMockWechatCode(`${code}x`, secret, now)).toBeNull();
    expect(verifyMockWechatCode(code, secret, new Date(now.getTime() + 60_000))).toBeNull();
    expect(verifyMockWechatCode("broken", secret, now)).toBeNull();
    const [encoded] = code.split(".");
    if (encoded === undefined) throw new Error("test code has no payload");
    const extended = `${encoded}~extra`;
    const extendedSignature = createHmac("sha256", secret)
      .update(extended, "ascii")
      .digest("base64url");
    expect(verifyMockWechatCode(`${extended}.${extendedSignature}`, secret, now)).toBeNull();
    expect(() => issueMockWechatCode("bad subject!", secret, now)).toThrow(/subject/u);
  });

  it("normalizes and HMACs a student number without changing its final four", () => {
    const secret = "student-number-hmac-secret-with-at-least-thirty-two-bytes";
    expect(normalizeAndDigestStudentNumber("  Ab12cd34  ", secret)).toEqual({
      normalized: "AB12CD34",
      digest: hmacSha256Hex(secret, "AB12CD34"),
      last4: "CD34",
    });
    expect(() => normalizeAndDigestStudentNumber("12-34", secret)).toThrow(/student number/u);
    expect(() => normalizeAndDigestStudentNumber("1234", "short")).toThrow(/HMAC secret/u);
  });

  it("hashes and verifies administrator passwords with Argon2id PHC output", async () => {
    const hash = await hashAdminPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
    await expect(verifyAdminPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyAdminPassword("incorrect password", hash)).resolves.toBe(false);
    await expect(verifyAdminPassword("anything", "$scrypt$invalid")).resolves.toBe(false);
    await expect(verifyAdminPassword("anything", "$argon2id$v=19$invalid")).resolves.toBe(false);
    await expect(verifyAdminPassword("", hash)).resolves.toBe(false);
    await expect(hashAdminPassword("too-short")).rejects.toThrow(/12 to 256/u);
  });

  it("verifies TOTP inside the allowed window and exposes the consumed counter", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const timestamp = Date.parse("2026-07-31T12:00:00.000Z");
    const code = generateTotpCode(secret, timestamp);
    const result = verifyTotpCode(secret, code, timestamp);
    expect(result?.counter).toBe(Math.floor(timestamp / 30_000));
    expect(verifyTotpCode(secret, code, timestamp + 61_000)).toBeNull();
    expect(verifyTotpCode(secret, "12345x", timestamp)).toBeNull();
    expect(() => verifyTotpCode(secret, code, timestamp, 3)).toThrow(/skew/u);
    expect(() => generateTotpCode("INVALID!", timestamp)).toThrow(/base32/u);
    expect(() => generateTotpCode(secret, -1)).toThrow(/clock/u);
    expect(() => generateTotpCode(secret, timestamp, 10)).toThrow(/period/u);
  });

  it("generates a high-entropy base32 TOTP secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(generateTotpCode(secret, Date.now())).toMatch(/^\d{6}$/u);
    expect(() => generateTotpSecret(19)).toThrow(/entropy/u);
  });

  it("encrypts sensitive values with authenticated AES-256-GCM", () => {
    const protector = new AesGcmProtector(randomBytes(32), "m2-test-key");
    const encrypted = protector.encrypt("sensitive-value");
    expect(encrypted.keyVersion).toBe("m2-test-key");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("sensitive-value");
    expect(protector.decrypt(encrypted.ciphertext)).toBe("sensitive-value");

    const tampered = Buffer.from(encrypted.ciphertext);
    const lastByte = tampered.at(-1);
    if (lastByte === undefined) throw new Error("test ciphertext is unexpectedly empty");
    tampered[tampered.length - 1] = lastByte ^ 1;
    expect(() => protector.decrypt(tampered)).toThrow();
    expect(() => protector.decrypt(Buffer.alloc(12))).toThrow(/encrypted value/u);
  });

  it("rejects weak configuration and invalid entropy requests", () => {
    expect(() => randomOpaqueToken(31)).toThrow(/entropy/u);
    expect(() =>
      signUserAccessToken(
        { userId: randomUUID(), sessionId: randomUUID(), campusId: randomUUID() },
        "short",
        new Date(),
      ),
    ).toThrow(/signing secret/u);
    expect(() => new AesGcmProtector(Buffer.alloc(16), "v1")).toThrow(/32 bytes/u);
    expect(() => new AesGcmProtector(Buffer.alloc(32), "bad version!")).toThrow(/key version/u);
    expect(() =>
      signUserAccessToken(
        { userId: "invalid", sessionId: randomUUID(), campusId: randomUUID() },
        signingSecret,
        new Date(),
      ),
    ).toThrow(/userId/u);
    expect(() =>
      signUserAccessToken(
        { userId: randomUUID(), sessionId: randomUUID(), campusId: randomUUID() },
        signingSecret,
        new Date(),
        59,
      ),
    ).toThrow(/lifetime/u);
  });
});
