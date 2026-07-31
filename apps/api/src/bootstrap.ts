import { randomUUID } from "node:crypto";
import { createLogger, type LoggerOptions } from "@campus/observability";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { APP_CONFIG, type AppConfig } from "./config";

export async function createApp(
  loggerOptions?: Partial<LoggerOptions>,
): Promise<NestFastifyApplication> {
  const { LOG_LEVEL: environmentLogLevel } = process.env;
  const logger = createLogger({
    service: loggerOptions?.service ?? "campus-api",
    level: loggerOptions?.level ?? environmentLogLevel ?? "info",
    ...(loggerOptions?.destination === undefined ? {} : { destination: loggerOptions.destination }),
  });
  const adapter = new FastifyAdapter({
    logger: false,
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
    bodyLimit: 5_242_880,
    routerOptions: {
      maxParamLength: 512,
    },
  });
  adapter
    .getInstance()
    .addContentTypeParser(
      ["image/jpeg", "image/png"],
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    abortOnError: false,
    bufferLogs: false,
    logger: false,
  });

  adapter.getInstance().addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", String(request.id));
    done();
  });
  app.setGlobalPrefix("v1");
  const config = app.get<AppConfig>(APP_CONFIG);
  app.enableCors({
    origin: [...config.adminTrustedOrigins],
    credentials: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-csrf-token",
      "x-verification-asset-grant",
    ],
  });
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();
  return app;
}
