import { describe, expect, it } from "vitest";
import { defaultConfig } from "../model/defaults";
import { decodeConfig, encodeConfig, encodeShare } from "./share";

describe("share links", () => {
  it("only carry the changes and load back to the same configuration", () => {
    const c = defaultConfig();
    c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
    c.environments = ["prod"];
    c.volumes = { prod: c.volumes.prod };
    c.volumes.prod.logsGbPerDay = 777;
    c.components.beyla = { enabled: true, options: { scope: "namespaces", namespaces: "shop" } };
    const short = encodeShare(c);
    expect(short.length).toBeLessThan(encodeConfig(c).length / 3);
    const back = decodeConfig(short)!;
    expect(back.platform).toEqual(c.platform);
    expect(back.environments).toEqual(["prod"]);
    expect(back.volumes.prod.logsGbPerDay).toBe(777);
    expect(back.components.beyla).toMatchObject({ enabled: true, options: { scope: "namespaces", namespaces: "shop" } });
  });

  it("the default configuration gives a very short link", () => {
    expect(encodeShare(defaultConfig()).length).toBeLessThan(40);
  });
});
