import pino, { type DestinationStream, type Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-verification-asset-grant",
  "req.headers.x-csrf-token",
  "res.headers.set-cookie",
  "accessToken",
  "refreshToken",
  "code",
  "wechatId",
  "studentNumber",
  "uploadUrl",
  "grantToken",
  "objectKey",
  "apiV3Key",
  "privateKey",
  "totpSecret",
  "password",
  "totpCode",
  "reauthTotpCode",
  "csrfToken",
  "sessionToken",
  "*.accessToken",
  "*.refreshToken",
  "*.code",
  "*.wechatId",
  "*.studentNumber",
  "*.uploadUrl",
  "*.grantToken",
  "*.objectKey",
  "*.password",
  "*.totpCode",
  "*.reauthTotpCode",
  "*.csrfToken",
  "*.sessionToken",
] as const;

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { service: options.service },
      redact: {
        paths: [...REDACT_PATHS],
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}

export { REDACT_PATHS };
export type StructuredLogger = Logger;
