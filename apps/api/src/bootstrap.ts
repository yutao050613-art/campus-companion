import { randomUUID } from "node:crypto";
import { createLogger, type LoggerOptions } from "@campus/observability";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { ApiExceptionFilter } from "./common/api-exception.filter";

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
    bodyLimit: 1_048_576,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: false,
    logger: false,
  });

  adapter.getInstance().addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", String(request.id));
    done();
  });
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();
  return app;
}
