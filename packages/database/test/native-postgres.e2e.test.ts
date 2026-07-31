import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/client";
import {
  databaseObjectInventorySql,
  expectedDatabaseObjectInventory,
} from "./database-object-inventory";

const { NATIVE_POSTGRES_TESTS: nativePostgresTests } = process.env;
const runNativePostgres = nativePostgresTests === "true";
const database = new PrismaClient();

const ids = {
  campus: "10000000-0000-0000-0000-000000000001",
  userA: "10000000-0000-0000-0000-000000000101",
  userB: "10000000-0000-0000-0000-000000000102",
  origin: "10000000-0000-0000-0000-000000000301",
  destination: "10000000-0000-0000-0000-000000000302",
  route: "10000000-0000-0000-0000-000000000401",
  demandA: "10000000-0000-0000-0000-000000000501",
  demandB: "10000000-0000-0000-0000-000000000502",
  group: "10000000-0000-0000-0000-000000000601",
  memberA: "10000000-0000-0000-0000-000000000701",
  memberB: "10000000-0000-0000-0000-000000000702",
  verification: "10000000-0000-0000-0000-000000000801",
  verificationAsset: "10000000-0000-0000-0000-000000000802",
  admin: "10000000-0000-0000-0000-000000000901",
  adminSession: "10000000-0000-0000-0000-000000000902",
} as const;

