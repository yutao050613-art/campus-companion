import { Module } from "@nestjs/common";
import { APP_CONFIG, loadConfig } from "./config";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(process.env),
    },
  ],
})
export class AppModule {}
