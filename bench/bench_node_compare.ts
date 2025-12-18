import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { ChunkedDecoder as ChunkedDecoderV1 } from "../src/decoder";
import { ChunkedDecoder as ChunkedDecoderV2 } from "../src/decoder-v2";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";
import { loadScenarioJson, validateAndNormalizeScenario, type LoadedScenario } from "./scenario";
import { printBenchGlossary } from "./glossary";

// Allow piping to `head`/`sed` without crashing on EPIPE.
process.stdout.on("error", (err: any) => {
  if (err?.code === "EPIPE") process.exit(0);
});

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

type DecoderVariant =
  | {
      kind: "streaming";
      name: string;
      checkHash: (fragments: string[]) => string;
      runHash: (fragments: string[]) => void;
      runCount: (fragments: string[], expectedLen: number) => void;
    }
  | {
      kind: "batch";
      name: string;
      checkHash: (encoded: string) => string;
      runHash: (encoded: string) => void;
      runCount: (encoded: string, expectedLen: number) => void;
    };

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

type BenchResult = {
  ms: number;
  mibPerSec: number;
  heapDeltaMiB: number;
  fragments: number;
};

function runBench(
  decoderName: string,
  label: string,
  payloadBytes: number,
  bench: BenchCase,
  runOnce: () => void,
  runs = 7
): BenchResult {
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
  const heapDeltaMiB = mem1 - mem0;

  return { ms, mibPerSec, heapDeltaMiB, fragments: bench.fragments.length };
}

function printBenchResult(decoderName: string, label: string, bench: BenchCase, r: BenchResult): void {
  console.log(
    `${decoderName} | ${label} :: ${bench.name}
  median: ${r.ms.toFixed(2)} ms
  throughput: ${r.mibPerSec.toFixed(2)} MiB/s
  heap delta: ${r.heapDeltaMiB.toFixed(2)} MiB
  fragments: ${r.fragments}
`
  );
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
  benches.push({ name: "random <= 64B fragments", fragments: fragment(encoded, { type: "random", max: 64, seed: 1 }) });
  benches.push({ name: "random <= 7B fragments", fragments: fragment(encoded, { type: "random", max: 7, seed: 2 }) });

  if (!skipWorst) {
    benches.push({ name: "worst-case 1B fragments", fragments: fragment(encoded, { type: "fixed", size: 1 }) });
    benches.push({ name: "adversarial CR/LF splits", fragments: fragment(encoded, { type: "adversarial-crlf" }) });
  }

  return benches;
}

