import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  databaseObjectInventorySql,
  expectedDatabaseObjectInventory,
} from "./database-object-inventory";

const migrationsRoot = join(__dirname, "../prisma/migrations");
const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((directory) => readFileSync(join(migrationsRoot, directory, "migration.sql"), "utf8"));

const ids = {
  campus: "00000000-0000-0000-0000-000000000001",
  otherCampus: "00000000-0000-0000-0000-000000000002",
  userA: "00000000-0000-0000-0000-000000000101",
  userB: "00000000-0000-0000-0000-000000000102",
  otherCampusUser: "00000000-0000-0000-0000-000000000201",
  origin: "00000000-0000-0000-0000-000000000301",
  destination: "00000000-0000-0000-0000-000000000302",
  route: "00000000-0000-0000-0000-000000000401",
  demandA: "00000000-0000-0000-0000-000000000501",
  demandB: "00000000-0000-0000-0000-000000000502",
  group: "00000000-0000-0000-0000-000000000601",
  memberA: "00000000-0000-0000-0000-000000000701",
  memberB: "00000000-0000-0000-0000-000000000702",
  round: "00000000-0000-0000-0000-000000000801",
  order: "00000000-0000-0000-0000-000000000901",
  contactPolicy: "00000000-0000-0000-0000-00000000c001",
  accessLogA: "00000000-0000-0000-0000-000000000a01",
  accessLogB: "00000000-0000-0000-0000-000000000a02",
  verification: "00000000-0000-0000-0000-00000000d002",
  verificationAsset: "00000000-0000-0000-0000-00000000d003",
  admin: "00000000-0000-0000-0000-00000000e001",
  adminSession: "00000000-0000-0000-0000-00000000e002",
  assetGrant: "00000000-0000-0000-0000-00000000e003",
  grantAudit: "00000000-0000-0000-0000-00000000e004",
} as const;

