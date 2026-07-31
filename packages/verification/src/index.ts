import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const OBJECT_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const UPLOAD_TOKEN_CONTEXT = Buffer.from("campus-companion:verification-upload:v1", "utf8");

export interface VerificationUploadGrant {
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly uploadExpiresAt: Date;
}

export interface VerificationObjectMetadata {
  readonly contentType: "image/jpeg" | "image/png";
  readonly sizeBytes: number;
  readonly contentDigest: string;
}

export interface VerificationObjectStore {
  issueUpload(input: {
    readonly campusId: string;
    readonly verificationId: string;
    readonly expiresAt: Date;
  }): VerificationUploadGrant;
  putByUploadToken(
    token: string,
    content: Uint8Array,
    contentType: string,
    now: Date,
  ): Promise<VerificationObjectMetadata>;
  head(objectKey: string): Promise<VerificationObjectMetadata | null>;
  read(objectKey: string): Promise<Buffer>;
  delete(objectKey: string): Promise<void>;
}

interface LocalStoreOptions {
  readonly rootDirectory: string;
  readonly uploadHmacSecret: string;
  readonly publicBaseUrl: string;
  readonly maxBytes?: number;
}

interface UploadTokenPayload {
  readonly objectKey: string;
  readonly expiresAtMs: number;
}

export class LocalVerificationObjectStore implements VerificationObjectStore {
  private readonly rootDirectory: string;
  private readonly maxBytes: number;
  private readonly publicBaseUrl: string;
  private readonly uploadTokenKey: Buffer;

