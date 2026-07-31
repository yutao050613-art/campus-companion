import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmProtector, sha256Hex } from "@campus/auth";
import { Prisma } from "@campus/database";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../src/database/prisma.service";
import { IdempotencyService } from "../src/m2/idempotency.service";

const now = new Date("2026-07-31T12:00:00.000Z");
const actor = { userId: randomUUID(), campusId: randomUUID() } as const;
const key = "idempotency-unit-key-0001";
const protector = new AesGcmProtector(randomBytes(32), "m2-idempotency-test");

function prismaWith(transaction: Record<string, unknown>, outer: Record<string, unknown> = {}) {
  return {
    $transaction: vi.fn(async (action: (value: unknown) => Promise<unknown>) =>
      action(transaction),
    ),
    ...outer,
  } as unknown as PrismaService;
}

describe("IdempotencyService", () => {
  it("persists an encrypted response and returns the action result", async () => {
    const create = vi.fn().mockResolvedValue({});
    const transaction = {
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        delete: vi.fn(),
      },
    };
    const service = new IdempotencyService(
      prismaWith(transaction, {
        idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null) },
      }),
      protector,
    );
    const action = vi.fn().mockResolvedValue({ status: 201, body: { secretResult: "ok" } });

    await expect(
      service.execute("createThing", key, actor, { z: 1, a: true }, action, now),
    ).resolves.toEqual({ status: 201, body: { secretResult: "ok" }, replayed: false });
    expect(action).toHaveBeenCalledOnce();
    const persisted = create.mock.calls[0]?.[0]?.data as {
      responseCiphertext: Uint8Array;
      requestDigest: string;
      keyVersion: string;
    };
    expect(Buffer.from(persisted.responseCiphertext).toString("utf8")).not.toContain(
      "secretResult",
    );
    expect(persisted.keyVersion).toBe("m2-idempotency-test");
    expect(persisted.requestDigest).toBe(sha256Hex('{"a":true,"z":1}'));
  });

  it("replays a matching encrypted response without invoking the action", async () => {
    const encrypted = protector.encrypt(JSON.stringify({ value: 42 }));
    const record = {
      id: randomUUID(),
      userId: actor.userId,
      adminUserId: null,
      campusId: actor.campusId,
      requestDigest: sha256Hex('{"a":true,"z":1}'),
      responseStatus: 200,
      responseCiphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const transaction = {
      idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(record), delete: vi.fn() },
    };
    const action = vi.fn();
    const service = new IdempotencyService(
      prismaWith(transaction, {
        idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null) },
      }),
      protector,
    );

    await expect(
      service.execute("createThing", key, actor, { z: 1, a: true }, action, now),
    ).resolves.toEqual({ status: 200, body: { value: 42 }, replayed: true });
    expect(action).not.toHaveBeenCalled();
    await expect(
      service.findReplay("createThing", key, actor, { a: true, z: 1 }, now),
    ).resolves.toBeNull();
  });

  it("deletes expired evidence before executing a reused key", async () => {
    const remove = vi.fn().mockResolvedValue({});
    const transaction = {
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue({ id: randomUUID(), expiresAt: now }),
        delete: remove,
        create: vi.fn().mockResolvedValue({}),
      },
    };
    const service = new IdempotencyService(prismaWith(transaction), protector);
    await expect(
      service.execute(
        "createThing",
        key,
        actor,
        { value: 1 },
        vi.fn().mockResolvedValue({ status: 200, body: { renewed: true } }),
        now,
      ),
    ).resolves.toMatchObject({ replayed: false });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("retries a rolled-back serializable transaction up to the bounded attempt limit", async () => {
    const transaction = {
      idempotencyRecord: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
      },
    };
    const serializationConflict = new Prisma.PrismaClientKnownRequestError(
      "serialization conflict",
      { code: "P2034", clientVersion: "6.19.2" },
    );
    const runTransaction = vi
      .fn()
      .mockImplementationOnce(async (action: (value: unknown) => Promise<unknown>) => {
        await action(transaction);
        throw serializationConflict;
      })
      .mockImplementationOnce(async (action: (value: unknown) => Promise<unknown>) =>
        action(transaction),
      );
    const service = new IdempotencyService(
      prismaWith(transaction, {
        $transaction: runTransaction,
        idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null) },
      }),
      protector,
    );
    const action = vi.fn().mockResolvedValue({ status: 201, body: { retried: true } });

    await expect(
      service.execute("createThing", key, actor, { value: 1 }, action, now),
    ).resolves.toMatchObject({ status: 201, body: { retried: true }, replayed: false });
    expect(runTransaction).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("stops after three serializable transaction conflicts", async () => {
    const serializationConflict = new Prisma.PrismaClientKnownRequestError(
      "serialization conflict",
      { code: "P2034", clientVersion: "6.19.2" },
    );
    const runTransaction = vi.fn().mockRejectedValue(serializationConflict);
    const service = new IdempotencyService(
      prismaWith(
        {},
        {
          $transaction: runTransaction,
          idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(null) },
        },
      ),
      protector,
    );

    await expect(
      service.execute("createThing", key, actor, { value: 1 }, vi.fn(), now),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(runTransaction).toHaveBeenCalledTimes(3);
  });

  it("rejects actor, body, processing-state and key-version conflicts", async () => {
    const base = {
      id: randomUUID(),
      userId: actor.userId,
      adminUserId: null,
      campusId: actor.campusId,
      requestDigest: sha256Hex('{"value":1}'),
      responseStatus: 200,
      responseCiphertext: protector.encrypt("{}").ciphertext,
      keyVersion: protector.keyVersion,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    const serviceFor = (record: unknown) =>
      new IdempotencyService(
        prismaWith(
          { idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(record) } },
          { idempotencyRecord: { findUnique: vi.fn().mockResolvedValue(record) } },
        ),
        protector,
      );
    await expect(
      serviceFor(base).execute("createThing", key, actor, { value: 2 }, vi.fn(), now),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      serviceFor({ ...base, userId: randomUUID() }).execute(
        "createThing",
        key,
        actor,
        { value: 1 },
        vi.fn(),
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      serviceFor({ ...base, responseStatus: null }).execute(
        "createThing",
        key,
        actor,
        { value: 1 },
        vi.fn(),
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      serviceFor({ ...base, keyVersion: "retired" }).execute(
        "createThing",
        key,
        actor,
        { value: 1 },
        vi.fn(),
        now,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("validates keys, operations, actors and canonical JSON values", async () => {
    const service = new IdempotencyService(prismaWith({}), protector);
    const action = vi.fn();
    await expect(service.execute("ok", "short", actor, {}, action, now)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.execute("1bad", key, actor, {}, action, now)).rejects.toThrow(
      "invalid idempotency operation",
    );
    await expect(service.execute("valid", key, {}, {}, action, now)).rejects.toThrow(
      "exactly one identity",
    );
    await expect(
      service.execute("valid", key, { userId: userId(), adminUserId: userId() }, {}, action, now),
    ).rejects.toThrow("exactly one identity");
    await expect(
      service.execute("valid", key, actor, { value: Number.NaN }, action, now),
    ).rejects.toThrow("non-finite");
    await expect(
      service.execute("valid", key, actor, { value: undefined }, action, now),
    ).rejects.toThrow("unsupported");
  });
});

function userId(): string {
  return randomUUID();
}
