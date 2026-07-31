import { randomBytes } from "node:crypto";
import { AesGcmProtector } from "@campus/auth";
import { LocalVerificationObjectStore } from "@campus/verification";
import type { FactoryProvider } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";

export const DATA_PROTECTOR = Symbol("DATA_PROTECTOR");
export const VERIFICATION_OBJECT_STORE = Symbol("VERIFICATION_OBJECT_STORE");

export const dataProtectorProvider: FactoryProvider<AesGcmProtector> = {
  provide: DATA_PROTECTOR,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => {
    const configured = Buffer.from(config.dataEncryptionKeyBase64, "base64");
    const key = configured.length === 32 ? configured : randomBytes(32);
    return new AesGcmProtector(key, config.dataEncryptionKeyVersion);
  },
};

export const verificationObjectStoreProvider: FactoryProvider<LocalVerificationObjectStore> = {
  provide: VERIFICATION_OBJECT_STORE,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) =>
    new LocalVerificationObjectStore({
      rootDirectory: config.localObjectStoreRoot,
      uploadHmacSecret:
        Buffer.byteLength(config.localObjectUploadSecret, "utf8") >= 32
          ? config.localObjectUploadSecret
          : randomBytes(48).toString("base64url"),
      publicBaseUrl: config.publicApiBaseUrl,
    }),
};
