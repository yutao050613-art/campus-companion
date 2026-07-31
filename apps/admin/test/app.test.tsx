import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("admin M2 authentication shell", () => {
  it("shows the student verification boundary before authentication", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Campus Companion · M2");
    expect(markup).toContain("学生认证审核台");
    expect(markup).toContain("仅处理学生身份认证");
    expect(markup).toContain("不接入司机、车辆、运价、车费或运输订单");
    expect(markup).not.toContain("立即退款");
  });
});
