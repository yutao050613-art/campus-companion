import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/index";

describe("structured logging", () => {
  it("redacts secrets and personal identifiers recursively", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ service: "test", destination });

    logger.info({
      accessToken: "CANARY_ACCESS_TOKEN",
      nested: { wechatId: "CANARY_WECHAT_ID", grantToken: "CANARY_GRANT_TOKEN" },
      req: {
        headers: {
          authorization: "Bearer CANARY_AUTH",
          "x-verification-asset-grant": "CANARY_GRANT_HEADER",
        },
      },
    });

    expect(output).not.toContain("CANARY_ACCESS_TOKEN");
    expect(output).not.toContain("CANARY_WECHAT_ID");
    expect(output).not.toContain("CANARY_AUTH");
    expect(output).not.toContain("CANARY_GRANT_TOKEN");
    expect(output).not.toContain("CANARY_GRANT_HEADER");
    expect(output).toContain("[REDACTED]");
  });
});
