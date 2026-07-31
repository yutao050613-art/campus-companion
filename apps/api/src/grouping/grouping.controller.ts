import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { extractBearer, parseBody } from "../auth/auth.controller";
import { AuthService } from "../auth/auth.service";
import {
  type DemandResponse,
  type FormationResponse,
  GroupingService,
  type GroupResponse,
} from "./grouping.service";

const UuidSchema = z.string().uuid();
const DateTimeSchema = z.string().datetime({ offset: false });
const CreateDemandSchema = z
  .object({
    routeId: z.string().uuid(),
    windowStart: DateTimeSchema,
    windowEnd: DateTimeSchema,
    seatCount: z.number().int().min(1).max(3),
    luggage: z.enum(["NONE", "SMALL", "LARGE"]),
    genderPreference: z.enum(["ANY", "SAME_GENDER_ONLY"]),
  })
  .strict();
const JoinSchema = z.object({ demandId: z.string().uuid() }).strict();
const ConfirmSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("ACCEPT"),
      contactConsent: z
        .object({ granted: z.literal(true), policyVersion: z.string().min(1).max(50) })
        .strict(),
    })
    .strict(),
  z.object({ decision: z.literal("DECLINE") }).strict(),
]);

@Controller("demands")
export class DemandController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(GroupingService) private readonly grouping: GroupingService,
  ) {}

  @Post()
  public async create(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<DemandResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.createDemand(
      principal,
      parseBody(CreateDemandSchema, body),
      idempotencyKey ?? "",
    );
  }

  @Get()
  public async list(
    @Headers("authorization") authorization: string | undefined,
    @Query("cursor") cursor?: string,
  ): Promise<{ readonly items: readonly DemandResponse[]; readonly nextCursor: string | null }> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.listMyDemands(
      principal,
      cursor === undefined ? undefined : parseBody(UuidSchema, cursor),
    );
  }

  @Get(":demandId")
  public async get(
    @Headers("authorization") authorization: string | undefined,
    @Param("demandId") demandId: string,
  ): Promise<DemandResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.getDemand(principal, parseBody(UuidSchema, demandId));
  }

  @Delete(":demandId")
  @HttpCode(204)
  public async cancel(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("demandId") demandId: string,
  ): Promise<void> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    await this.grouping.cancelDemand(
      principal,
      parseBody(UuidSchema, demandId),
      idempotencyKey ?? "",
    );
  }
}

@Controller("groups")
export class GroupController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(GroupingService) private readonly grouping: GroupingService,
  ) {}

  @Get()
  public async list(
    @Headers("authorization") authorization: string | undefined,
    @Query("routeId") routeId: string,
    @Query("windowStart") windowStart: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ readonly items: readonly GroupResponse[]; readonly nextCursor: string | null }> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.listGroups(
      principal,
      parseBody(UuidSchema, routeId),
      parseBody(DateTimeSchema, windowStart),
      cursor === undefined ? undefined : parseBody(UuidSchema, cursor),
    );
  }

  @Get(":groupId")
  public async get(
    @Headers("authorization") authorization: string | undefined,
    @Param("groupId") groupId: string,
  ): Promise<GroupResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.getGroup(principal, parseBody(UuidSchema, groupId));
  }

  @Post(":groupId/join")
  @HttpCode(200)
  public async join(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<GroupResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    const input = parseBody(JoinSchema, body);
    return this.grouping.joinGroup(
      principal,
      parseBody(UuidSchema, groupId),
      input.demandId,
      idempotencyKey ?? "",
    );
  }

  @Post(":groupId/leave")
  @HttpCode(200)
  public async leave(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("groupId") groupId: string,
  ): Promise<GroupResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.leaveGroup(
      principal,
      parseBody(UuidSchema, groupId),
      idempotencyKey ?? "",
    );
  }

  @Post(":groupId/formation-rounds")
  public async startFormation(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("groupId") groupId: string,
  ): Promise<FormationResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.startFormation(
      principal,
      parseBody(UuidSchema, groupId),
      idempotencyKey ?? "",
    );
  }
}

@Controller("formation-rounds")
export class FormationController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(GroupingService) private readonly grouping: GroupingService,
  ) {}

  @Get(":roundId")
  public async get(
    @Headers("authorization") authorization: string | undefined,
    @Param("roundId") roundId: string,
  ): Promise<FormationResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.getFormation(principal, parseBody(UuidSchema, roundId));
  }

  @Post(":roundId/confirm")
  @HttpCode(200)
  public async confirm(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("roundId") roundId: string,
    @Body() body: unknown,
  ): Promise<FormationResponse> {
    const principal = await this.auth.authenticate(extractBearer(authorization));
    return this.grouping.confirmFormation(
      principal,
      parseBody(UuidSchema, roundId),
      parseBody(ConfirmSchema, body),
      idempotencyKey ?? "",
    );
  }
}
