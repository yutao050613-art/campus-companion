import "reflect-metadata";
import { createLogger } from "@campus/observability";
import { createApp } from "./bootstrap";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ service: "campus-api-bootstrap", level: config.logLevel });
  const app = await createApp({ level: config.logLevel });
  await app.listen(config.port, "0.0.0.0");
  logger.info({ port: config.port, environment: config.nodeEnv }, "API listening");
}

void main().catch((error: unknown) => {
  const logger = createLogger({ service: "campus-api-bootstrap" });
  logger.fatal({ err: error }, "API failed to start");
  process.exitCode = 1;
});
