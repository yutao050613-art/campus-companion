import { platform } from "node:os";
import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  APP_VERSION: z.string().min(1).max(100).default("0.1.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1).optional(),
  WECHAT_AUTH_PROVIDER: z.enum(["mock", "wechat"]).default("mock"),
  PAYMENT_PROVIDER: z.enum(["mock", "wechat"]).default("mock"),
  WECHAT_PAY_CALLBACKS_ENABLED: z.enum(["true", "false"]).default("false"),
  WECHAT_PAY_MERCHANT_ID: z.string().default(""),
  WECHAT_PAY_APP_ID: z.string().default(""),
  WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL: z.string().default(""),
  WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM: z.string().default(""),
  WECHAT_PAY_API_V3_KEY: z.string().default(""),
  WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON: z.string().default(""),
  WECHAT_MOCK_DEFAULT_CAMPUS_ID: z.string().uuid().optional(),
  WECHAT_MOCK_SIGNING_SECRET: z.string().default(""),
  AUTH_ACCESS_TOKEN_SECRET: z.string().default(""),
  STUDENT_NUMBER_HMAC_SECRET: z.string().default(""),
  DATA_ENCRYPTION_KEY_BASE64: z.string().default(""),
  DATA_ENCRYPTION_KEY_VERSION: z.string().min(1).max(64).default("local-ephemeral"),
  LOCAL_OBJECT_UPLOAD_SECRET: z.string().default(""),
  LOCAL_OBJECT_STORE_ROOT: z.string().min(1).optional(),
  PUBLIC_API_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  ADMIN_TRUSTED_ORIGINS: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "staging" | "production";
  readonly port: number;
  readonly version: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly databaseUrl?: string;
  readonly wechatAuthProvider: "mock" | "wechat";
  readonly paymentProvider: "mock" | "wechat";
  readonly wechatPayCallbacks?: WechatPayCallbackConfig;
  readonly wechatMockDefaultCampusId?: string;
  readonly wechatMockSigningSecret: string;
  readonly accessTokenSecret: string;
  readonly studentNumberHmacSecret: string;
  readonly dataEncryptionKeyBase64: string;
  readonly dataEncryptionKeyVersion: string;
  readonly localObjectUploadSecret: string;
  readonly localObjectStoreRoot: string;
  readonly publicApiBaseUrl: string;
  readonly adminTrustedOrigins: ReadonlySet<string>;
}

