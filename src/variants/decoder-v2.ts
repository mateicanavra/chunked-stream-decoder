export type OnData = (payloadFragment: string) => void;

type DecoderState =
  | "SIZE"          // Reading hex digits
  | "SIZE_LF"       // Saw size \r, expecting \n
  | "PAYLOAD"       // Reading data bytes
  | "PAYLOAD_CR"    // Payload done, expecting \r
  | "PAYLOAD_LF"    // Saw payload \r, expecting \n
  | "FINAL_CR"      // Saw size 0, expecting \r (term 1)
  | "FINAL_LF"      // Saw final \r, expecting \n (term 2)
  | "DONE";

export class ChunkedDecoder {
  private state: DecoderState = "SIZE";
  private sizeHex = "";
  private remaining = 0;

  constructor(private readonly onData: OnData) {}

  decodeChunk(chunk: string): void {
    if (this.state === "DONE") return;

    let i = 0;
    while (i < chunk.length) {
      switch (this.state) {
        // 1. Accumulate Hex Size
        case "SIZE": {
          const c = chunk[i++];
          if (c === "\r") {
            this.state = "SIZE_LF";
          } else {
            // Assumption: valid stream, no extensions. Collect the size line verbatim until CR.
            this.sizeHex += c;
          }
          break;
        }

        // 2. Validate LF after Size CR
        case "SIZE_LF": {
          const c = chunk[i++];
          if (c !== "\n") {
            throw new Error("Invalid chunked encoding: expected LF after CR in size line.");
          }

          // Match decoder.ts behavior: allow whitespace-only size line (treat as 0).
          const size = Number.parseInt(this.sizeHex.trim() || "0", 16);
          if (!Number.isFinite(size) || size < 0) {
            throw new Error(`Invalid chunk size: "${this.sizeHex}"`);
          }

          this.sizeHex = "";
          this.remaining = size;

          // If size is 0, we move to final termination; otherwise payload.
          this.state = size === 0 ? "FINAL_CR" : "PAYLOAD";
          break;
        }

        // 3. Consume Payload
        case "PAYLOAD": {
          const take = Math.min(this.remaining, chunk.length - i);

          // Emit immediately to satisfy streaming/greedy behavior.
          if (take > 0) {
            this.onData(chunk.slice(i, i + take));
            i += take;
            this.remaining -= take;
          }

          if (this.remaining === 0) {
            this.state = "PAYLOAD_CR";
          }
          break;
        }

        // 4. Expect CR after Payload
        case "PAYLOAD_CR": {
          const c = chunk[i++];
          if (c !== "\r") throw new Error("Invalid chunked encoding: expected CR after payload.");
          this.state = "PAYLOAD_LF";
          break;
        }

        // 5. Expect LF after Payload CR
        case "PAYLOAD_LF": {
          const c = chunk[i++];
          if (c !== "\n") throw new Error("Invalid chunked encoding: expected LF after CR after payload.");
          this.state = "SIZE"; // Loop back to start
          break;
        }

        // 6. Final Sequence: Expect CR (after 0 size)
        case "FINAL_CR": {
           // The stream looks like: 0\r\n\r\n
           // We just parsed 0\r\n. Now we need the final \r\n.
          const c = chunk[i++];
          if (c !== "\r") throw new Error("Invalid chunked encoding: expected final CR.");
          this.state = "FINAL_LF";
          break;
        }

        // 7. Final Sequence: Expect LF
        case "FINAL_LF": {
          const c = chunk[i++];
          if (c !== "\n") throw new Error("Invalid chunked encoding: expected final LF.");
          this.state = "DONE";
          return; // Stop processing immediately
        }
      }
    }
  }

  isDone(): boolean {
    return this.state === "DONE";
  }

  finalize(): void {
    if (!this.isDone()) throw new Error("Chunked stream not finished.");
  }
}

/**
 * A string accumulator that avoids pathological memory churn when the stream is split into
 * extremely tiny fragments. It groups many small fragments into medium-sized blocks.
 *
 * - Each fragment is stored once in `pending`.
 * - Occasionally, `pending` is joined into a single block string.
 * - At the very end, all blocks are joined to produce one final string.
 *
 * This ensures any character is copied O(1) times: once into a block and once
 * into the final result.
 */
class StringAccumulator {
  private blocks: string[] = [];
  private pending: string[] = [];
  private pendingChars = 0;

  constructor(
    private readonly maxPendingChars = 64 * 1024,
    private readonly maxPendingParts = 2048
  ) {}

  push(fragment: string): void {
    if (fragment.length === 0) return;

    this.pending.push(fragment);
    this.pendingChars += fragment.length;

    if (this.pendingChars >= this.maxPendingChars || this.pending.length >= this.maxPendingParts) {
      this.flush();
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.blocks.push(this.pending.join(""));
    this.pending = [];
    this.pendingChars = 0;
  }

  toString(): string {
    if (this.blocks.length === 0) {
      // Avoid one extra join in the common case.
      if (this.pending.length === 0) return "";
      if (this.pending.length === 1) return this.pending[0];
      return this.pending.join("");
    }

    // Flush pending into blocks once, then do a single final join.
    this.flush();

    if (this.blocks.length === 1) return this.blocks[0];
    return this.blocks.join("");
  }
}

export class ChunkedCollectingDecoder {
  private readonly accumulator = new StringAccumulator();
  private readonly decoder = new ChunkedDecoder((s) => this.accumulator.push(s));

  decodeChunk(chunk: string): void {
    this.decoder.decodeChunk(chunk);
  }

  get result(): string {
    return this.accumulator.toString();
  }

  finalize(): void {
    this.decoder.finalize();
  }
}

// Backwards-compatible alias used by tests/scripts/docs in decoder.ts.
export { ChunkedCollectingDecoder as CollectingDecoder };