function main() {
  printBenchGlossary("compare");

  const scenarioPaths = argValues("--scenario");
  const onlyScenarios = hasArg("--only-scenarios");
  const emit = hasArg("--emit");
  const emitAll = hasArg("--emit-all");
  const emitLimit = Number(argValue("--emit-limit") ?? "4000");

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

  const skipWorst = envBool("SKIP_WORST_CASES") || hasArg("--skip-worst");
  const benchJoin = !hasArg("--no-join-bench");
  const horizontal = envBool("HORIZONTAL") || hasArg("--horizontal");

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
      name: "ChunkedDecoder v1 (streaming)",
      checkHash(fragments: string[]) {
        const h = createHash("sha256");
        const d = new ChunkedDecoderV1((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        return h.digest("hex");
      },
      runHash(fragments: string[]) {
        const h = createHash("sha256");
        const d = new ChunkedDecoderV1((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        h.digest("hex");
      },
      runCount(fragments: string[], expectedLen: number) {
        let count = 0;
        const d = new ChunkedDecoderV1((s) => {
          count += s.length;
        });
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        if (count !== expectedLen) throw new Error(`bad count: ${count} != ${expectedLen}`);
      },
    },
    {
      kind: "streaming",
      name: "ChunkedDecoder v2 (streaming, explicit states)",
      checkHash(fragments: string[]) {
        const h = createHash("sha256");
        const d = new ChunkedDecoderV2((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        return h.digest("hex");
      },
      runHash(fragments: string[]) {
        const h = createHash("sha256");
        const d = new ChunkedDecoderV2((s) => h.update(s));
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        h.digest("hex");
      },
      runCount(fragments: string[], expectedLen: number) {
        let count = 0;
        const d = new ChunkedDecoderV2((s) => {
          count += s.length;
        });
        for (const f of fragments) d.decodeChunk(f);
        d.finalize();
        if (count !== expectedLen) throw new Error(`bad count: ${count} != ${expectedLen}`);
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
      runCount(encoded: string, expectedLen: number) {
        const decoded = decodeChunkedStringV01(encoded);
        if (decoded.length !== expectedLen) throw new Error(`bad count: ${decoded.length} != ${expectedLen}`);
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
      runCount(encoded: string, expectedLen: number) {
        const decoded = decodeChunkedStringRefined(encoded);
        if (decoded.length !== expectedLen) throw new Error(`bad count: ${decoded.length} != ${expectedLen}`);
      },
    },
  ];

  for (const input of inputs) {
    const benches = buildBenches(input.encoded, input.fragmentsFromFile, skipWorst);

    console.log(`\n=== Input: ${input.name} ===`);
    console.log(`decoded chars: ${input.payload.length}`);
    console.log(`decoded sha256: ${input.payloadHash}`);
    console.log(`\nCorrectness checks...`);

    for (const v of variants) {
      if (v.kind === "batch") {
        const got = v.checkHash(input.encoded);
        if (got !== input.payloadHash) {
          throw new Error(`CORRUPT decode for decoder='${v.name}' input='${input.name}': ${got} != ${input.payloadHash}`);
        }
        continue;
      }

      for (const b of benches) {
        const got = v.checkHash(b.fragments);
        if (got !== input.payloadHash) {
          throw new Error(
            `CORRUPT decode for decoder='${v.name}' input='${input.name}' bench='${b.name}': ${got} != ${input.payloadHash}`
          );
        }
      }
    }

    console.log("OK. Running perf...\n");

    // Batch decoders: benchmark on full-buffer input once (in-kind).
    for (const v of variants) {
      if (v.kind !== "batch") continue;
      const b: BenchCase = { name: "full buffer", fragments: [input.encoded] };
      if (!horizontal) {
        printBenchResult(
          v.name,
          "consumer=sha256",
          b,
          runBench(v.name, "consumer=sha256", input.payloadBytes, b, () => v.runHash(input.encoded))
        );
        printBenchResult(
          v.name,
          "consumer=count",
          b,
          runBench(v.name, "consumer=count", input.payloadBytes, b, () => v.runCount(input.encoded, input.payload.length))
        );
      }
    }

    if (horizontal) {
      const streaming = variants.filter((v) => v.kind === "streaming") as Extract<
        DecoderVariant,
        { kind: "streaming" }
      >[];
      const batch = variants.filter((v) => v.kind === "batch") as Extract<DecoderVariant, { kind: "batch" }>[];

      const variantNames = [...streaming.map((v) => v.name), ...batch.map((v) => v.name)];
      const benchWidth = Math.max("bench".length, ...benches.map((b) => b.name.length), "full buffer".length);
      const modeWidth = "consumer=sha256".length;

      const formatCell = (r: BenchResult): string =>
        `${r.ms.toFixed(2)}ms ${r.mibPerSec.toFixed(1)}MiB/s ${r.heapDeltaMiB >= 0 ? "+" : ""}${r.heapDeltaMiB.toFixed(
          2
        )}MiB`;

      const exampleCell = formatCell({ ms: 0, mibPerSec: 0, heapDeltaMiB: 0, fragments: 0 });
      const cellWidth = Math.max("result".length, exampleCell.length, ...variantNames.map((n) => n.length));
      const colSep = " | ";

      const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));

      const header =
        pad("bench", benchWidth) +
        colSep +
        pad("mode", modeWidth) +
        colSep +
        variantNames.map((n) => pad(n, cellWidth)).join(colSep);
      console.log(header);
      console.log("-".repeat(header.length));

      // Batch (in-kind): full-buffer only.
      for (const mode of ["consumer=sha256", "consumer=count"] as const) {
        const rowParts: string[] = [];
        for (const v of batch) {
          const b: BenchCase = { name: "full buffer", fragments: [input.encoded] };
          const r =
            mode === "consumer=sha256"
              ? runBench(v.name, mode, input.payloadBytes, b, () => v.runHash(input.encoded))
              : runBench(v.name, mode, input.payloadBytes, b, () => v.runCount(input.encoded, input.payload.length));
          rowParts.push(pad(formatCell(r), cellWidth));
        }

        const streamingPlaceholders = streaming.map(() => pad("-", cellWidth));
        const batchCells = rowParts;
        const allCells = [...streamingPlaceholders, ...batchCells].join(colSep);

        console.log(pad("full buffer", benchWidth) + colSep + pad(mode, modeWidth) + colSep + allCells);
      }

      // Streaming: each bench across all streaming variants.
      for (const b of benches) {
        for (const mode of ["consumer=sha256", "consumer=count"] as const) {
          const cells: string[] = [];
          for (const v of streaming) {
            const r =
              mode === "consumer=sha256"
                ? runBench(v.name, mode, input.payloadBytes, b, () => v.runHash(b.fragments))
                : runBench(v.name, mode, input.payloadBytes, b, () => v.runCount(b.fragments, input.payload.length));
            cells.push(pad(formatCell(r), cellWidth));
          }
          const batchPlaceholders = batch.map(() => pad("-", cellWidth));
          console.log(pad(b.name, benchWidth) + colSep + pad(mode, modeWidth) + colSep + [...cells, ...batchPlaceholders].join(colSep));
        }
      }

      if (emit) {
        emitText(`decoded output (expected/oracle) :: ${input.name}`, input.payload, emitLimit, emitAll);
      }

      continue;
    }

    // Streaming decoder: benchmark across fragmentation strategies.
    for (const b of benches) {
      if (benchJoin && b.fragments.length > 1) {
        const runJoin = () => {
          const joined = b.fragments.join("");
          if (joined !== input.encoded) throw new Error("join mismatch");
        };
        const encodedBytes = Buffer.byteLength(input.encoded, "utf8");
        printBenchResult(
          "reassembly",
          "fragments.join()",
          b,
          runBench("reassembly", "fragments.join()", encodedBytes, b, runJoin)
        );
      }

      for (const v of variants) {
        if (v.kind !== "streaming") continue;
        printBenchResult(
          v.name,
          "consumer=sha256",
          b,
          runBench(v.name, "consumer=sha256", input.payloadBytes, b, () => v.runHash(b.fragments))
        );
        printBenchResult(
          v.name,
          "consumer=count",
          b,
          runBench(v.name, "consumer=count", input.payloadBytes, b, () => v.runCount(b.fragments, input.payload.length))
        );
      }
    }

    if (emit) {
      emitText(`decoded output (expected/oracle) :: ${input.name}`, input.payload, emitLimit, emitAll);
    }
  }
}

main();