export interface WechatPayCallbackConfig {
  readonly merchantId: string;
  readonly appId: string;
  readonly merchantCertificateSerial: string;
  readonly merchantPrivateKeyPem: string;
  readonly apiV3Key: string;
  readonly verifierPublicKeys: ReadonlyMap<string, string>;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const productionLike = parsed.NODE_ENV === "staging" || parsed.NODE_ENV === "production";
  if (productionLike && parsed.WECHAT_AUTH_PROVIDER === "mock") {
    throw new Error("mock WeChat authentication is forbidden outside development and test");
  }
  if (productionLike && parsed.PAYMENT_PROVIDER === "mock") {
    throw new Error("mock payment is forbidden outside development and test");
  }
  if (parsed.PAYMENT_PROVIDER !== "mock") {
    throw new Error("WeChat Pay is not configured until M5");
  }
  const wechatPayCallbacks = loadWechatPayCallbackConfig(parsed);
  if (productionLike) {
    for (const [name, value] of [
      ["AUTH_ACCESS_TOKEN_SECRET", parsed.AUTH_ACCESS_TOKEN_SECRET],
      ["STUDENT_NUMBER_HMAC_SECRET", parsed.STUDENT_NUMBER_HMAC_SECRET],
      ["DATA_ENCRYPTION_KEY_BASE64", parsed.DATA_ENCRYPTION_KEY_BASE64],
      ["LOCAL_OBJECT_UPLOAD_SECRET", parsed.LOCAL_OBJECT_UPLOAD_SECRET],
    ] as const) {
      if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${name} is required`);
    }
    if (parsed.DATA_ENCRYPTION_KEY_VERSION === "local-ephemeral") {
      throw new Error("DATA_ENCRYPTION_KEY_VERSION must identify a managed key");
    }
    if (new URL(parsed.PUBLIC_API_BASE_URL).protocol !== "https:") {
      throw new Error("PUBLIC_API_BASE_URL must use HTTPS");
    }
  }
  if (parsed.DATA_ENCRYPTION_KEY_BASE64 !== "") {
    const decoded = Buffer.from(parsed.DATA_ENCRYPTION_KEY_BASE64, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== parsed.DATA_ENCRYPTION_KEY_BASE64) {
      throw new Error("DATA_ENCRYPTION_KEY_BASE64 must be canonical base64 for exactly 32 bytes");
    }
  }
  const trustedOrigins = new Set(
    parsed.ADMIN_TRUSTED_ORIGINS.split(",").map((value) => new URL(value.trim()).origin),
  );
  if (productionLike && [...trustedOrigins].some((value) => new URL(value).protocol !== "https:")) {
    throw new Error("ADMIN_TRUSTED_ORIGINS must use HTTPS");
  }
  const localObjectStoreRoot =
    parsed.LOCAL_OBJECT_STORE_ROOT ??
    (platform() === "win32"
      ? "D:\\CodexWorkspace\\work\\campus-companion-object-store"
      : "/tmp/campus-companion-object-store");
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    version: parsed.APP_VERSION,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.DATABASE_URL === undefined ? {} : { databaseUrl: parsed.DATABASE_URL }),
    wechatAuthProvider: parsed.WECHAT_AUTH_PROVIDER,
    paymentProvider: parsed.PAYMENT_PROVIDER,
    ...(wechatPayCallbacks === undefined ? {} : { wechatPayCallbacks }),
    ...(parsed.WECHAT_MOCK_DEFAULT_CAMPUS_ID === undefined
      ? {}
      : { wechatMockDefaultCampusId: parsed.WECHAT_MOCK_DEFAULT_CAMPUS_ID }),
    wechatMockSigningSecret: parsed.WECHAT_MOCK_SIGNING_SECRET,
    accessTokenSecret: parsed.AUTH_ACCESS_TOKEN_SECRET,
    studentNumberHmacSecret: parsed.STUDENT_NUMBER_HMAC_SECRET,
    dataEncryptionKeyBase64: parsed.DATA_ENCRYPTION_KEY_BASE64,
    dataEncryptionKeyVersion: parsed.DATA_ENCRYPTION_KEY_VERSION,
    localObjectUploadSecret: parsed.LOCAL_OBJECT_UPLOAD_SECRET,
    localObjectStoreRoot,
    publicApiBaseUrl: parsed.PUBLIC_API_BASE_URL,
    adminTrustedOrigins: trustedOrigins,
  };
}

function loadWechatPayCallbackConfig(
  parsed: z.infer<typeof EnvironmentSchema>,
): WechatPayCallbackConfig | undefined {
  if (parsed.WECHAT_PAY_CALLBACKS_ENABLED !== "true") return undefined;
  const required = [
    ["WECHAT_PAY_MERCHANT_ID", parsed.WECHAT_PAY_MERCHANT_ID],
    ["WECHAT_PAY_APP_ID", parsed.WECHAT_PAY_APP_ID],
    ["WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL", parsed.WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL],
    ["WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM", parsed.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM],
    ["WECHAT_PAY_API_V3_KEY", parsed.WECHAT_PAY_API_V3_KEY],
    ["WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON", parsed.WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON],
  ] as const;
  for (const [name, value] of required) {
    if (value.trim() === "") throw new Error(`${name} is required when callbacks are enabled`);
  }
  let rawKeys: unknown;
  try {
    rawKeys = JSON.parse(parsed.WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON);
  } catch {
    throw new Error("WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON must be a JSON object");
  }
  if (typeof rawKeys !== "object" || rawKeys === null || Array.isArray(rawKeys)) {
    throw new Error("WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON must be a JSON object");
  }
  const entries = Object.entries(rawKeys);
  if (
    entries.length < 1 ||
    entries.length > 4 ||
    entries.some(([, value]) => typeof value !== "string")
  ) {
    throw new Error("WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON must contain one to four PEM values");
  }
  const publicKeys = new Map(entries as [string, string][]);
  return {
    merchantId: parsed.WECHAT_PAY_MERCHANT_ID,
    appId: parsed.WECHAT_PAY_APP_ID,
    merchantCertificateSerial: parsed.WECHAT_PAY_MERCHANT_CERTIFICATE_SERIAL,
    merchantPrivateKeyPem: parsed.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM,
    apiV3Key: parsed.WECHAT_PAY_API_V3_KEY,
    verifierPublicKeys: publicKeys,
  };
}
