import { ChunkedCollectingDecoder } from "../src/decoder";
import { generateChunkedCase } from "../src/generator";
import { fragment } from "../src/fragmenter";

const { payload, encoded, chunks } = generateChunkedCase(120, {
  payloadSeed: 42,
  chunkSeed: 99,
  randomChunkMin: 1,
  randomChunkMax: 16,
  payloadCrlfProbability: 0.05,
});

console.log("Payload:");
console.log(payload);
console.log("\nEncoded (chunked):");
console.log(encoded);

console.log("\nChunk sizes:", chunks.map((c) => c.size));

const frags = fragment(encoded, { type: "random", max: 7, seed: 123 });
const d = new ChunkedCollectingDecoder();
for (const f of frags) d.decodeChunk(f);
d.finalize();

console.log("\nDecoded:");
console.log(d.result);
