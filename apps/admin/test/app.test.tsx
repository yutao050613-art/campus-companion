import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("admin foundation shell", () => {
  it("labels unavailable business modules instead of exposing fake actions", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("校园同行运营后台");
    expect(markup).toContain("M2 开放");
    expect(markup).toContain("不会提供司机、车辆、运价");
    expect(markup).not.toContain("立即退款");
  });
});
