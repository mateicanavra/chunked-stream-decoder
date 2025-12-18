import { createHash } from "node:crypto";

import { ChunkedDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";
import { loadScenarioJson, validateAndNormalizeScenario, type LoadedScenario } from "./scenario";
import { printBenchGlossary } from "./glossary";

function gcIfAvail(): void {
  // Bun supports Bun.gc() on some versions. If not, no-op.
  const anyBun = Bun as any;
  if (typeof anyBun?.gc === "function") anyBun.gc(true);
}

type BenchCase = {
  name: string;
  fragments: string[];
};

type DecoderVariant =
  | {
      kind: "streaming";
      name: string;
      checkHash: (fragments: string[]) => string;
      runHash: (fragments: string[]) => void;
    }
  | {
      kind: "batch";
      name: string;
      checkHash: (encoded: string) => string;
      runHash: (encoded: string) => void;
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

function argValues(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`Missing value after ${flag}`);
      out.push(v);
      i++;
    }
  }
  return out;
}

function hasArg(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(flag: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`Missing value after ${flag}`);
      return v;
    }
  }
  return null;
}

function emitText(label: string, text: string, limit: number, emitAll: boolean): void {
  console.log(`\n--- ${label} ---`);
  const emitEscaped = hasArg("--emit-escaped");
  const out = emitEscaped ? text.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n") : text;

  if (emitAll || out.length <= limit) {
    process.stdout.write(out);
    if (!text.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  process.stdout.write(out.slice(0, limit));
  process.stdout.write(`\n\n[truncated: ${out.length - limit} chars; re-run with --emit-all]\n`);
}

type InputCase = {
  name: string;
  payload: string;
  encoded: string;
  payloadHash: string;
  payloadBytes: number;
  fragmentsFromFile: string[] | null;
};

function buildBenches(encoded: string, fragmentsFromFile: string[] | null, skipWorst: boolean): BenchCase[] {
  const benches: BenchCase[] = [];
  benches.push({ name: "single fragment (full buffer)", fragments: fragment(encoded, { type: "single" }) });
  if (fragmentsFromFile) benches.push({ name: "provided fragments (scenario)", fragments: fragmentsFromFile });
  benches.push({ name: "fixed 64B fragments", fragments: fragment(encoded, { type: "fixed", size: 64 }) });
  benches.push({ name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) });
  if (!skipWorst) benches.push({ name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) });
  return benches;
}

