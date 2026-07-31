import { Body, Controller, Headers, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseBody } from "../auth/auth.controller";
import { AdminAuthService, type AdminSessionResponse } from "./admin-auth.service";

const LoginSchema = z
  .object({
    username: z.string().min(3).max(100),
    password: z.string().min(12).max(256),
    totpCode: z.string().regex(/^\d{6}$/u),
  })
  .strict();

@Controller("admin/auth")
export class AdminAuthController {
  public constructor(@Inject(AdminAuthService) private readonly adminAuth: AdminAuthService) {}

  @Post("login")
  @HttpCode(200)
  public async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<AdminSessionResponse, "sessionToken">> {
    const input = parseBody(LoginSchema, body);
    const result = await this.adminAuth.login(
      input.username,
      input.password,
      input.totpCode,
      String(request.id),
    );
    void reply.header("set-cookie", adminCookie(result.sessionToken, result.sessionExpiresAt));
    return {
      csrfToken: result.csrfToken,
      csrfExpiresAt: result.csrfExpiresAt,
      sessionExpiresAt: result.sessionExpiresAt,
    };
  }

  @Post("csrf")
  @HttpCode(200)
  public rotateCsrf(
    @Headers("cookie") cookie: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
  ): Promise<{ csrfToken: string; csrfExpiresAt: string }> {
    return this.adminAuth.rotateCsrf({
      sessionToken: readAdminCookie(cookie),
      origin: origin ?? "",
      ...(fetchSite === undefined ? {} : { fetchSite }),
    });
  }

  @Post("logout")
  @HttpCode(204)
  public async logout(
    @Headers("cookie") cookie: string | undefined,
    @Headers("x-csrf-token") csrfToken: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("sec-fetch-site") fetchSite: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.adminAuth.logout({
      sessionToken: readAdminCookie(cookie),
      ...(csrfToken === undefined ? {} : { csrfToken }),
      origin: origin ?? "",
      ...(fetchSite === undefined ? {} : { fetchSite }),
    });
    void reply.header("set-cookie", expireAdminCookie());
  }
}

export function adminSecurityContext(headers: {
  readonly cookie?: string | undefined;
  readonly csrfToken?: string | undefined;
  readonly origin?: string | undefined;
  readonly fetchSite?: string | undefined;
}): {
  readonly sessionToken: string;
  readonly csrfToken?: string;
  readonly origin: string;
  readonly fetchSite?: string;
} {
  return {
    sessionToken: readAdminCookie(headers.cookie),
    ...(headers.csrfToken === undefined ? {} : { csrfToken: headers.csrfToken }),
    origin: headers.origin ?? "",
    ...(headers.fetchSite === undefined ? {} : { fetchSite: headers.fetchSite }),
  };
}

function readAdminCookie(cookieHeader?: string): string {
  const values = (cookieHeader ?? "").split(";").map((part) => part.trim());
  const match = values.find((value) => value.startsWith("__Host-admin_session="));
  return match?.slice("__Host-admin_session=".length) ?? "";
}

function adminCookie(token: string, expiresAt: string): string {
  return `__Host-admin_session=${token}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; Secure; HttpOnly; SameSite=Strict`;
}

function expireAdminCookie(): string {
  return "__Host-admin_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";
}
