# chunked-stream-decoder-bench

A minimal (but complete) repo for a **streaming** decoder for a simplified “HTTP chunked” framing format:

```
<hex-size>\r\n<payload>\r\n ... 0\r\n\r\n
```

## What this repo includes

- `src/core/decoder.ts`
  - `ChunkedDecoder`: streaming decoder that emits payload via callback (no mega-buffer).
  - `ChunkedCollectingDecoder`: small wrapper that collects output and exposes `result`.
- `src/core/generator.ts`: diverse, deterministic chunked encoder + ASCII payload generator (with optional CR/LF/CRLF inside payload).
- `src/core/fragmenter.ts`: fixed/random/adversarial fragmentation helpers (simulate streaming boundaries).
- `src/variants/*`: older/alternate decoders used for comparisons.
- `tests/decoder.test.ts`: Bun tests (including randomized “chaos” tests).
- `fixtures/chunked_sample_50.json`: sample scenario fixture for compare benchmarks/tests.
- `bench/bench_node.ts`: Node benchmark with throughput + heap delta (recommended).
- `bench/bench_bun.ts`: Bun benchmark (approximate timing).

## Assumptions (important)

This is intentionally aligned to the original problem-set framing using **strings**:

- Chunk sizes are interpreted as **JS string character counts**.
- Payloads should be **ASCII** (so “characters == bytes”).
- No chunk extensions (e.g. `A;ext=1`) and no trailers.

If you want spec-correct byte semantics, you’d implement the same state machine on `Uint8Array`/`Buffer`.

This repo now also includes byte-accurate decoders in `src/core/decoder.ts`:
- `ByteChunkedDecoder` / `ByteCollectingDecoder` (payload as `Uint8Array`)
- `Utf8CollectingDecoder` (payload decoded as UTF-8 text via streaming `TextDecoder`)

## Install

Requires Bun. Node is optional (only for the Node benchmark).

```bash
bun install
```

## Run tests

```bash
bun test
```

## Generate a sample

```bash
bun run gen:sample
```

## Verify against real chunked wire data (optional)

Fetch a real HTTP/1.1 `Transfer-Encoding: chunked` response (kept in raw chunked form) and verify all decoders match a small “oracle” dechunker:

```bash
bun run verify:httpbin
```

Override the URL if you want:

```bash
URL='https://httpbin.org/stream/10' bun run verify:httpbin
```

## Fetch + decode a real chunked response (prints content + perf)

This fetches a single HTTP/1.1 `Transfer-Encoding: chunked` response in *raw chunked form*, verifies correctness against an independent “oracle” dechunker, prints speed stats, then prints the decoded content.

```bash
URL='https://httpbin.org/stream/3' bun run decode:url
```

Useful knobs:

```bash
# Fragmentation applied to the raw chunked body before feeding the streaming decoder
FRAG=random FRAG_MAX=7 FRAG_SEED=42 bun run decode:url

# Print everything (default prints up to 4k chars)
PRINT_ALL=1 bun run decode:url

# Save decoded output to a file
OUT=/tmp/decoded.txt bun run decode:url
```

## Benchmarks

### Bun benchmark (quick timing)

```bash
bun run bench:bun
```

### Bun compare benchmark (streaming vs batch decoders)

```bash
bun run bench:bun:compare
```

Use `--scenario` to benchmark JSON fixtures (like `fixtures/chunked_sample_50.json`):

```bash
bun run bench:bun:compare -- --only-scenarios --scenario fixtures/chunked_sample_50.json
```

Print decoded content too:

```bash
bun run bench:bun:compare -- --only-scenarios --scenario fixtures/chunked_sample_50.json --emit
```

### Node benchmark (better stats + heap delta)

Requires Node and uses `--expose-gc`.

```bash
bun run bench:node
```

### Node compare benchmark (streaming vs batch decoders)

```bash
bun run bench:node:compare
```

Both compare benchmarks accept:
- `PAYLOAD_MIB` (defaults: Node=64, Bun=32)
- `SKIP_WORST_CASES=1` to skip the extremely fragmented cases

Compare benchmark flags (both Node and Bun):
- `--scenario <file>` (repeatable) to add JSON fixtures as inputs
- `--only-scenarios` to skip the generated payload and only run fixtures
- `--emit` to print decoded output (use `--emit-limit N` / `--emit-all`)
- `--emit-escaped` to make `\r`/`\n` visible (recommended if your payload contains CR)

## How to use the decoder

### True streaming (minimal memory)

```ts
import { ChunkedDecoder } from "./src/core/decoder";

let count = 0;
const d = new ChunkedDecoder((fragment) => {
  // Process fragment immediately (write to file/socket, hash, etc.)
  count += fragment.length;
});

// Feed streaming fragments
d.decodeChunk("7\r");
d.decodeChunk("\nNewtonX\r\n0\r\n\r\n");

d.finalize();
console.log(count);
```

### Collecting output (convenience)

```ts
import { ChunkedCollectingDecoder } from "./src/core/decoder";

const d = new ChunkedCollectingDecoder();
for (const frag of fragments) d.decodeChunk(frag);
d.finalize();

console.log(d.result);
```

### Byte-accurate (real HTTP chunked)

```ts
import { Utf8CollectingDecoder } from "./src/core/decoder";

const d = new Utf8CollectingDecoder();
for await (const chunk of someReadableStream) d.decodeChunk(chunk); // chunk: Uint8Array
d.finalize();

console.log(d.result);
```
