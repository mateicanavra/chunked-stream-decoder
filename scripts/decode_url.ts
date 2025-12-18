import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { ChunkedDecoder, CollectingDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { fragment } from "../src/fragmenter";

type FragmentationEnv =
  | { type: "single" }
  | { type: "fixed"; size: number }
  | { type: "random"; max: number; seed: number }
  | { type: "adversarial-crlf" };

function runCurl(args: string[]): Buffer {
  const res = spawnSync("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString("utf8") ?? "";
    throw new Error(`curl failed (exit ${res.status}): ${stderr}`);
  }
  return res.stdout as Buffer;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function envBool(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (v == null) return defaultValue;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v == null) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

function detectChunkExtensions(rawChunked: string): boolean {
  let i = 0;
  while (true) {
    const rn = rawChunked.indexOf("\r\n", i);
    if (rn === -1) return false;
    const sizeLine = rawChunked.slice(i, rn);
    if (sizeLine.includes(";")) return true;
    const sizeToken = sizeLine.trim();
    const size = Number.parseInt(sizeToken || "0", 16);
    if (!Number.isFinite(size) || size < 0) return false;
    i = rn + 2;
    if (size === 0) return false;
    i += size;
    if (rawChunked.slice(i, i + 2) !== "\r\n") return false;
    i += 2;
  }
}

function decodeChunkedOracle(encoded: string): string {
  const parts: string[] = [];
  let i = 0;

  while (true) {
    const rn = encoded.indexOf("\r\n", i);
    if (rn === -1) throw new Error("oracle: missing CRLF after size line");

    // Allow chunk extensions (size;ext=...) just in case.
    const sizeToken = encoded
      .slice(i, rn)
      .split(";", 1)[0]
      .trim();
    const size = Number.parseInt(sizeToken || "0", 16);
    if (!Number.isFinite(size) || size < 0) throw new Error(`oracle: bad chunk size "${sizeToken}"`);

    i = rn + 2;

    if (size === 0) {
      // Simplified termination: expect final CRLF and end.
      if (encoded.slice(i, i + 2) !== "\r\n") throw new Error("oracle: missing final CRLF");
      i += 2;
      break;
    }

    if (i + size > encoded.length) throw new Error("oracle: payload truncated");
    parts.push(encoded.slice(i, i + size));
    i += size;

    if (encoded.slice(i, i + 2) !== "\r\n") throw new Error("oracle: missing CRLF after payload");
    i += 2;
  }

  if (i !== encoded.length) throw new Error(`oracle: trailing data after terminal chunk (${encoded.length - i} chars)`);
  return parts.join("");
}

function parseFragmentationFromEnv(): FragmentationEnv {
  const kind = (process.env.FRAG ?? "random").toLowerCase();
  if (kind === "single") return { type: "single" };
  if (kind === "adversarial-crlf") return { type: "adversarial-crlf" };
  if (kind === "fixed") return { type: "fixed", size: envInt("FRAG_SIZE", 64) };
  // default random
  return { type: "random", max: envInt("FRAG_MAX", 64), seed: envInt("FRAG_SEED", 42) };
}

function decodeStreamingToString(fragments: string[]): string {
  const d = new CollectingDecoder();
  for (const f of fragments) d.decodeChunk(f);
  d.finalize();
  return d.result;
}

function decodeStreamingHash(fragments: string[]): string {
  const h = createHash("sha256");
  const d = new ChunkedDecoder((s) => h.update(s));
  for (const f of fragments) d.decodeChunk(f);
  d.finalize();
  return h.digest("hex");
}

function bench(label: string, bytes: number, runOnce: () => void): { msMedian: number; mibPerSec: number } {
  const runs = envInt("RUNS", 7);
  const warmup = envInt("WARMUP", 2);

  for (let i = 0; i < warmup; i++) runOnce();

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    runOnce();
    const t1 = performance.now();
    times.push(t1 - t0);
  }

  const msMedian = median(times);
  const mibPerSec = (bytes / (1024 * 1024)) / (msMedian / 1000);
  console.log(`${label}\n  median: ${msMedian.toFixed(2)} ms\n  throughput: ${mibPerSec.toFixed(2)} MiB/s\n`);
  return { msMedian, mibPerSec };
}

function main(): void {
  const url = process.env.URL ?? "https://httpbin.org/stream/3";
  const outPath = process.env.OUT;
  const printAll = envBool("PRINT_ALL");
  const printLimit = envInt("PRINT_LIMIT", 4000);
  const skipBatch = envBool("SKIP_BATCH");
  const fragSpec = parseFragmentationFromEnv();

  // Fetch raw chunked body (includes size lines + CRLF delimiters).
  const rawChunked = runCurl(["-sS", "--http1.1", "--raw", "-H", "Accept-Encoding: identity", url]).toString("utf8");

  const hasExtensions = detectChunkExtensions(rawChunked);
  if (hasExtensions) {
    console.warn("Warning: response uses chunk extensions (size;ext=...). Batch decoders may not support this.");
  }

  const expectedDecoded = decodeChunkedOracle(rawChunked);
  const expectedHash = sha256Hex(expectedDecoded);
  const decodedBytes = Buffer.byteLength(expectedDecoded, "utf8");

  const fragments = fragment(rawChunked, fragSpec as any);

  console.log(`URL: ${url}`);
  console.log(`raw chunked chars: ${rawChunked.length}`);
  console.log(`decoded chars: ${expectedDecoded.length}`);
  console.log(`decoded utf8 bytes: ${decodedBytes}`);
  console.log(`decoded sha256: ${expectedHash}`);
  console.log(`fragmentation: ${JSON.stringify(fragSpec)}`);
  console.log(`fragments: ${fragments.length}\n`);

  // Correctness: all variants should match the oracle.
  const streamingHash = decodeStreamingHash(fragments);
  if (streamingHash !== expectedHash) {
    throw new Error(`Streaming decoder mismatch: ${streamingHash} != ${expectedHash}`);
  }

  if (!skipBatch) {
    const v01Hash = sha256Hex(decodeChunkedStringV01(rawChunked));
    if (v01Hash !== expectedHash) throw new Error(`decoder-01.ts mismatch: ${v01Hash} != ${expectedHash}`);

    const refinedHash = sha256Hex(decodeChunkedStringRefined(rawChunked));
    if (refinedHash !== expectedHash) throw new Error(`decoder-01-refined.ts mismatch: ${refinedHash} != ${expectedHash}`);
  }

  console.log("Correctness: OK (matches oracle)\n");

  // Perf: measure hash-only runs to avoid printing costs.
  bench("ChunkedDecoder (streaming) consumer=sha256", decodedBytes, () => {
    const h = createHash("sha256");
    const d = new ChunkedDecoder((s) => h.update(s));
    for (const f of fragments) d.decodeChunk(f);
    d.finalize();
    h.digest("hex");
  });

  if (!skipBatch) {
    bench("decoder-01.ts (batch) consumer=sha256", decodedBytes, () => {
      const decoded = decodeChunkedStringV01(rawChunked);
      createHash("sha256").update(decoded).digest("hex");
    });

    bench("decoder-01-refined.ts (batch) consumer=sha256", decodedBytes, () => {
      const decoded = decodeChunkedStringRefined(rawChunked);
      createHash("sha256").update(decoded).digest("hex");
    });
  }

  const decoded = decodeStreamingToString(fragments);
  if (outPath) {
    writeFileSync(outPath, decoded, "utf8");
    console.log(`Wrote decoded output to: ${outPath}\n`);
  }

  if (printAll || decoded.length <= printLimit) {
    console.log("Decoded output:\n");
    process.stdout.write(decoded);
    if (!decoded.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  console.log(`Decoded output (first ${printLimit} chars; set PRINT_ALL=1 to print full):\n`);
  process.stdout.write(decoded.slice(0, printLimit));
  process.stdout.write("\n");
}

main();
