export type OnData = (payloadFragment: string) => void;

/**
 * Streaming chunked decoder for the simplified “problem set” format:
 *
 *   <hex-size>\r\n<payload>\r\n ... 0\r\n\r\n
 *
 * Assumptions (matches the prompt examples):
 * - Input arrives as JS strings.
 * - “Size” counts JS characters (ASCII payload). This is NOT byte-accurate for UTF-8/binary.
 * - No chunk extensions (e.g. ";ext=...") and no trailers.
 */
export class ChunkedDecoder {
  private state: "SIZE" | "PAYLOAD" | "EXPECT_CRLF" | "DONE" = "SIZE";

  // SIZE parsing (tiny state)
  private sizeHex = "";
  private sawCR = false;

  // PAYLOAD parsing
  private remaining = 0;

  // CRLF expectation parsing
  private expectIndex = 0; // 0 => expect '\r', 1 => expect '\n'
  private afterExpect: "SIZE" | "DONE" = "SIZE";

  constructor(private readonly onData: OnData) {}

  decodeChunk(chunk: string): void {
    if (this.state === "DONE") return;

    // Cursor into the current chunk
    let i = 0;
    while (i < chunk.length) {

      // STATE: gathering the hex size line
      if (this.state === "SIZE") {
        const c = chunk[i++];

        // If we previously consumed a '\r' for the size line, the next char MUST be '\n'.
        // 
        if (this.sawCR) {
          if (c !== "\n") throw new Error("Invalid chunked encoding: expected LF after CR in size line.");
          this.sawCR = false;

          const n = Number.parseInt(this.sizeHex.trim() || "0", 16);
          if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid chunk size: "${this.sizeHex}"`);

          this.sizeHex = "";
          this.remaining = n;

          if (n === 0) {
            // Simplified termination: after "0\r\n" we expect the final "\r\n".
            this.startExpectCRLF("DONE");
          } else {
            this.state = "PAYLOAD";
          }
          continue;
        }

        // Found the end of the size line!
        if (c === "\r") {
          this.sawCR = true;
          continue;
        }

        // Assumption: valid stream, no extensions. Collect the size line verbatim until CR.
        this.sizeHex += c;
        continue;
      }

      // STATE: consuming payload by known size
      if (this.state === "PAYLOAD") {
        // Greedily consume payload from the current fragment without buffering.
        const available = chunk.length - i;
        const take = Math.min(this.remaining, available);

        if (take > 0) {
          this.onData(chunk.slice(i, i + take));
          i += take;
          this.remaining -= take;
        }

        if (this.remaining === 0) {
          // After payload there must be a CRLF terminator.
          this.startExpectCRLF("SIZE");
        }
        continue;
      }

      // STATE: expecting either payload CRLF (1) or final CRLF (2).
      // Moves either to SIZE (1) or DONE (2) state.
      if (this.state === "EXPECT_CRLF") {
        const expected = this.expectIndex === 0 ? "\r" : "\n";
        const c = chunk[i++];

        if (c !== expected) throw new Error("Invalid chunked encoding: expected CRLF.");

        this.expectIndex++;
        if (this.expectIndex === 2) {
          this.expectIndex = 0;
          this.state = this.afterExpect === "DONE" ? "DONE" : "SIZE";
          if (this.state === "DONE") return;
        }
        continue;
      }

      // DONE
      return;
    }
  }

  isDone(): boolean {
    return this.state === "DONE";
  }

  /** Throws unless we have consumed a full terminal 0-sized chunk (0\r\n\r\n). */
  finalize(): void {
    if (!this.isDone()) throw new Error("Chunked stream not finished.");
  }

  private startExpectCRLF(next: "SIZE" | "DONE"): void {
    this.state = "EXPECT_CRLF";
    this.expectIndex = 0;
    this.afterExpect = next;
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

/**
 * Convenience wrapper matching the “decoder with a result” style.
 *
 * Use ChunkedDecoder directly if you want true streaming output.
 */
export class ChunkedCollectingDecoder {
  private readonly accumulator = new StringAccumulator();
  private readonly decoder = new ChunkedDecoder((s) => this.accumulator.push(s));

  decodeChunk(chunk: string): void {
    this.decoder.decodeChunk(chunk);
  }

  finalize(): void {
    this.decoder.finalize();
  }

  get result(): string {
    // ! Allow partial results
    // if (!this.decoder.isDone()) {
    //   throw new Error("Not finished yet (call finalize() after feeding all chunks).");
    // }
    return this.accumulator.toString();
  }
}

// Backwards-compatible alias used by tests/scripts/docs.
export { ChunkedCollectingDecoder as CollectingDecoder };
