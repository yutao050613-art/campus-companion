import { PrismaClient } from "../generated/client";

export * from "../generated/client";
export * from "./refund-recovery";

export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}
