import { describe, it, expect } from "bun:test";
import { generateChunkedCase, encodeChunked } from "../src/core/generator";
import { fragment } from "../src/core/fragmenter";

export type DecodeFromFragments = (fragments: string[]) => string;

export function runValidInputDecoderTests(name: string, decodeFromFragments: DecodeFromFragments): void {
  describe(name, () => {
    it("decodes the prompt example", () => {
      const encoded =
        "7\r\nNewtonX\r\n" +
        "B\r\n is hiring \r\n" +
        "8\r\nawesome \r\n" +
        "9\r\nengineers\r\n" +
        "0\r\n\r\n";

      const frags = fragment(encoded, { type: "random", max: 7, seed: 42 });
      expect(decodeFromFragments(frags)).toBe("NewtonX is hiring awesome engineers");
    });

    it("handles payloads that contain CR/LF/CRLF sequences", () => {
      const payload = "hello\rworld\nOK\r\nEND";
      const { encoded } = encodeChunked(payload, { type: "fixed", size: 3 });

      // Very adversarial fragmentation: split after every CR or LF.
      const frags = fragment(encoded, { type: "adversarial-crlf" });
      expect(decodeFromFragments(frags)).toBe(payload);
    });

    it("passes randomized chaos tests across fragmentation strategies", () => {
      const strategies = [
        { type: "single" } as const,
        { type: "fixed", size: 1 } as const,
        { type: "fixed", size: 2 } as const,
        { type: "fixed", size: 7 } as const,
        { type: "fixed", size: 64 } as const,
        { type: "random", max: 7, seed: 1 } as const,
        { type: "random", max: 64, seed: 2 } as const,
        { type: "adversarial-crlf" } as const,
      ];

      for (let seed = 1; seed <= 25; seed++) {
        const payloadLen = 2000 + (seed * 7919) % 6000; // 2k..8k-ish
        const { payload, encoded } = generateChunkedCase(payloadLen, {
          payloadSeed: seed,
          chunkSeed: seed * 1000 + 7,
          payloadCrlfProbability: 0.02,
          payloadCrProbability: 0.01,
          payloadLfProbability: 0.01,
          randomChunkMin: 1,
          randomChunkMax: 128,
        });

        for (const strat of strategies) {
          const frags = fragment(encoded, strat as any);
          expect(decodeFromFragments(frags)).toBe(payload);
        }
      }
    });
  });
}

