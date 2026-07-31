export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly db: number;
  readonly maxRetriesPerRequest: null;
  readonly tls?: Readonly<Record<string, never>>;
}

export function toRedisConnection(redisUrl: string): RedisConnectionOptions {
  const parsed = new URL(redisUrl);
  const databaseSegment = parsed.pathname.slice(1);
  const database = databaseSegment === "" ? 0 : Number.parseInt(databaseSegment, 10);
  const port = parsed.port === "" ? 6379 : Number.parseInt(parsed.port, 10);
  if (!Number.isSafeInteger(database) || database < 0) {
    throw new Error("REDIS_URL contains an invalid database number");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REDIS_URL contains an invalid port");
  }

  return {
    host: parsed.hostname,
    port,
    ...(parsed.username === "" ? {} : { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password === "" ? {} : { password: decodeURIComponent(parsed.password) }),
    db: database,
    maxRetriesPerRequest: null,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