  public constructor(options: LocalStoreOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    if (Buffer.byteLength(options.uploadHmacSecret, "utf8") < 32) {
      throw new TypeError("upload HMAC secret must contain at least 32 bytes");
    }
    this.uploadTokenKey = createHash("sha256").update(options.uploadHmacSecret, "utf8").digest();
    const base = new URL(options.publicBaseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new TypeError("public base URL must use HTTP or HTTPS");
    }
    this.publicBaseUrl = base.toString().replace(/\/$/u, "");
    this.maxBytes = options.maxBytes ?? 5_242_880;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 10_485_760) {
      throw new RangeError("verification object limit must be between 1 and 10485760 bytes");
    }
  }

  public issueUpload(input: {
    readonly campusId: string;
    readonly verificationId: string;
    readonly expiresAt: Date;
  }): VerificationUploadGrant {
    assertUuid(input.campusId, "campusId");
    assertUuid(input.verificationId, "verificationId");
    const expiresAtMs = input.expiresAt.getTime();
    if (!Number.isSafeInteger(expiresAtMs)) throw new TypeError("invalid upload expiry");
    const objectKey = `${input.campusId}/${input.verificationId}/${randomUUID()}`;
    const token = this.signUploadToken({ objectKey, expiresAtMs });
    return {
      objectKey,
      uploadUrl: `${this.publicBaseUrl}/v1/mock/verification-uploads/${encodeURIComponent(token)}`,
      uploadExpiresAt: new Date(expiresAtMs),
    };
  }

  public async putByUploadToken(
    token: string,
    content: Uint8Array,
    contentType: string,
    now: Date,
  ): Promise<VerificationObjectMetadata> {
    const payload = this.verifyUploadToken(token);
    if (payload.expiresAtMs <= now.getTime()) throw new Error("UPLOAD_TOKEN_EXPIRED");
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("UNSUPPORTED_CONTENT_TYPE");
    if (content.byteLength < 1 || content.byteLength > this.maxBytes) {
      throw new Error("INVALID_OBJECT_SIZE");
    }
    if (!hasExpectedImageSignature(content, contentType)) {
      throw new Error("INVALID_IMAGE_SIGNATURE");
    }

    const objectPath = this.safeObjectPath(payload.objectKey);
    const metadataPath = `${objectPath}.metadata.json`;
    await mkdir(dirname(objectPath), { recursive: true });
    const metadata: VerificationObjectMetadata = {
      contentType: contentType as VerificationObjectMetadata["contentType"],
      sizeBytes: content.byteLength,
      contentDigest: createHash("sha256").update(content).digest("hex"),
    };
    await writeFile(objectPath, content, { flag: "wx", mode: 0o600 });
    try {
      await writeFile(metadataPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(objectPath, { force: true });
      throw error;
    }
    return metadata;
  }

  public async head(objectKey: string): Promise<VerificationObjectMetadata | null> {
    const objectPath = this.safeObjectPath(objectKey);
    try {
      const [content, metadataBytes] = await Promise.all([
        readFile(objectPath),
        readFile(`${objectPath}.metadata.json`),
      ]);
      const metadata = parseMetadata(metadataBytes.toString("utf8"));
      const digest = createHash("sha256").update(content).digest("hex");
      if (metadata.sizeBytes !== content.byteLength || metadata.contentDigest !== digest) {
        throw new Error("OBJECT_INTEGRITY_MISMATCH");
      }
      return metadata;
    } catch (error) {
      if (isFileMissing(error)) return null;
      throw error;
    }
  }

  public async read(objectKey: string): Promise<Buffer> {
    return readFile(this.safeObjectPath(objectKey));
  }

  public async delete(objectKey: string): Promise<void> {
    const objectPath = this.safeObjectPath(objectKey);
    await Promise.all([
      rm(objectPath, { force: true }),
      rm(`${objectPath}.metadata.json`, { force: true }),
    ]);
  }

  private signUploadToken(payload: UploadTokenPayload): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.uploadTokenKey, nonce);
    cipher.setAAD(UPLOAD_TOKEN_CONTEXT);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  }

  private verifyUploadToken(token: string): UploadTokenPayload {
    try {
      const encoded = Buffer.from(token, "base64url");
      if (encoded.toString("base64url") !== token || encoded.length < 29) {
        throw new Error("INVALID_UPLOAD_TOKEN");
      }
      const nonce = encoded.subarray(0, 12);
      const ciphertext = encoded.subarray(12, -16);
      const authTag = encoded.subarray(-16);
      const decipher = createDecipheriv("aes-256-gcm", this.uploadTokenKey, nonce);
      decipher.setAAD(UPLOAD_TOKEN_CONTEXT);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const value = JSON.parse(plaintext.toString("utf8")) as unknown;
      if (!isUploadTokenPayload(value)) throw new Error("INVALID_UPLOAD_TOKEN");
      return value;
    } catch {
      throw new Error("INVALID_UPLOAD_TOKEN");
    }
  }

  private safeObjectPath(objectKey: string): string {
    if (!OBJECT_KEY_PATTERN.test(objectKey)) throw new Error("INVALID_OBJECT_KEY");
    const candidate = resolve(this.rootDirectory, ...objectKey.split("/"));
    if (!candidate.startsWith(`${this.rootDirectory}${sep}`)) throw new Error("INVALID_OBJECT_KEY");
    return candidate;
  }
}

function parseMetadata(value: string): VerificationObjectMetadata {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("INVALID_OBJECT_METADATA");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    (record["contentType"] !== "image/jpeg" && record["contentType"] !== "image/png") ||
    typeof record["sizeBytes"] !== "number" ||
    !Number.isSafeInteger(record["sizeBytes"]) ||
    record["sizeBytes"] < 1 ||
    typeof record["contentDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(record["contentDigest"])
  ) {
    throw new Error("INVALID_OBJECT_METADATA");
  }
  return {
    contentType: record["contentType"],
    sizeBytes: record["sizeBytes"],
    contentDigest: record["contentDigest"],
  };
}

function isUploadTokenPayload(value: unknown): value is UploadTokenPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record["objectKey"] === "string" &&
    OBJECT_KEY_PATTERN.test(record["objectKey"]) &&
    typeof record["expiresAtMs"] === "number" &&
    Number.isSafeInteger(record["expiresAtMs"])
  );
}

function assertUuid(value: string, label: string): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(value)) throw new TypeError(`${label} must be a UUID`);
}

function isFileMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function hasExpectedImageSignature(content: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => content[index] === byte);
  }
  return (
    contentType === "image/jpeg" &&
    content.length >= 4 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff &&
    content[content.length - 2] === 0xff &&
    content[content.length - 1] === 0xd9
  );
}
