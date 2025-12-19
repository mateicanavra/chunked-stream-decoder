/**
 * V01: batch decoding with a simple "consume head, keep rest" loop.
 *
 * Assumptions:
 * - Input is a valid CRLF chunked encoded string (simplified format).
 * - No chunk extensions.
 * - No trailers.
 * - Payload is ASCII (1 char = 1 byte).
 */

function decodeSingleChunkV01(chunks: string): { payload: string; rest: string; payloadSize: number } {
  const hexCursor = chunks.indexOf("\r\n");
  if (hexCursor === -1) throw new Error("Malformed chunked input: missing CRLF after size");

  const payloadSizeHex = chunks.slice(0, hexCursor);
  const payloadSize = Number.parseInt(payloadSizeHex.trim() || "0", 16);
  if (!Number.isFinite(payloadSize) || payloadSize < 0) {
    throw new Error(`Malformed chunk size: "${payloadSizeHex}"`);
  }

  let rest = chunks.slice(hexCursor + 2); // past size CRLF

  if (payloadSize === 0) {
    if (!rest.startsWith("\r\n")) throw new Error("Malformed chunked input: missing final CRLF");
    rest = rest.slice(2); // consume terminal CRLF
    return { payload: "", rest, payloadSize };
  }

  if (payloadSize > rest.length) throw new Error("Malformed chunked input: payload truncated");

  const payload = rest.slice(0, payloadSize);
  rest = rest.slice(payloadSize);

  if (!rest.startsWith("\r\n")) throw new Error("Malformed chunked input: missing CRLF after payload");
  rest = rest.slice(2);

  return { payload, rest, payloadSize };
}

export function decodeChunkedPartsV01(encoded: string): string[] {
  const parts: string[] = [];
  let toProcess = encoded;

  while (true) {
    const { payload, rest, payloadSize } = decodeSingleChunkV01(toProcess);
    if (payloadSize === 0) {
      if (rest.length !== 0) throw new Error("Malformed chunked input: trailing bytes after terminal chunk");
      return parts;
    }

    parts.push(payload);
    toProcess = rest;
  }
}

export function decodeChunkedStringV01(encoded: string): string {
  return decodeChunkedPartsV01(encoded).join("");
}

if (import.meta.main) {
  const encoded =
    "7\r\nNewtonX\r\n" +
    "B\r\n is hiring \r\n" +
    "8\r\nawesome \r\n" +
    "9\r\nengineers\r\n" +
    "0\r\n\r\n";

  console.log(decodeChunkedStringV01(encoded)); // "NewtonX is hiring awesome engineers"
}
