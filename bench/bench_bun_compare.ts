import { createHash } from "node:crypto";

import { ChunkedDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";

function gcIfAvail(): void {
  // Bun supports Bun.gc() on some versions. If not, no-op.
  const anyBun = Bun as any;
  if (typeof anyBun?.gc === "function") anyBun.gc(true);
}

type BenchCase = {
  name: string;
  fragments: string[];
};

type DecoderVariant = {
  name: string;
  runHash: (fragments: string[]) => void;
  checkHash: (fragments: string[]) => string;
};

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function envBool(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (v == null) return defaultValue;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function main() {
  const payloadMiB = Number(process.env.PAYLOAD_MIB ?? 32);
  const payloadLen = payloadMiB * 1024 * 1024;

  const { payload, encoded } = generateChunkedCase(payloadLen, {
    payloadSeed: 123,
    chunkSeed: 456,
    randomChunkMin: 1024,
    randomChunkMax: 16 * 1024,
  });

  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const skipWorst = envBool("SKIP_WORST_CASES");

  const benches: BenchCase[] = [
    { name: "single fragment", fragments: fragment(encoded, { type: "single" }) },
    { name: "fixed 64B fragments", fragments: fragment(encoded, { type: "fixed", size: 64 }) },
    { name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) },
    ...(skipWorst ? [] : [{ name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) }]),
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
    },
  ];

  for (const b of benches) {
    for (const v of variants) {
      if (v.checkHash(b.fragments) !== payloadHash) throw new Error(`bad decode for decoder=${v.name} bench=${b.name}`);
    }
  }

  console.log("Bun compare bench (approximate). For more robust memory stats, use: bun run bench:node:compare\n");

  for (const b of benches) {
    for (const v of variants) {
      const runs = 7;
      const times: number[] = [];

      // Warmup
      for (let i = 0; i < 2; i++) v.runHash(b.fragments);

      for (let i = 0; i < runs; i++) {
        gcIfAvail();
        const t0 = performance.now();
        v.runHash(b.fragments);
        const t1 = performance.now();
        times.push(t1 - t0);
      }

      const ms = median(times);
      const mibPerSec = (payloadLen / (1024 * 1024)) / (ms / 1000);

      console.log(`${v.name} :: ${b.name}
  median: ${ms.toFixed(2)} ms
  throughput: ${mibPerSec.toFixed(2)} MiB/s
  fragments: ${b.fragments.length}
`);
    }
  }
}

main();