describe.runIf(runNativePostgres)("native PostgreSQL 16 guards", () => {
  afterAll(async () => {
    await database.$disconnect();
  });

  it("rolls back a failed transaction", async () => {
    const temporaryCampus = "10000000-0000-0000-0000-000000000099";

    await expect(
      database.$transaction(async (transaction) => {
        await transaction.campus.create({
          data: { id: temporaryCampus, name: "Rollback Campus" },
        });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    await expect(database.campus.count({ where: { id: temporaryCampus } })).resolves.toBe(0);
  });

  it("matches the shared final database object inventory", async () => {
    const verificationStatuses = await database.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      databaseObjectInventorySql.verificationStatuses,
    );
    expect(verificationStatuses.map((row) => row.enumlabel)).toEqual(
      expectedDatabaseObjectInventory.verificationStatuses,
    );

    const constraints = await database.$queryRawUnsafe<Array<{ conname: string }>>(
      databaseObjectInventorySql.constraints,
    );
    expect(constraints.map((row) => row.conname)).toEqual(
      expectedDatabaseObjectInventory.constraints,
    );

    const functions = await database.$queryRawUnsafe<Array<{ proname: string }>>(
      databaseObjectInventorySql.functions,
    );
    expect(functions.map((row) => row.proname)).toEqual(expectedDatabaseObjectInventory.functions);

    const triggers = await database.$queryRawUnsafe<Array<{ tgname: string }>>(
      databaseObjectInventorySql.triggers,
    );
    expect(triggers.map((row) => row.tgname)).toEqual(expectedDatabaseObjectInventory.triggers);
  });

  it("serializes concurrent joins and never creates a fifth seat", async () => {
    await database.$executeRawUnsafe(`
      INSERT INTO "Campus" ("id", "name", "updatedAt")
      VALUES ('${ids.campus}', 'Native Campus', NOW());
      INSERT INTO "User" ("id", "campusId", "wechatSubject", "displayName", "updatedAt") VALUES
        ('${ids.userA}', '${ids.campus}', 'native-wx-a', 'A', NOW()),
        ('${ids.userB}', '${ids.campus}', 'native-wx-b', 'B', NOW());
      INSERT INTO "Place" ("id", "campusId", "name", "type", "updatedAt") VALUES
        ('${ids.origin}', '${ids.campus}', 'Native Gate', 'CAMPUS_GATE', NOW()),
        ('${ids.destination}', '${ids.campus}', 'Native Station', 'TRANSIT_HUB', NOW());
      INSERT INTO "Route" (
        "id", "campusId", "originId", "destinationId", "updatedAt"
      ) VALUES (
        '${ids.route}', '${ids.campus}', '${ids.origin}', '${ids.destination}', NOW()
      );
      INSERT INTO "TravelDemand" (
        "id", "userId", "campusId", "routeId", "windowStart", "windowEnd",
        "seatCount", "luggageSize", "genderPreference", "updatedAt"
      ) VALUES
        ('${ids.demandA}', '${ids.userA}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '90 minutes', 2, 'NONE', 'ANY', NOW()),
        ('${ids.demandB}', '${ids.userB}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '90 minutes', 3, 'NONE', 'ANY', NOW());
      INSERT INTO "CompanionGroup" (
        "id", "campusId", "routeId", "windowStart", "windowEnd", "updatedAt"
      ) VALUES (
        '${ids.group}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour',
        NOW() + INTERVAL '90 minutes', NOW()
      );
    `);

    const insertMember = (
      memberId: string,
      userId: string,
      demandId: string,
      seatCount: number,
    ): Promise<number> =>
      database.$executeRawUnsafe(`
        INSERT INTO "GroupMember" (
          "id", "campusId", "groupId", "userId", "demandId", "seatCount", "updatedAt"
        ) VALUES (
          '${memberId}', '${ids.campus}', '${ids.group}', '${userId}', '${demandId}',
          ${seatCount}, NOW()
        );
      `);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const results = await Promise.allSettled([
        insertMember(ids.memberA, ids.userA, ids.demandA, 2),
        insertMember(ids.memberB, ids.userB, ids.demandB, 3),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
        `attempt ${attempt} successful writes`,
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
        `attempt ${attempt} rejected writes`,
      ).toHaveLength(1);

      const rows = await database.$queryRaw<Array<{ seats: number }>>`
        SELECT COALESCE(SUM("seatCount"), 0)::integer AS seats
          FROM "GroupMember"
         WHERE "groupId" = ${ids.group}::uuid
           AND "status" IN (
             'JOINED', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CONTACT_UNLOCKED'
           )
      `;
      expect(rows[0]?.seats, `attempt ${attempt} seat total`).toBeLessThanOrEqual(4);

      await database.groupMember.deleteMany({ where: { groupId: ids.group } });
    }
  });

  it("atomically allows only one of two concurrent verification asset grant consumptions", async () => {
    await database.$executeRawUnsafe(`
      INSERT INTO "Campus" ("id", "name", "updatedAt")
      VALUES ('${ids.campus}', 'Native Campus', NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "User" ("id", "campusId", "wechatSubject", "displayName", "updatedAt")
      VALUES ('${ids.userA}', '${ids.campus}', 'native-wx-a', 'A', NOW())
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "StudentVerification" (
        "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
        "status", "consentPolicyId", "updatedAt"
      )
      SELECT
        '${ids.verification}', '${ids.userA}', '${ids.campus}',
        'abababababababababababababababababababababababababababababababab',
        '9876', 'AWAITING_UPLOAD', "id", NOW()
        FROM "PolicyVersion"
       WHERE "type" = 'CONTACT_SHARING' AND "version" = 'contact-sharing-v1'
      ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "VerificationAsset" (
        "id", "campusId", "verificationId", "objectKey", "uploadExpiresAt", "deleteAfter"
      ) VALUES (
        '${ids.verificationAsset}', '${ids.campus}', '${ids.verification}',
        'native/private/verification', NOW() + INTERVAL '15 minutes', NOW() + INTERVAL '1 day'
      ) ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "AdminUser" (
        "id", "username", "passwordHash", "totpSecretCiphertext", "keyVersion", "updatedAt"
      ) VALUES (
        '${ids.admin}', 'native-reviewer', 'argon2id-native-test', decode('00', 'hex'),
        'kms-native-v1', NOW()
      ) ON CONFLICT ("id") DO NOTHING;
      INSERT INTO "AdminSession" (
        "id", "adminUserId", "sessionTokenHash", "csrfTokenHash", "expiresAt",
        "lastReauthenticatedAt"
      ) VALUES (
        '${ids.adminSession}', '${ids.admin}',
        'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
        'efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef',
        NOW() + INTERVAL '10 minutes', NOW()
      ) ON CONFLICT ("id") DO NOTHING;
    `);

    for (let grantAttempt = 1; grantAttempt <= 20; grantAttempt += 1) {
      const suffix = grantAttempt.toString().padStart(12, "0");
      const grantId = `20000000-0000-0000-0000-${suffix}`;
      const tokenDigest = grantAttempt.toString(16).padStart(64, "0");
      await database.$executeRawUnsafe(`
        INSERT INTO "VerificationAssetAccessGrant" (
          "id", "campusId", "verificationId", "adminUserId", "adminSessionId",
          "tokenDigest", "requestId", "expiresAt"
        ) VALUES (
          '${grantId}', '${ids.campus}', '${ids.verification}', '${ids.admin}',
          '${ids.adminSession}', '${tokenDigest}', 'native-grant-issue-${grantAttempt}',
          NOW() + INTERVAL '30 seconds'
        );
      `);

      const consume = (competitor: number): Promise<Array<{ grantId: string }>> =>
        database.$queryRawUnsafe(`
          SELECT * FROM "consume_verification_asset_access_grant"(
            '${tokenDigest}', '${ids.adminSession}', '${ids.campus}',
            '3${competitor}000000-0000-0000-0000-${suffix}',
            'native-grant-consume-${grantAttempt}-${competitor}'
          )
        `);

      const results = await Promise.all([consume(1), consume(2)]);
      expect(results.flat(), `grant attempt ${grantAttempt} successful consumptions`).toHaveLength(
        1,
      );
    }

    const auditCount = await database.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS count
        FROM "AuditLog"
       WHERE "action" = 'VERIFICATION_ASSET_GRANT_CONSUMED'
         AND "targetId" = ${ids.verification}::uuid
    `;
    expect(auditCount[0]?.count).toBe(20);
  });
});
