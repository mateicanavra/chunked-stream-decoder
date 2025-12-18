# chunked-stream-decoder-bench

A minimal (but complete) repo for a **streaming** decoder for a simplified “HTTP chunked” framing format:

```
<hex-size>\r\n<payload>\r\n ... 0\r\n\r\n
```

## What this repo includes

- `src/decoder.ts`
  - `ChunkedDecoder`: streaming parser that emits payload via callback (no mega-buffer).
  - `CollectingDecoder`: small wrapper that collects output and exposes `result`.
- `src/generator.ts`: diverse, deterministic chunked encoder + ASCII payload generator (with optional CR/LF/CRLF inside payload).
- `src/fragmenter.ts`: fixed/random/adversarial fragmentation helpers (simulate streaming boundaries).
- `tests/decoder.test.ts`: Bun tests (including randomized “chaos” tests).
- `bench/bench_node.ts`: Node benchmark with throughput + heap delta (recommended).
- `bench/bench_bun.ts`: Bun benchmark (approximate timing).

## Assumptions (important)

This is intentionally aligned to the original problem-set framing using **strings**:

- Chunk sizes are interpreted as **JS string character counts**.
- Payloads should be **ASCII** (so “characters == bytes”).
- No chunk extensions (e.g. `A;ext=1`) and no trailers.

If you want spec-correct byte semantics, you’d implement the same state machine on `Uint8Array`/`Buffer`.

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

## Benchmarks

### Bun benchmark (quick timing)

```bash
bun run bench:bun
```

### Node benchmark (better stats + heap delta)

Requires Node and uses `--expose-gc`.

```bash
bun run bench:node
```

## How to use the decoder

### True streaming (minimal memory)

```ts
import { ChunkedDecoder } from "./src/decoder";

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
import { CollectingDecoder } from "./src/decoder";

const d = new CollectingDecoder();
for (const frag of fragments) d.decodeChunk(frag);
d.finalize();

console.log(d.result);
```
