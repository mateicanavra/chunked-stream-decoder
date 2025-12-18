import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { ChunkedDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";

function gcIfAvail(): void {
  // Requires: node --expose-gc ...
  (globalThis as any).gc?.();
}

function heapUsedMiB(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

type BenchCase = {
  name: string;
  fragments: string[];
};

type DecoderVariant = {
  name: string;
  runHash: (fragments: string[]) => void;
  runCount: (fragments: string[], expectedLen: number) => void;
  checkHash: (fragments: string[]) => string;
};

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function benchCase(
  decoderName: string,
  label: string,
  payloadBytes: number,
  bench: BenchCase,
  runOnce: () => void,
  runs = 7
): void {
  // Warmup
  for (let i = 0; i < 2; i++) runOnce();

  gcIfAvail();
  const mem0 = heapUsedMiB();

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    gcIfAvail();
    const t0 = performance.now();
    runOnce();
    const t1 = performance.now();
    times.push(t1 - t0);
  }

  gcIfAvail();
  const mem1 = heapUsedMiB();

  const ms = median(times);
  const mibPerSec = (payloadBytes / (1024 * 1024)) / (ms / 1000);

  console.log(
    `${decoderName} | ${label} :: ${bench.name}
  median: ${ms.toFixed(2)} ms
  throughput: ${mibPerSec.toFixed(2)} MiB/s
  heap delta: ${(mem1 - mem0).toFixed(2)} MiB
  fragments: ${bench.fragments.length}
`
  );
}

function envBool(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (v == null) return defaultValue;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function main() {
  // Keep payload ASCII so “chars == bytes” under the simplified decoders.
  const payloadMiB = Number(process.env.PAYLOAD_MIB ?? 64);
  const payloadLen = payloadMiB * 1024 * 1024;

  const { payload, encoded } = generateChunkedCase(payloadLen, {
    payloadSeed: 123,
    chunkSeed: 456,
    payloadCrlfProbability: 0.001,
    payloadCrProbability: 0.0005,
    payloadLfProbability: 0.0005,
    randomChunkMin: 1024,
    randomChunkMax: 16 * 1024,
  });

  const payloadHash = createHash("sha256").update(payload).digest("hex");

  const skipWorst = envBool("SKIP_WORST_CASES");

  const benches: BenchCase[] = [
    { name: "single fragment", fragments: fragment(encoded, { type: "single" }) },
    { name: "fixed 64B fragments", fragments: fragment(encoded, { type: "fixed", size: 64 }) },
    { name: "random <= 64B fragments", fragments: fragment(encoded, { type: "random", max: 64, seed: 1 }) },
    { name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) },
    ...(skipWorst ? [] : [{ name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) }]),
    ...(skipWorst
      ? []
      : [{ name: "adversarial CR/LF splits", fragments: fragment(encoded, { type: "adversarial-crlf" }) }]),
  ];

  const variants: DecoderVariant[] = [
    {
      name: "ChunkedDecoder (streaming)",
      checkHash(fragments) {
        const h = createHash("sha256");
        const d = new ChunkedDecoder((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        return h.digest("hex");
      },
      runHash(fragments) {
        const h = createHash("sha256");
        const d = new ChunkedDecoder((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        h.digest("hex");
      },
      runCount(fragments, expectedLen) {
        let count = 0;
        const d = new ChunkedDecoder((s) => {
          count += s.length;
        });
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        if (count !== expectedLen) throw new Error(`bad count: ${count} != ${expectedLen}`);
      },
    },
    {
      name: "decoder-01.ts (batch)",
      checkHash(fragments) {
        const decoded = decodeChunkedStringV01(fragments.join(""));
        return createHash("sha256").update(decoded).digest("hex");
      },
      runHash(fragments) {
        const decoded = decodeChunkedStringV01(fragments.join(""));
        createHash("sha256").update(decoded).digest("hex");
      },
      runCount(fragments, expectedLen) {
        const decoded = decodeChunkedStringV01(fragments.join(""));
        if (decoded.length !== expectedLen) throw new Error(`bad count: ${decoded.length} != ${expectedLen}`);
      },
    },
    {
      name: "decoder-01-refined.ts (batch)",
      checkHash(fragments) {
        const decoded = decodeChunkedStringRefined(fragments.join(""));
        return createHash("sha256").update(decoded).digest("hex");
      },
      runHash(fragments) {
        const decoded = decodeChunkedStringRefined(fragments.join(""));
        createHash("sha256").update(decoded).digest("hex");
      },
      runCount(fragments, expectedLen) {
        const decoded = decodeChunkedStringRefined(fragments.join(""));
        if (decoded.length !== expectedLen) throw new Error(`bad count: ${decoded.length} != ${expectedLen}`);
      },
    },
  ];

  // Correctness guard: decoders must reproduce payload exactly.
  for (const b of benches) {
    for (const v of variants) {
      const got = v.checkHash(b.fragments);
      if (got !== payloadHash) {
        throw new Error(`CORRUPT decode for decoder='${v.name}' bench='${b.name}': ${got} != ${payloadHash}`);
      }
    }
  }

  console.log("All benchmarks passed correctness checks. Running perf...\n");

  for (const b of benches) {
    for (const v of variants) {
      benchCase(v.name, "consumer=sha256", payloadLen, b, () => v.runHash(b.fragments));
      benchCase(v.name, "consumer=count", payloadLen, b, () => v.runCount(b.fragments, payloadLen));
    }
  }
}

main();

