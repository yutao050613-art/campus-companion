import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { ApplicationError } from "../common/application-error";
import type { UserProfileResponse, UserSessionResponse } from "./auth.service";
import { AuthService } from "./auth.service";

const WechatLoginSchema = z.object({ code: z.string().min(1).max(128) }).strict();
const RefreshSchema = z.object({ refreshToken: z.string().min(32).max(2_048) }).strict();

@Controller("auth")
export class AuthController {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("wechat/login")
  @HttpCode(200)
  public login(@Body() body: unknown): Promise<UserSessionResponse> {
    const input = parseBody(WechatLoginSchema, body);
    return this.auth.loginWithWechatCode(input.code);
  }

  @Post("refresh")
  @HttpCode(200)
  public refresh(@Body() body: unknown): Promise<UserSessionResponse> {
    const input = parseBody(RefreshSchema, body);
    return this.auth.refresh(input.refreshToken);
  }

  @Post("logout")
  @HttpCode(204)
  public async logout(@Headers("authorization") authorization?: string): Promise<void> {
    await this.auth.logout(extractBearer(authorization));
  }
}

@Controller("me")
export class MeController {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get()
  public async getMe(
    @Headers("authorization") authorization?: string,
  ): Promise<UserProfileResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.auth.getUserProfile(principal.userId);
  }
}

export function extractBearer(authorization?: string): string {
  const match = (authorization ?? "").match(/^Bearer ([A-Za-z0-9._-]+)$/u);
  if (match?.[1] === undefined) {
    throw new ApplicationError("AUTH_REQUIRED", "authentication is required", 401);
  }
  return match[1];
}

export function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApplicationError("VALIDATION_ERROR", "request body is invalid", 400, {
      violations: result.error.issues.slice(0, 20).map((issue) => ({
        field: issue.path.join(".") || "body",
        constraint: issue.code,
      })),
    });
  }
  return result.data;
}
