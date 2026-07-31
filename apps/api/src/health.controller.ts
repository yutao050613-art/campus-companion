import type { HealthResponse } from "@campus/contracts";
import { Controller, Get, Inject } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./config";

@Controller("health")
export class HealthController {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  public getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "campus-api",
      version: this.config.version,
      timestamp: new Date().toISOString(),
    };
  }
}
