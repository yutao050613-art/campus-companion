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

  it("enables callback verification only with a complete, bounded key set", () => {
    const base = {
      WECHAT_PAY_CALLBACKS_ENABLED: "true",
      WECHAT_PAY_MERCHANT_ID: "1900007291",
      WECHAT_PAY_APP_ID: "wx2421b1c4370ec43b",
      WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL: "m5-merchant-serial",
      WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM: "m5-private-key",
      WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
      WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON: JSON.stringify({ "m5-platform-key": "m5-public-key" }),
    };
    expect(loadConfig(base).wechatPayCallbacks).toMatchObject({
      merchantId: base.WECHAT_PAY_MERCHANT_ID,
      appId: base.WECHAT_PAY_APP_ID,
      verifierPublicKeys: new Map([["m5-platform-key", "m5-public-key"]]),
    });
    for (const required of [
      "WECHAT_PAY_MERCHANT_ID",
      "WECHAT_PAY_APP_ID",
      "WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL",
      "WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM",
      "WECHAT_PAY_API_V3_KEY",
      "WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON",
    ] as const) {
      const invalid = { ...base, [required]: "" };
      expect(() => loadConfig(invalid)).toThrow(new RegExp(required, "u"));
    }
  });

  it("rejects callback key material that is not a small object of PEM strings", () => {
    const base = {
      WECHAT_PAY_CALLBACKS_ENABLED: "true",
      WECHAT_PAY_MERCHANT_ID: "1900007291",
      WECHAT_PAY_APP_ID: "wx2421b1c4370ec43b",
      WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL: "m5-merchant-serial",
      WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM: "m5-private-key",
      WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
    };
    for (const verifierKeys of [
      "not-json",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ a: "one", b: "two", c: "three", d: "four", e: "five" }),
      JSON.stringify({ "m5-platform-key": 1 }),
    ]) {
      expect(() =>
        loadConfig({ ...base, WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON: verifierKeys }),
      ).toThrow(/WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON/u);
    }
  });

  it("canonicalizes trusted origins and honours explicit local object storage", () => {
    expect(
      loadConfig({
        ADMIN_TRUSTED_ORIGINS: "https://admin.example.invalid/path, https://other.example.invalid",
        LOCAL_OBJECT_STORE_ROOT: "D:\\M5\\object-store",
      }),
    ).toMatchObject({
      localObjectStoreRoot: "D:\\M5\\object-store",
      adminTrustedOrigins: new Set([
        "https://admin.example.invalid",
        "https://other.example.invalid",
      ]),
    });
    expect(() => loadConfig({ ADMIN_TRUSTED_ORIGINS: "not-an-origin" })).toThrow();
  });
});
