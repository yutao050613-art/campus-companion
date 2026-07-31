import { PrismaClient } from "../generated/client";

export * from "../generated/client";

export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}
