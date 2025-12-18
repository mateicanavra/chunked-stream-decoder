import { describe, it, expect } from "bun:test";
import { ChunkedDecoder, ChunkedCollectingDecoder } from "../src/decoder";
import { decodeChunkedStringV01 } from "../src/decoder-01";
import { decodeChunkedStringRefined } from "../src/decoder-01-refined";
import { runValidInputDecoderTests } from "./decoder.conformance";

function decodeViaCallback(fragments: string[]): string {
  const parts: string[] = [];
  const d = new ChunkedDecoder((s) => parts.push(s));
  for (const f of fragments) d.decodeChunk(f);
  d.finalize();
  return parts.join("");
}

function decodeViaCollector(fragments: string[]): string {
  const d = new ChunkedCollectingDecoder();
  for (const f of fragments) d.decodeChunk(f);
  d.finalize();
  return d.result;
}

runValidInputDecoderTests("ChunkedDecoder (streaming) via callback", decodeViaCallback);
runValidInputDecoderTests("ChunkedDecoder (streaming) via collector", decodeViaCollector);

runValidInputDecoderTests("Decoder v01 (batch, buffer+finalize)", (fragments) =>
  decodeChunkedStringV01(fragments.join(""))
);
runValidInputDecoderTests("Decoder v01 refined (batch, buffer+finalize)", (fragments) =>
  decodeChunkedStringRefined(fragments.join(""))
);

describe("ChunkedDecoder (streaming) extra behavior", () => {
  it("throws on malformed size-line CRLF", () => {
    const bad = "1\rX\r\nA\r\n0\r\n\r\n"; // CR not followed by LF in size line
    const d = new ChunkedCollectingDecoder();
    expect(() => d.decodeChunk(bad)).toThrow();
  });

  it("throws if finalize() is called before terminal chunk is read", () => {
    const encoded = "1\r\nA\r\n"; // missing 0\r\n\r\n
    const d = new ChunkedCollectingDecoder();
    d.decodeChunk(encoded);
    expect(() => d.finalize()).toThrow();
  });
});
