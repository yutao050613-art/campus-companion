import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("API configuration", () => {
  it("applies safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: "development",
      port: 3000,
      version: "0.1.0",
      logLevel: "info",
      wechatAuthProvider: "mock",
      publicApiBaseUrl: "http://127.0.0.1:3000",
    });
  });

  it("rejects an invalid port instead of silently coercing it", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow();
  });

  it("forbids mock identity and missing secrets in production-like environments", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/mock WeChat/u);
    expect(() => loadConfig({ NODE_ENV: "staging", WECHAT_AUTH_PROVIDER: "wechat" })).toThrow(
      /mock payment/u,
    );
  });

  it("rejects malformed encryption keys and insecure production origins", () => {
    expect(() => loadConfig({ DATA_ENCRYPTION_KEY_BASE64: "a".repeat(32) })).toThrow(
      /canonical base64/u,
    );
    const production = {
      NODE_ENV: "production",
      WECHAT_AUTH_PROVIDER: "wechat",
      AUTH_ACCESS_TOKEN_SECRET: "a".repeat(32),
      STUDENT_NUMBER_HMAC_SECRET: "b".repeat(32),
      DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      DATA_ENCRYPTION_KEY_VERSION: "kms-v1",
      LOCAL_OBJECT_UPLOAD_SECRET: "c".repeat(32),
      PUBLIC_API_BASE_URL: "https://api.example.invalid",
      ADMIN_TRUSTED_ORIGINS: "http://admin.example.invalid",
    };
    expect(() => loadConfig(production)).toThrow(/mock payment/u);
    expect(() =>
      loadConfig({
        ...production,
        PAYMENT_PROVIDER: "wechat",
        ADMIN_TRUSTED_ORIGINS: "https://admin.example.invalid",
      }),
    ).toThrow(/WeChat Pay/u);
  });
});
