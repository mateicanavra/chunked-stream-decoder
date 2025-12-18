import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { ChunkedDecoder } from "../src/decoder";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";
import { printBenchGlossary } from "./glossary";

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

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function benchCase(
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
    `${label} :: ${bench.name}
  median: ${ms.toFixed(2)} ms
  throughput: ${mibPerSec.toFixed(2)} MiB/s
  heap delta: ${(mem1 - mem0).toFixed(2)} MiB
  fragments: ${bench.fragments.length}
`
  );
}

function main() {
  printBenchGlossary("basic");

  // Keep payload ASCII so “chars == bytes” under the simplified decoder.
  const payloadMiB = 64;
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

  const benches: BenchCase[] = [
    { name: "single fragment", fragments: fragment(encoded, { type: "single" }) },
    { name: "fixed 64B fragments", fragments: fragment(encoded, { type: "fixed", size: 64 }) },
    { name: "random <= 64B fragments", fragments: fragment(encoded, { type: "random", max: 64, seed: 1 }) },
    { name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) },
    { name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) },
    { name: "adversarial CR/LF splits", fragments: fragment(encoded, { type: "adversarial-crlf" }) },
  ];

  // Correctness guard: streaming decode should reproduce payload exactly.
  for (const b of benches) {
    const h = createHash("sha256");
    const d = new ChunkedDecoder((s) => h.update(s));
    for (const f of b.fragments) d.decodeChunk(f);
    d.finalize();
    const got = h.digest("hex");
    if (got !== payloadHash) {
      throw new Error(`CORRUPT decode for bench '${b.name}': ${got} != ${payloadHash}`);
    }
  }

  console.log("All benchmarks passed correctness checks. Running perf...\n");

  for (const b of benches) {
    // Consumer mode 1: hash (simulates real consumption and prevents dead-code elimination).
    const runHash = () => {
      const h = createHash("sha256");
      const d = new ChunkedDecoder((s) => h.update(s));
      for (const f of b.fragments) d.decodeChunk(f);
      d.finalize();
      h.digest("hex");
    };
    benchCase("consumer=sha256", payloadLen, b, runHash);

    // Consumer mode 2: count-only (closer to parser overhead).
    const runCount = () => {
      let count = 0;
      const d = new ChunkedDecoder((s) => {
        count += s.length;
      });
      for (const f of b.fragments) d.decodeChunk(f);
      d.finalize();
      if (count !== payloadLen) throw new Error(`bad count: ${count} != ${payloadLen}`);
    };
    benchCase("consumer=count", payloadLen, b, runCount);
  }
}

main();
