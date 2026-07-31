import type { VerificationObjectStore } from "@campus/verification";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { extractBearer, parseBody } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import { APP_CONFIG, type AppConfig } from "../config";
import { VERIFICATION_OBJECT_STORE } from "../m2/providers";
import {
  type VerificationResponse,
  VerificationService,
  type VerificationUploadResponse,
} from "./verification.service";

const CreateSchema = z
  .object({
    campusId: z.string().uuid(),
    studentNumber: z.string().min(4).max(64),
    genderDeclaration: z.enum(["MALE", "FEMALE", "UNDISCLOSED"]),
    sensitiveInfoConsentVersion: z.string().min(1).max(50),
    evidenceTypes: z
      .array(z.enum(["STUDENT_CARD", "WECOM_SCREENSHOT"]))
      .min(1)
      .max(2)
      .refine((types) => new Set(types).size === types.length),
  })
  .strict();
const SubmitSchema = z
  .object({
    uploads: z
      .array(
        z
          .object({
            type: z.enum(["STUDENT_CARD", "WECOM_SCREENSHOT"]),
            uploadEtag: z.string().regex(/^[a-fA-F0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .refine((uploads) => new Set(uploads.map((upload) => upload.type)).size === uploads.length),
  })
  .strict();
const ResubmissionSchema = z
  .object({
    evidenceTypes: z
      .array(z.enum(["STUDENT_CARD", "WECOM_SCREENSHOT"]))
      .min(1)
      .max(2)
      .refine((types) => new Set(types).size === types.length),
  })
  .strict();
const UuidSchema = z.string().uuid();

@Controller("verifications")
export class VerificationController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(VerificationService) private readonly verifications: VerificationService,
  ) {}

  @Post()
  public async create(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VerificationUploadResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.verifications.create(
      principal,
      parseBody(CreateSchema, body),
      idempotencyKey ?? "",
    );
  }

  @Get()
  public async current(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<VerificationResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.verifications.current(principal);
  }

  @Post(":verificationId/submit")
  @HttpCode(202)
  public async submit(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("verificationId") verificationId: string,
    @Body() body: unknown,
  ): Promise<VerificationResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    const input = parseBody(SubmitSchema, body);
    return this.verifications.submit(
      principal,
      parseBody(UuidSchema, verificationId),
      input.uploads,
      idempotencyKey ?? "",
    );
  }

  @Post(":verificationId/resubmission-upload")
  public async createResubmissionUpload(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("verificationId") verificationId: string,
    @Body() body: unknown,
  ): Promise<VerificationUploadResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    const input = parseBody(ResubmissionSchema, body);
    return this.verifications.createResubmissionUpload(
      principal,
      parseBody(UuidSchema, verificationId),
      input.evidenceTypes,
      idempotencyKey ?? "",
    );
  }
}

@Controller("mock/verification-uploads")
export class MockVerificationUploadController {
  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VERIFICATION_OBJECT_STORE) private readonly objectStore: VerificationObjectStore,
  ) {}

  @Put(":token")
  @HttpCode(204)
  public async upload(
    @Param("token") token: string,
    @Headers("content-type") contentType: string | undefined,
    @Body() body: Buffer,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (
      this.config.wechatAuthProvider !== "mock" ||
      (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test")
    ) {
      throw new Error("mock upload endpoint is disabled");
    }
    const metadata = await this.objectStore.putByUploadToken(
      token,
      body,
      contentType ?? "",
      new Date(),
    );
    void reply.header("etag", metadata.contentDigest);
  }
}
