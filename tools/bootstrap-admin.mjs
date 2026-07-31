import {
  AesGcmProtector,
  generateTotpSecret,
  hashAdminPassword,
} from "../packages/auth/dist/index.js";
import { createPrismaClient } from "../packages/database/dist/index.js";

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

const username = required("ADMIN_BOOTSTRAP_USERNAME");
const password = required("ADMIN_BOOTSTRAP_PASSWORD");
const campusId = required("ADMIN_BOOTSTRAP_CAMPUS_ID");
const encryptionKey = Buffer.from(required("DATA_ENCRYPTION_KEY_BASE64"), "base64");
const keyVersion = required("DATA_ENCRYPTION_KEY_VERSION");
if (!/^[A-Za-z0-9._-]{3,100}$/u.test(username)) throw new Error("invalid administrator username");
if (!/^[0-9a-f-]{36}$/iu.test(campusId)) throw new Error("invalid campus id");

const totpSecret = generateTotpSecret();
const protector = new AesGcmProtector(encryptionKey, keyVersion);
const encryptedTotp = protector.encrypt(totpSecret);
const passwordHash = await hashAdminPassword(password);
const prisma = createPrismaClient();

try {
  const admin = await prisma.$transaction(async (transaction) => {
    const campus = await transaction.campus.findUnique({ where: { id: campusId } });
    if (campus === null) throw new Error("campus does not exist");
    const role = await transaction.role.upsert({
      where: { code: "VERIFICATION_REVIEWER" },
      create: {
        code: "VERIFICATION_REVIEWER",
        description: "Review campus-scoped student verification requests",
      },
      update: {},
    });
    const created = await transaction.adminUser.create({
      data: {
        username,
        passwordHash,
        totpSecretCiphertext: Uint8Array.from(encryptedTotp.ciphertext),
        keyVersion: encryptedTotp.keyVersion,
        roles: { create: { roleId: role.id } },
        campusScopes: { create: { campusId } },
      },
    });
    await transaction.auditLog.create({
      data: {
        actorAdminId: created.id,
        campusId,
        action: "ADMIN_BOOTSTRAPPED",
        targetType: "AdminUser",
        targetId: created.id,
        requestId: `bootstrap-${created.id}`,
        reasonCode: "EXPLICIT_OPERATOR_BOOTSTRAP",
      },
    });
    return created;
  });
  const issuer = encodeURIComponent("Campus Companion");
  const label = encodeURIComponent(`Campus Companion:${username}`);
  const uri = `otpauth://totp/${label}?secret=${totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  process.stdout.write(
    `Administrator ${admin.username} created. Capture this one-time TOTP URI now; it will not be shown again.\n${uri}\n`,
  );
} finally {
  await prisma.$disconnect();
}
