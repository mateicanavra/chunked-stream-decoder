import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ChunkedCollectingDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { fragment } from "../src/fragmenter";

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

function decodeStreaming(encoded: string, fragType: Parameters<typeof fragment>[1]): string {
  const frags = fragment(encoded, fragType);
  const d = new ChunkedCollectingDecoder();
  for (const f of frags) d.decodeChunk(f);
  d.finalize();
  return d.result;
}

function main(): void {
  const url = process.env.URL ?? "https://httpbin.org/stream/3";

  const rawEncoded = runCurl(["-sS", "--http1.1", "--raw", url]).toString("utf8");
  const expectedDecoded = decodeChunkedOracle(rawEncoded);

  const variants: Array<{ name: string; decode: () => string }> = [
    { name: "ChunkedDecoder (streaming, single fragment)", decode: () => decodeStreaming(rawEncoded, { type: "single" }) },
    { name: "ChunkedDecoder (streaming, random<=7B)", decode: () => decodeStreaming(rawEncoded, { type: "random", max: 7, seed: 42 }) },
    { name: "ChunkedDecoder (streaming, adversarial CR/LF splits)", decode: () => decodeStreaming(rawEncoded, { type: "adversarial-crlf" }) },
    { name: "decoder-01.ts (batch)", decode: () => decodeChunkedStringV01(rawEncoded) },
    { name: "decoder-01-refined.ts (batch)", decode: () => decodeChunkedStringRefined(rawEncoded) },
  ];

  const expectedHash = sha256Hex(expectedDecoded);

  for (const v of variants) {
    const got = v.decode();
    const gotHash = sha256Hex(got);
    if (gotHash !== expectedHash) {
      throw new Error(
        `Mismatch for ${v.name}\n` +
          `  expected sha256: ${expectedHash}\n` +
          `  got sha256:      ${gotHash}\n` +
          `  expected len:    ${expectedDecoded.length}\n` +
          `  got len:         ${got.length}\n`
      );
    }
  }

  console.log(`OK: decoded output matches curl for ${variants.length} variants`);
  console.log(`URL: ${url}`);
  console.log(`decoded len: ${expectedDecoded.length}`);
  console.log(`decoded sha256: ${expectedHash}`);
}

main();
