import { describe, expect, it } from "vitest";
import { defaultConfig, resolvedConfig } from "./defaults";

describe("Kafka is opt-in", () => {
  it("is off by default: Mimir classic, Tempo monolithic", () => {
    const r = resolvedConfig(defaultConfig());
    expect(r.components.kafka.enabled).toBe(false);
    expect(r.components.mimir.options.architecture).toBe("classic");
    expect(r.components.tempo.options.mode).toBe("monolithic");
  });
  it("turning it on switches Mimir to ingest storage and Tempo to distributed", () => {
    const c = defaultConfig();
    c.components.kafka.enabled = true;
    const r = resolvedConfig(c);
    expect(r.components.mimir.options.architecture).toBe("ingest");
    expect(r.components.tempo.options.mode).toBe("distributed");
  });
  it("a Kafka-only choice is overruled while Kafka is off", () => {
    const c = defaultConfig();
    c.components.tempo.options.mode = "distributed";
    expect(resolvedConfig(c).components.tempo.options.mode).toBe("monolithic");
  });
});
