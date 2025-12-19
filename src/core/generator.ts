import { Rng } from "./rng";

export interface PayloadOptions {
  /** Seed for deterministic generation. */
  seed?: number;
  /** Probability of inserting a '\r' character. */
  crProbability?: number;
  /** Probability of inserting a '\n' character. */
  lfProbability?: number;
  /** Probability of inserting the 2-char sequence '\r\n'. */
  crlfProbability?: number;
}

const DEFAULT_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " +
  ".,;:!?-_()[]{}<>@#$%^&*+=/\\\"'";

export interface ChunkSizeFixed {
  type: "fixed";
  /** Chunk payload size in characters. */
  size: number;
}

export interface ChunkSizeRandom {
  type: "random";
  /** Minimum payload size per chunk. */
  min: number;
  /** Maximum payload size per chunk. */
  max: number;
  /** Seed for deterministic chunk sizing. */
  seed?: number;
}

export type ChunkSizeStrategy = ChunkSizeFixed | ChunkSizeRandom;

export interface EncodedChunk {
  size: number;
  hex: string;
  data: string;
}

export interface ChunkedEncoding {
  payload: string;
  encoded: string;
  chunks: EncodedChunk[];
}

/**
 * Generates an ASCII payload of exactly `length` characters.
 *
 * You can optionally sprinkle in '\r', '\n', and/or the sequence '\r\n' to
 * test that the decoder does NOT treat payload CRLF as protocol CRLF.
 */
export function makeAsciiPayload(length: number, opts: PayloadOptions = {}): string {
  const rng = new Rng(opts.seed ?? 12345);

  const crP = opts.crProbability ?? 0;
  const lfP = opts.lfProbability ?? 0;
  const crlfP = opts.crlfProbability ?? 0;

  let out = "";
  while (out.length < length) {
    // Prefer CRLF (2 chars) only when there is room.
    if (crlfP > 0 && out.length <= length - 2 && rng.chance(crlfP)) {
      out += "\r\n";
      continue;
    }
    if (crP > 0 && rng.chance(crP)) {
      out += "\r";
      continue;
    }
    if (lfP > 0 && rng.chance(lfP)) {
      out += "\n";
      continue;
    }

    const idx = rng.int(0, DEFAULT_ALPHABET.length - 1);
    out += DEFAULT_ALPHABET[idx];
  }
  return out;
}

/**
 * Encodes a payload using chunked framing:
 *   <hex-size>\r\n<payload>\r\n ... 0\r\n\r\n
 *
 * Important: `size` is the number of characters of the payload slice.
 * This matches the simplified string-based decoder and prompt examples (ASCII).
 */
export function encodeChunked(
  payload: string,
  strategy: ChunkSizeStrategy
): { encoded: string; chunks: EncodedChunk[] } {
  const chunks: EncodedChunk[] = [];

  let i = 0;
  let rng: Rng | null = null;
  if (strategy.type === "random") {
    rng = new Rng(strategy.seed ?? 999);
    if (strategy.min <= 0 || strategy.max <= 0) throw new Error("min/max must be > 0");
    if (strategy.max < strategy.min) throw new Error("max must be >= min");
  } else {
    if (strategy.size <= 0) throw new Error("size must be > 0");
  }

  while (i < payload.length) {
    const remaining = payload.length - i;

    const sz =
      strategy.type === "fixed"
        ? Math.min(strategy.size, remaining)
        : Math.min(rng!.int(strategy.min, strategy.max), remaining);

    const data = payload.slice(i, i + sz);
    const hex = sz.toString(16);

    chunks.push({ size: sz, hex, data });
    i += sz;
  }

  const encoded = chunks.map((c) => `${c.hex}\r\n${c.data}\r\n`).join("") + "0\r\n\r\n";

  return { encoded, chunks };
}

export interface GenerateCaseOptions {
  payloadSeed?: number;
  chunkSeed?: number;
  payloadCrlfProbability?: number;
  payloadCrProbability?: number;
  payloadLfProbability?: number;

  /** If provided, uses fixed chunk sizes; otherwise uses random chunk sizes. */
  fixedChunkSize?: number;

  /** Range for random chunk sizes (used when fixedChunkSize is not provided). */
  randomChunkMin?: number;
  randomChunkMax?: number;
}

/** Convenience: generate a payload + chunked encoding in one call. */
export function generateChunkedCase(payloadLength: number, opts: GenerateCaseOptions = {}): ChunkedEncoding {
  const payload = makeAsciiPayload(payloadLength, {
    seed: opts.payloadSeed ?? 1,
    crlfProbability: opts.payloadCrlfProbability ?? 0,
    crProbability: opts.payloadCrProbability ?? 0,
    lfProbability: opts.payloadLfProbability ?? 0,
  });

  const strategy: ChunkSizeStrategy =
    typeof opts.fixedChunkSize === "number"
      ? { type: "fixed", size: opts.fixedChunkSize }
      : {
          type: "random",
          min: opts.randomChunkMin ?? 1,
          max: opts.randomChunkMax ?? 16 * 1024,
          seed: opts.chunkSeed ?? 2,
        };

  const { encoded, chunks } = encodeChunked(payload, strategy);

  return { payload, encoded, chunks };
}
