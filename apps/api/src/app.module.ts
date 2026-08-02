import { Module } from "@nestjs/common";
import { AdminAuthController } from "./admin/admin-auth.controller";
import { AdminAuthService } from "./admin/admin-auth.service";
import { AdminTrustController } from "./admin/admin-trust.controller";
import { AdminTrustService } from "./admin/admin-trust.service";
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
import { PaymentsController } from "./payments/payments.controller";
import { PaymentsService } from "./payments/payments.service";
import { RefundsController } from "./payments/refunds.controller";
import { WechatCallbackController } from "./payments/wechat-callback.controller";
import { WechatCallbackService } from "./payments/wechat-callback.service";
import { TrustController } from "./trust/trust.controller";
import { TrustService } from "./trust/trust.service";
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
    AdminTrustController,
    CatalogController,
    AdminCatalogController,
    DemandController,
    GroupController,
    FormationController,
    PaymentsController,
    RefundsController,
    WechatCallbackController,
    TrustController,
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
    AdminTrustService,
    CatalogService,
    AdminCatalogService,
    GroupingService,
    PaymentsService,
    WechatCallbackService,
    TrustService,
    dataProtectorProvider,
    verificationObjectStoreProvider,
  ],
})
export class AppModule {}