function main() {
  printBenchGlossary("compare");

  const scenarioPaths = argValues("--scenario");
  const onlyScenarios = hasArg("--only-scenarios");
  const emit = hasArg("--emit");
  const emitAll = hasArg("--emit-all");
  const emitLimit = Number(argValue("--emit-limit") ?? "4000");

  const payloadMiB = Number(process.env.PAYLOAD_MIB ?? 32);
  const payloadLen = payloadMiB * 1024 * 1024;

  const { payload, encoded } = generateChunkedCase(payloadLen, {
    payloadSeed: 123,
    chunkSeed: 456,
    randomChunkMin: 1024,
    randomChunkMax: 16 * 1024,
  });

  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const skipWorst = envBool("SKIP_WORST_CASES") || hasArg("--skip-worst");
  const benchJoin = !hasArg("--no-join-bench");

  const inputs: InputCase[] = [];
  if (!onlyScenarios) {
    inputs.push({
      name: `generated (${payloadMiB} MiB payload)`,
      payload,
      encoded,
      payloadHash,
      payloadBytes: payloadLen,
      fragmentsFromFile: null,
    });
  }

  for (const p of scenarioPaths) {
    const raw = loadScenarioJson(p);
    const s: LoadedScenario = validateAndNormalizeScenario(p, raw);
    inputs.push({
      name: s.name,
      payload: s.payload,
      encoded: s.encoded,
      payloadHash: s.payloadSha256Hex,
      payloadBytes: Buffer.byteLength(s.payload, "utf8"),
      fragmentsFromFile: s.fragmentsFromFile,
    });
  }

  if (inputs.length === 0) {
    throw new Error("No inputs selected. Provide --scenario <file> or remove --only-scenarios.");
  }

  const variants: DecoderVariant[] = [
    {
      kind: "streaming",
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
      kind: "batch",
      name: "decoder-01.ts (batch)",
      checkHash(encoded: string) {
        const decoded = decodeChunkedStringV01(encoded);
        return createHash("sha256").update(decoded).digest("hex");
      },
      runHash(encoded: string) {
        const decoded = decodeChunkedStringV01(encoded);
        createHash("sha256").update(decoded).digest("hex");
      },
    },
    {
      kind: "batch",
      name: "decoder-01-refined.ts (batch)",
      checkHash(encoded: string) {
        const decoded = decodeChunkedStringRefined(encoded);
        return createHash("sha256").update(decoded).digest("hex");
      },
      runHash(encoded: string) {
        const decoded = decodeChunkedStringRefined(encoded);
        createHash("sha256").update(decoded).digest("hex");
      },
    },
  ];

  console.log("Bun compare bench (approximate). For more robust memory stats, use: bun run bench:node:compare\n");

  for (const input of inputs) {
    const benches = buildBenches(input.encoded, input.fragmentsFromFile, skipWorst);

    console.log(`\n=== Input: ${input.name} ===`);
    console.log(`decoded chars: ${input.payload.length}`);
    console.log(`decoded sha256: ${input.payloadHash}`);
    console.log(`\nCorrectness checks...`);

    for (const v of variants) {
      if (v.kind === "batch") {
        if (v.checkHash(input.encoded) !== input.payloadHash) throw new Error(`bad decode for decoder=${v.name}`);
        continue;
      }
      for (const b of benches) {
        if (v.checkHash(b.fragments) !== input.payloadHash) {
          throw new Error(`bad decode for decoder=${v.name} bench=${b.name}`);
        }
      }
    }

    console.log("OK. Running perf...\n");

    const runs = 7;

    // Batch decoders: benchmark on full-buffer input once (in-kind).
    for (const v of variants) {
      if (v.kind !== "batch") continue;
      const b: BenchCase = { name: "full buffer", fragments: [input.encoded] };
      const times: number[] = [];
      for (let i = 0; i < 2; i++) v.runHash(input.encoded);
      for (let i = 0; i < runs; i++) {
        gcIfAvail();
        const t0 = performance.now();
        v.runHash(input.encoded);
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      const ms = median(times);
      const mibPerSec = (input.payloadBytes / (1024 * 1024)) / (ms / 1000);
      console.log(`${v.name} :: ${b.name}\n  median: ${ms.toFixed(2)} ms\n  throughput: ${mibPerSec.toFixed(2)} MiB/s\n`);
    }

    // Streaming decoder: benchmark across fragmentation strategies (+ optional join cost).
    for (const b of benches) {
      if (benchJoin && b.fragments.length > 1) {
        const times: number[] = [];
        const runJoin = () => {
          const joined = b.fragments.join("");
          if (joined !== input.encoded) throw new Error("join mismatch");
        };
        for (let i = 0; i < 2; i++) runJoin();
        for (let i = 0; i < runs; i++) {
          gcIfAvail();
          const t0 = performance.now();
          runJoin();
          const t1 = performance.now();
          times.push(t1 - t0);
        }
        const ms = median(times);
        const encodedBytes = Buffer.byteLength(input.encoded, "utf8");
        const mibPerSec = (encodedBytes / (1024 * 1024)) / (ms / 1000);
        console.log(`reassembly :: fragments.join() :: ${b.name}\n  median: ${ms.toFixed(2)} ms\n  throughput: ${mibPerSec.toFixed(2)} MiB/s\n`);
      }

      for (const v of variants) {
        if (v.kind !== "streaming") continue;
        const times: number[] = [];

        for (let i = 0; i < 2; i++) v.runHash(b.fragments);
        for (let i = 0; i < runs; i++) {
          gcIfAvail();
          const t0 = performance.now();
          v.runHash(b.fragments);
          const t1 = performance.now();
          times.push(t1 - t0);
        }

        const ms = median(times);
        const mibPerSec = (input.payloadBytes / (1024 * 1024)) / (ms / 1000);
        console.log(`${v.name} :: ${b.name}\n  median: ${ms.toFixed(2)} ms\n  throughput: ${mibPerSec.toFixed(2)} MiB/s\n`);
      }
    }

    if (emit) {
      emitText(`decoded output (expected/oracle) :: ${input.name}`, input.payload, emitLimit, emitAll);
    }
  }
}

main();
