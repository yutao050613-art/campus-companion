import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("API configuration", () => {
  it("applies safe development defaults", () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: "development",
      port: 3000,
      version: "0.1.0",
      logLevel: "info",
    });
  });

  it("rejects an invalid port instead of silently coercing it", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow();
  });
});
