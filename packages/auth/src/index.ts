import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

const ACCESS_TOKEN_HEADER = Object.freeze({ alg: "HS256", typ: "JWT" });
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface UserAccessPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly campusId: string;
}

interface UserAccessPayload {
  readonly iss: "campus-companion-api";
  readonly aud: "campus-companion-miniprogram";
  readonly sub: string;
  readonly sid: string;
  readonly campusId: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface TotpVerification {
  readonly counter: number;
}

export interface StudentNumberIdentity {
  readonly normalized: string;
  readonly digest: string;
  readonly last4: string;
}

export interface EncryptedValue {
  readonly ciphertext: Buffer;
  readonly keyVersion: string;
}

interface MockWechatCodePayload {
  readonly subject: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string | Uint8Array, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function randomOpaqueToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 128) {
    throw new RangeError("token entropy must be between 32 and 128 bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

export function issueMockWechatCode(
  subject: string,
  signingSecret: string,
  expiresAt: Date,
): string {
  assertSecret(signingSecret, "mock WeChat signing secret");
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(subject)) throw new TypeError("invalid mock WeChat subject");
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
  if (!Number.isSafeInteger(expiresAtSeconds)) throw new TypeError("invalid mock WeChat expiry");
  const payload: MockWechatCodePayload = {
    subject,
    nonce: randomBytes(8).toString("base64url"),
    expiresAt: expiresAtSeconds,
  };
  const encoded = `${payload.subject}~${payload.expiresAt.toString(36)}~${payload.nonce}`;
  const signature = createHmac("sha256", signingSecret)
    .update(encoded, "ascii")
    .digest("base64url");
  const code = `${encoded}.${signature}`;
  if (code.length > 128) throw new RangeError("mock WeChat code exceeds contract length");
  return code;
}

export function verifyMockWechatCode(
  code: string,
  signingSecret: string,
  now: Date,
): string | null {
  assertSecret(signingSecret, "mock WeChat signing secret");
  if (code.length < 1 || code.length > 128) return null;
  const parts = code.split(".");
  if (parts.length !== 2) return null;
  const [encoded, encodedSignature] = parts;
  if (encoded === undefined || encodedSignature === undefined) return null;
  const expected = createHmac("sha256", signingSecret).update(encoded, "ascii").digest();
  const supplied = Buffer.from(encodedSignature, "base64url");
  if (
    supplied.toString("base64url") !== encodedSignature ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }
  try {
    const [subject, expiresAtBase36, nonce, extra] = encoded.split("~");
    if (
      subject === undefined ||
      expiresAtBase36 === undefined ||
      nonce === undefined ||
      extra !== undefined
    ) {
      return null;
    }
    const payload: unknown = {
      subject,
      nonce,
      expiresAt: Number.parseInt(expiresAtBase36, 36),
    };
    if (!isMockWechatCodePayload(payload)) return null;
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (!Number.isSafeInteger(nowSeconds) || payload.expiresAt <= nowSeconds) return null;
    return payload.subject;
  } catch {
    return null;
  }
}

export function issueRefreshToken(sessionId: string): string {
  assertUuid(sessionId, "sessionId");
  return `${sessionId}.${randomOpaqueToken(32)}`;
}

export function parseRefreshToken(token: string): { sessionId: string; digest: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [sessionId, secret] = parts;
  if (sessionId === undefined || secret === undefined) return null;
  if (!isUuid(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, digest: sha256Hex(token) };
}

export function signUserAccessToken(
  principal: UserAccessPrincipal,
  signingSecret: string,
  now: Date,
  lifetimeSeconds = 900,
): string {
  assertSecret(signingSecret, "access token signing secret");
  assertUuid(principal.userId, "userId");
  assertUuid(principal.sessionId, "sessionId");
  assertUuid(principal.campusId, "campusId");
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 3_600) {
    throw new RangeError("access token lifetime must be between 60 and 3600 seconds");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt)) throw new TypeError("invalid token clock");
  const payload: UserAccessPayload = {
    iss: "campus-companion-api",
    aud: "campus-companion-miniprogram",
    sub: principal.userId,
    sid: principal.sessionId,
    campusId: principal.campusId,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    jti: randomOpaqueToken(32),
  };
  const encodedHeader = Buffer.from(JSON.stringify(ACCESS_TOKEN_HEADER)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", signingSecret).update(input, "ascii").digest("base64url");
  return `${input}.${signature}`;
}

export function verifyUserAccessToken(
  token: string,
  signingSecret: string,
  now: Date,
): UserAccessPrincipal | null {
  assertSecret(signingSecret, "access token signing secret");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined || signature === undefined) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const input = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", signingSecret).update(input, "ascii").digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (supplied.toString("base64url") !== signature) return null;
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as unknown;
    if (!isExactTokenHeader(header) || !isUserAccessPayload(payload)) return null;
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (!Number.isSafeInteger(nowSeconds)) return null;
    if (
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat > 3_600
    ) {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.sid, campusId: payload.campusId };
  } catch {
    return null;
  }
}

