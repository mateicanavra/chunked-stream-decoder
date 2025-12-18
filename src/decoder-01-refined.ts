/**
 * ASSUMPTIONS:
 * - Input is a valid CRLF chunked encoded string.
 * - No chunk extensions.
 * - No trailers.
 * - Payload is ASCII (1 char = 1 byte).
 */

export function decodeChunkedPartsRefined(input: string): string[] {
  const parts: string[] = [];
  let i = 0; // <-- the "cursor" into the input string that I missed before

  while (true) {
    // 1) Find the first index of "\r\n" to isolate hex payloadSize line
    const rn = input.indexOf("\r\n", i);
    if (rn === -1) throw new Error("Malformed chunked input: missing CRLF after payloadSize"); // We assume the data is standard compliant.

	// 2) Parse payloadSize hex & convert to number
    const hex = input.slice(i, rn).trim();
    const payloadSize = Number.parseInt(hex, 16);
    if (!Number.isFinite(payloadSize) || payloadSize < 0) throw new Error(`Malformed chunk payloadSize: "${hex}"`);

    i = rn + 2; // Got what we needed, move cursor past CRLF delimiter; ready for payload

    // If payload is explicitly "0" ("0\r\n\r\n"), we are done and should exit.
    if (payloadSize === 0) {
      if (input.slice(i, i + 2) !== "\r\n") {
        throw new Error("Malformed chunked input: missing final CRLF");
      }
      return parts;
    }

	// If remaining chunk is smaller than expected payload, something is wrong.
    if (i + payloadSize > input.length) throw new Error("Malformed chunked input: payload truncated");
	
    // 3) Read payload of exactly `payloadSize` length (no need to )
    parts.push(input.slice(i, i + payloadSize));
    i += payloadSize;

    if (input.slice(i, i + 2) !== "\r\n") {
      throw new Error("Malformed chunked input: missing CRLF after payload");
    }
    i += 2; // move past payload CRLF
  }
}

export function decodeChunkedStringRefined(input: string): string {
  return decodeChunkedPartsRefined(input).join("");
}

if (import.meta.main) {
  const encoded = "7\r\nNewtonX\r\nB\r\n is hiring \r\n8\r\nawesome \r\n9\r\nengineers\r\n0\r\n\r\n";
  console.log(decodeChunkedStringRefined(encoded)); // "NewtonX is hiring awesome engineers"
}
