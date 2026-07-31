import { Module } from "@nestjs/common";
import { AdminAuthController } from "./admin/admin-auth.controller";
import { AdminAuthService } from "./admin/admin-auth.service";
import {
  AdminVerificationAssetController,
  AdminVerificationController,
} from "./admin/admin-verification.controller";
import { AdminVerificationService } from "./admin/admin-verification.service";
import { AuthController, MeController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { AdminCatalogController, CatalogController } from "./catalog/catalog.controller";
import { AdminCatalogService, CatalogService } from "./catalog/catalog.service";
import { APP_CONFIG, loadConfig } from "./config";
import { PrismaService } from "./database/prisma.service";
import {
  DemandController,
  FormationController,
  GroupController,
} from "./grouping/grouping.controller";
import { GroupingService } from "./grouping/grouping.service";
import { HealthController } from "./health.controller";
import { IdempotencyService } from "./m2/idempotency.service";
import { dataProtectorProvider, verificationObjectStoreProvider } from "./m2/providers";
import {
  MockVerificationUploadController,
  VerificationController,
} from "./verification/verification.controller";
import { VerificationService } from "./verification/verification.service";

@Module({
  controllers: [
    HealthController,
    AuthController,
    MeController,
    VerificationController,
    MockVerificationUploadController,
    AdminAuthController,
    AdminVerificationController,
    AdminVerificationAssetController,
    CatalogController,
    AdminCatalogController,
    DemandController,
    GroupController,
    FormationController,
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(process.env),
    },
    PrismaService,
    AuthService,
    IdempotencyService,
    VerificationService,
    AdminAuthService,
    AdminVerificationService,
    CatalogService,
    AdminCatalogService,
    GroupingService,
    dataProtectorProvider,
    verificationObjectStoreProvider,
  ],
})
export class AppModule {}
