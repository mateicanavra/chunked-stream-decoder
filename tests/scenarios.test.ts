import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";

import { CollectingDecoder } from "../src/core/decoder";
import { decodeChunkedStringV01 } from "../src/variants/decoder-01";
import { decodeChunkedStringRefined } from "../src/variants/decoder-01-refined";
import { fragment } from "../src/core/fragmenter";
import { loadScenarioJson, validateAndNormalizeScenario } from "../bench/scenario";

describe("Scenario fixtures", () => {
  it("chunked_sample_50.json decodes correctly (if present)", () => {
    const path = "fixtures/chunked_sample_50.json";
    if (!existsSync(path)) return;

    const scenario = validateAndNormalizeScenario(path, loadScenarioJson(path));

    const streamFragments =
      scenario.fragmentsFromFile ?? fragment(scenario.encoded, { type: "random", max: 7, seed: 42 });

    const d = new CollectingDecoder();
    for (const f of streamFragments) d.decodeChunk(f);
    d.finalize();
    expect(d.result).toBe(scenario.payload);

    expect(decodeChunkedStringV01(scenario.encoded)).toBe(scenario.payload);
    expect(decodeChunkedStringRefined(scenario.encoded)).toBe(scenario.payload);
  });
});