export function normalizeAndDigestStudentNumber(
  studentNumber: string,
  hmacSecret: string,
): StudentNumberIdentity {
  assertSecret(hmacSecret, "student number HMAC secret");
  const normalized = studentNumber.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,64}$/.test(normalized)) {
    throw new TypeError("student number must contain 4 to 64 ASCII letters or digits");
  }
  return {
    normalized,
    digest: hmacSha256Hex(hmacSecret, normalized),
    last4: normalized.slice(-4),
  };
}

export async function hashAdminPassword(password: string): Promise<string> {
  assertPasswordInput(password);
  return argon2id({
    password,
    salt: randomBytes(16),
    iterations: 3,
    parallelism: 1,
    memorySize: 65_536,
    hashLength: 32,
    outputType: "encoded",
  });
}

export async function verifyAdminPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== "string" || password.length < 1 || password.length > 256) return false;
  if (!encodedHash.startsWith("$argon2id$v=19$") || encodedHash.length > 255) return false;
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

export function generateTotpCode(
  base32Secret: string,
  timestampMs: number,
  periodSeconds = 30,
): string {
  const counter = totpCounter(timestampMs, periodSeconds);
  return hotp(base32Decode(base32Secret), counter);
}

export function generateTotpSecret(bytes = 20): string {
  if (!Number.isSafeInteger(bytes) || bytes < 20 || bytes > 64) {
    throw new RangeError("TOTP secret entropy must be between 20 and 64 bytes");
  }
  return base32Encode(randomBytes(bytes));
}

export function verifyTotpCode(
  base32Secret: string,
  code: string,
  timestampMs: number,
  allowedSkewWindows = 1,
  periodSeconds = 30,
): TotpVerification | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (
    !Number.isSafeInteger(allowedSkewWindows) ||
    allowedSkewWindows < 0 ||
    allowedSkewWindows > 2
  ) {
    throw new RangeError("TOTP skew must be between 0 and 2 windows");
  }
  const secret = base32Decode(base32Secret);
  const current = totpCounter(timestampMs, periodSeconds);
  for (let offset = -allowedSkewWindows; offset <= allowedSkewWindows; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = hotp(secret, counter);
    if (constantTimeTextEqual(code, expected)) return { counter };
  }
  return null;
}

export class AesGcmProtector {
  public constructor(
    private readonly key: Buffer,
    public readonly keyVersion: string,
  ) {
    if (key.length !== 32) throw new RangeError("AES-256-GCM key must contain 32 bytes");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyVersion)) throw new TypeError("invalid key version");
  }

  public encrypt(value: string): EncryptedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([nonce, tag, ciphertext]), keyVersion: this.keyVersion };
  }

  public decrypt(ciphertext: Uint8Array): string {
    const bytes = Buffer.from(ciphertext);
    if (bytes.length < 29) throw new TypeError("invalid encrypted value");
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const payload = bytes.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  }
}

function assertPasswordInput(password: string): void {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new TypeError("administrator password must contain 12 to 256 characters");
  }
}

function assertSecret(secret: string, label: string): void {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError(`${label} must contain at least 32 bytes`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new TypeError(`${label} must be a UUID`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isExactTokenHeader(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record["alg"] === "HS256" && record["typ"] === "JWT";
}

function isUserAccessPayload(value: unknown): value is UserAccessPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  return (
    keys.length === 8 &&
    payload["iss"] === "campus-companion-api" &&
    payload["aud"] === "campus-companion-miniprogram" &&
    typeof payload["sub"] === "string" &&
    isUuid(payload["sub"]) &&
    typeof payload["sid"] === "string" &&
    isUuid(payload["sid"]) &&
    typeof payload["campusId"] === "string" &&
    isUuid(payload["campusId"]) &&
    typeof payload["iat"] === "number" &&
    Number.isSafeInteger(payload["iat"]) &&
    typeof payload["exp"] === "number" &&
    Number.isSafeInteger(payload["exp"]) &&
    typeof payload["jti"] === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(payload["jti"])
  );
}

function isMockWechatCodePayload(value: unknown): value is MockWechatCodePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 3 &&
    typeof payload["subject"] === "string" &&
    /^[A-Za-z0-9_-]{3,32}$/.test(payload["subject"]) &&
    typeof payload["nonce"] === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(payload["nonce"]) &&
    typeof payload["expiresAt"] === "number" &&
    Number.isSafeInteger(payload["expiresAt"])
  );
}

function base32Decode(input: string): Buffer {
  const normalized = input.replace(/=+$/u, "").toUpperCase();
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new TypeError("invalid base32 TOTP secret");
  }
  let bits = 0;
  let accumulator = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

function base32Encode(input: Uint8Array): string {
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function totpCounter(timestampMs: number, periodSeconds: number): number {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new TypeError("invalid TOTP clock");
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 15 || periodSeconds > 120) {
    throw new RangeError("TOTP period must be between 15 and 120 seconds");
  }
  return Math.floor(timestampMs / (periodSeconds * 1_000));
}

function hotp(secret: Buffer, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