describe("PostgreSQL final-state migration candidate", () => {
  const database = new PGlite();

  beforeAll(async () => {
    for (const migration of migrations) {
      await database.exec(migration);
    }
  }, 30_000);

  afterAll(async () => {
    await database.close();
  });

  it("applies to an empty PostgreSQL engine and enforces core guards", async () => {
    expect(migrations).toHaveLength(1);
    await database.exec(`
      INSERT INTO "Campus" ("id", "name", "updatedAt") VALUES
        ('${ids.campus}', 'Campus A', NOW()),
        ('${ids.otherCampus}', 'Campus B', NOW());
      INSERT INTO "User" (
        "id", "campusId", "wechatSubject", "displayName", "updatedAt"
      ) VALUES
        ('${ids.userA}', '${ids.campus}', 'wx-a', 'A', NOW()),
        ('${ids.userB}', '${ids.campus}', 'wx-b', 'B', NOW()),
        ('${ids.otherCampusUser}', '${ids.otherCampus}', 'wx-c', 'C', NOW());
      INSERT INTO "Place" ("id", "campusId", "name", "type", "updatedAt") VALUES
        ('${ids.origin}', '${ids.campus}', 'Gate', 'CAMPUS_GATE', NOW()),
        ('${ids.destination}', '${ids.campus}', 'Station', 'TRANSIT_HUB', NOW());
      INSERT INTO "Route" (
        "id", "campusId", "originId", "destinationId", "updatedAt"
      ) VALUES
        ('${ids.route}', '${ids.campus}', '${ids.origin}', '${ids.destination}', NOW());
      INSERT INTO "TravelDemand" (
        "id", "userId", "campusId", "routeId", "windowStart", "windowEnd",
        "seatCount", "luggageSize", "genderPreference", "updatedAt"
      ) VALUES
        ('${ids.demandA}', '${ids.userA}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '90 minutes', 3, 'NONE', 'ANY', NOW()),
        ('${ids.demandB}', '${ids.userB}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '90 minutes', 2, 'NONE', 'ANY', NOW());
      INSERT INTO "CompanionGroup" (
        "id", "campusId", "routeId", "windowStart", "windowEnd", "updatedAt"
      ) VALUES (
        '${ids.group}', '${ids.campus}', '${ids.route}', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '90 minutes', NOW()
      );
      INSERT INTO "GroupMember" (
        "id", "campusId", "groupId", "userId", "demandId", "seatCount", "updatedAt"
      ) VALUES (
        '${ids.memberA}', '${ids.campus}', '${ids.group}', '${ids.userA}', '${ids.demandA}', 3, NOW()
      );
    `);

    await expect(
      database.exec(`
        INSERT INTO "GroupMember" (
          "id", "campusId", "groupId", "userId", "demandId", "seatCount", "updatedAt"
        ) VALUES (
          '${ids.memberB}', '${ids.campus}', '${ids.group}', '${ids.userB}', '${ids.demandB}', 2, NOW()
        );
      `),
    ).rejects.toThrow(/four|seat|23514/i);

    await expect(
      database.exec(`
        INSERT INTO "GroupMember" (
          "id", "campusId", "groupId", "userId", "demandId", "seatCount", "updatedAt"
        ) VALUES (
          '${ids.memberB}', '${ids.campus}', '${ids.group}', '${ids.otherCampusUser}', '${ids.demandB}', 1, NOW()
        );
      `),
    ).rejects.toThrow(/foreign key|campus/i);

    await database.exec(`
      INSERT INTO "FormationRound" (
        "id", "campusId", "groupId", "sequence", "memberSnapshotHash",
        "contactPolicyVersionId", "confirmBy", "updatedAt"
      ) VALUES (
        '${ids.round}', '${ids.campus}', '${ids.group}', 1,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '${ids.contactPolicy}', NOW() + INTERVAL '5 minutes', NOW()
      );
    `);

    await expect(
      database.exec(`
        INSERT INTO "ServiceOrder" (
          "id", "campusId", "roundId", "userId", "merchantOrderNo", "amountFen",
          "currency", "pricingVersion", "expiresAt", "updatedAt"
        ) VALUES (
          '${ids.order}', '${ids.campus}', '${ids.round}', '${ids.userA}', 'order-invalid-98',
          98, 'CNY', 'v1', NOW() + INTERVAL '5 minutes', NOW()
        );
      `),
    ).rejects.toThrow(/price|check|23514/i);

    await database.exec(`
      UPDATE "CompanionGroup" SET "state" = 'REFUNDING' WHERE "id" = '${ids.group}';
      INSERT INTO "ContactAccessLog" (
        "id", "campusId", "roundId", "viewerId", "policyVersionId", "requestId",
        "outcome", "disclosedSubjectSetDigest", "disclosedSubjectCount"
      ) VALUES
        (
          '${ids.accessLogA}', '${ids.campus}', '${ids.round}', '${ids.userA}',
          '${ids.contactPolicy}', 'request-access-a', 'GRANTED',
          '1111111111111111111111111111111111111111111111111111111111111111', 1
        ),
        (
          '${ids.accessLogB}', '${ids.campus}', '${ids.round}', '${ids.userA}',
          '${ids.contactPolicy}', 'request-access-b', 'GRANTED',
          '1111111111111111111111111111111111111111111111111111111111111111', 1
        );
    `);

    const accessCount = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "ContactAccessLog" WHERE "roundId" = '${ids.round}'`,
    );
    expect(accessCount.rows[0]?.count).toBe("2");

    await expect(
      database.exec(`
        INSERT INTO "ContactAccessLog" (
          "id", "campusId", "roundId", "viewerId", "policyVersionId", "requestId", "outcome"
        ) VALUES (
          '00000000-0000-0000-0000-000000000a03', '${ids.campus}', '${ids.round}',
          '${ids.userA}', '${ids.contactPolicy}', 'request-denied-without-code', 'DENIED'
        );
      `),
    ).rejects.toThrow(/outcome|check|23514/i);

    await expect(
      database.exec(`
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d010', '${ids.userA}', '${ids.campus}',
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          '5678', 'PENDING', '${ids.contactPolicy}', NOW()
        );
      `),
    ).rejects.toThrow(/state|time|check|23514/i);

    await expect(
      database.exec(`
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "submittedAt", "latestSubmittedAt", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d011', '${ids.userA}', '${ids.campus}',
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          '9012', 'AWAITING_UPLOAD', '${ids.contactPolicy}', NOW(), NOW(), NOW()
        );
      `),
    ).rejects.toThrow(/state|time|check|23514/i);

    await database.exec(`
      INSERT INTO "StudentVerification" (
        "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
        "status", "consentPolicyId", "submittedAt", "latestSubmittedAt",
        "reviewedAt", "expiresAt", "updatedAt"
      ) VALUES (
        '00000000-0000-0000-0000-00000000d012', '${ids.userA}', '${ids.campus}',
        '1212121212121212121212121212121212121212121212121212121212121212',
        '1212', 'VERIFIED', '${ids.contactPolicy}', NOW() - INTERVAL '1 day',
        NOW() - INTERVAL '1 day', NOW(), NOW() + INTERVAL '1 year', NOW()
      );
    `);

    for (const invalidVerification of [
      `
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "submittedAt", "latestSubmittedAt",
          "reviewedAt", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d013', '${ids.userA}', '${ids.campus}',
          '1313131313131313131313131313131313131313131313131313131313131313',
          '1313', 'VERIFIED', '${ids.contactPolicy}', NOW() - INTERVAL '1 day',
          NOW() - INTERVAL '1 day', NOW(), NOW()
        );
      `,
      `
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "submittedAt", "latestSubmittedAt",
          "reviewedAt", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d014', '${ids.userA}', '${ids.campus}',
          '1414141414141414141414141414141414141414141414141414141414141414',
          '1414', 'VERIFICATION_EXPIRED', '${ids.contactPolicy}', NOW() - INTERVAL '1 day',
          NOW() - INTERVAL '1 day', NOW(), NOW()
        );
      `,
      `
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "submittedAt", "latestSubmittedAt",
          "reviewedAt", "expiresAt", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d015', '${ids.userA}', '${ids.campus}',
          '1515151515151515151515151515151515151515151515151515151515151515',
          '1515', 'REJECTED', '${ids.contactPolicy}', NOW() - INTERVAL '1 day',
          NOW() - INTERVAL '1 day', NOW(), NOW() + INTERVAL '1 year', NOW()
        );
      `,
      `
        INSERT INTO "StudentVerification" (
          "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
          "status", "consentPolicyId", "submittedAt", "latestSubmittedAt",
          "reviewedAt", "expiresAt", "updatedAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000d016', '${ids.userA}', '${ids.campus}',
          '1616161616161616161616161616161616161616161616161616161616161616',
          '1616', 'VERIFIED', '${ids.contactPolicy}', NOW() - INTERVAL '2 days',
          NOW() - INTERVAL '2 days', NOW(), NOW() - INTERVAL '1 day', NOW()
        );
      `,
    ]) {
      await expect(database.exec(invalidVerification)).rejects.toThrow(/state|time|check|23514/i);
    }
  });

  it("rolls a transaction back without leaving partial tenant data", async () => {
    const temporaryCampus = "00000000-0000-0000-0000-000000000099";
    await database.exec("BEGIN");
    await database.exec(
      `INSERT INTO "Campus" ("id", "name", "updatedAt") VALUES ('${temporaryCampus}', 'Rollback Campus', NOW())`,
    );
    await database.exec("ROLLBACK");

    const result = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "Campus" WHERE "id" = '${temporaryCampus}'`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("installs the final enum and custom database object inventory", async () => {
    const verificationStatuses = await database.query<{ enumlabel: string }>(
      databaseObjectInventorySql.verificationStatuses,
    );
    expect(verificationStatuses.rows.map((row) => row.enumlabel)).toEqual(
      expectedDatabaseObjectInventory.verificationStatuses,
    );

    const constraints = await database.query<{ conname: string }>(
      databaseObjectInventorySql.constraints,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expectedDatabaseObjectInventory.constraints,
    );

    const functions = await database.query<{ proname: string }>(
      databaseObjectInventorySql.functions,
    );
    expect(functions.rows.map((row) => row.proname)).toEqual(
      expectedDatabaseObjectInventory.functions,
    );

    const triggers = await database.query<{ tgname: string }>(databaseObjectInventorySql.triggers);
    expect(triggers.rows.map((row) => row.tgname)).toEqual(
      expectedDatabaseObjectInventory.triggers,
    );
  });

  it("atomically consumes a session-bound verification asset grant exactly once", async () => {
    const tokenDigest = "abababababababababababababababababababababababababababababababab";
    await database.exec(`
      INSERT INTO "StudentVerification" (
        "id", "userId", "campusId", "studentNumberDigest", "studentNumberLast4",
        "status", "consentPolicyId", "updatedAt"
      ) VALUES (
        '${ids.verification}', '${ids.userA}', '${ids.campus}',
        'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
        '3456', 'AWAITING_UPLOAD', '${ids.contactPolicy}', NOW()
      );
      INSERT INTO "VerificationAsset" (
        "id", "campusId", "verificationId", "objectKey", "uploadExpiresAt", "deleteAfter"
      ) VALUES (
        '${ids.verificationAsset}', '${ids.campus}', '${ids.verification}',
        'private/verification/asset', NOW() + INTERVAL '15 minutes', NOW() + INTERVAL '1 day'
      );
      INSERT INTO "AdminUser" (
        "id", "username", "passwordHash", "totpSecretCiphertext", "keyVersion", "updatedAt"
      ) VALUES (
        '${ids.admin}', 'reviewer', 'argon2id-test-hash', decode('00', 'hex'), 'kms-v1', NOW()
      );
      INSERT INTO "AdminSession" (
        "id", "adminUserId", "sessionTokenHash", "csrfTokenHash", "expiresAt",
        "lastReauthenticatedAt"
      ) VALUES (
        '${ids.adminSession}', '${ids.admin}',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        NOW() + INTERVAL '10 minutes', NOW()
      );
      INSERT INTO "VerificationAssetAccessGrant" (
        "id", "campusId", "verificationId", "adminUserId", "adminSessionId",
        "tokenDigest", "requestId", "expiresAt"
      ) VALUES (
        '${ids.assetGrant}', '${ids.campus}', '${ids.verification}', '${ids.admin}',
        '${ids.adminSession}', '${tokenDigest}', 'grant-issue-request',
        NOW() + INTERVAL '30 seconds'
      );
    `);

    const first = await database.query<{ grantId: string }>(`
      SELECT * FROM "consume_verification_asset_access_grant"(
        '${tokenDigest}', '${ids.adminSession}', '${ids.campus}',
        '${ids.grantAudit}', 'grant-consume-request-1'
      )
    `);
    expect(first.rows).toHaveLength(1);

    const replay = await database.query<{ grantId: string }>(`
      SELECT * FROM "consume_verification_asset_access_grant"(
        '${tokenDigest}', '${ids.adminSession}', '${ids.campus}',
        '00000000-0000-0000-0000-00000000e005', 'grant-consume-request-2'
      )
    `);
    expect(replay.rows).toHaveLength(0);

    const audit = await database.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM "AuditLog"
       WHERE "action" = 'VERIFICATION_ASSET_GRANT_CONSUMED'
         AND "targetId" = '${ids.verification}'
    `);
    expect(audit.rows[0]?.count).toBe("1");

    await expect(
      database.exec(`
        UPDATE "VerificationAssetAccessGrant"
           SET "usedAt" = NOW()
         WHERE "id" = '${ids.assetGrant}';
      `),
    ).rejects.toThrow(/already been consumed|check|23514/i);

    await expect(
      database.exec(`
        INSERT INTO "VerificationAssetAccessGrant" (
          "id", "campusId", "verificationId", "adminUserId", "adminSessionId",
          "tokenDigest", "requestId", "expiresAt"
        ) VALUES (
          '00000000-0000-0000-0000-00000000e006', '${ids.campus}',
          '${ids.verification}', '${ids.admin}', '${ids.adminSession}',
          'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
          'grant-too-long', NOW() + INTERVAL '61 seconds'
        );
      `),
    ).rejects.toThrow(/lifetime|check|23514/i);
  });
});
