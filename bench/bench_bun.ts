import { createHash } from "node:crypto";
import { ChunkedDecoder } from "../src/core/decoder";
import { generateChunkedCase } from "../src/core/generator";
import { fragment } from "../src/core/fragmenter";
import { printBenchGlossary } from "./glossary";

function gcIfAvail(): void {
  // Bun supports Bun.gc() on some versions. If not, no-op.
  const anyBun = Bun as any;
  if (typeof anyBun?.gc === "function") anyBun.gc(true);
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function main() {
  printBenchGlossary("basic");

  const payloadMiB = 32;
  const payloadLen = payloadMiB * 1024 * 1024;

  const { payload, encoded } = generateChunkedCase(payloadLen, {
    payloadSeed: 123,
    chunkSeed: 456,
    randomChunkMin: 1024,
    randomChunkMax: 16 * 1024,
  });

  const payloadHash = createHash("sha256").update(payload).digest("hex");

  const benches = [
    { name: "single fragment", fragments: fragment(encoded, { type: "single" }) },
    { name: "fixed 64B fragments", fragments: fragment(encoded, { type: "fixed", size: 64 }) },
    { name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) },
    { name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) },
  ];

  for (const b of benches) {
    // Correctness check
    const h = createHash("sha256");
    const d = new ChunkedDecoder((s) => h.update(s));
    for (const f of b.fragments) d.decodeChunk(f);
    d.finalize();
    if (h.digest("hex") !== payloadHash) throw new Error(`bad decode for ${b.name}`);
  }

  console.log("Bun bench (approximate). For more robust memory stats, use: bun run bench:node\n");

  for (const b of benches) {
    const runs = 7;
    const times: number[] = [];

    // Warmup
    for (let i = 0; i < 2; i++) {
      const h = createHash("sha256");
      const d = new ChunkedDecoder((s) => h.update(s));
      for (const f of b.fragments) d.decodeChunk(f);
      d.finalize();
      h.digest("hex");
    }

    for (let i = 0; i < runs; i++) {
      gcIfAvail();
      const t0 = performance.now();

      const h = createHash("sha256");
      const d = new ChunkedDecoder((s) => h.update(s));
      for (const f of b.fragments) d.decodeChunk(f);
      d.finalize();
      h.digest("hex");

      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const ms = median(times);
    const mibPerSec = (payloadLen / (1024 * 1024)) / (ms / 1000);

    console.log(`${b.name}
  median: ${ms.toFixed(2)} ms
  throughput: ${mibPerSec.toFixed(2)} MiB/s
  fragments: ${b.fragments.length}
`);
  }
}

main();
