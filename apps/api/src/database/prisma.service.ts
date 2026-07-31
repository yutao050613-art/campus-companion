import { PrismaClient } from "@campus/database";
import { Injectable, type OnApplicationShutdown } from "@nestjs/common";

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  public constructor() {
    super();
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
