import { Rng } from "./rng";

export function splitFixed(s: string, fragmentSize: number): string[] {
  if (fragmentSize <= 0) throw new Error("fragmentSize must be > 0");
  const out: string[] = [];
  for (let i = 0; i < s.length; i += fragmentSize) out.push(s.slice(i, i + fragmentSize));
  return out;
}

export function splitRandom(s: string, maxFragmentSize: number, seed = 123): string[] {
  if (maxFragmentSize <= 0) throw new Error("maxFragmentSize must be > 0");
  const rng = new Rng(seed);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const len = rng.int(1, maxFragmentSize);
    out.push(s.slice(i, i + len));
    i += len;
  }
  return out;
}

/**
 * Intentionally adversarial fragmentation:
 * - Split after every '\r' and every '\n' character.
 * This forces CRLF pairs to often span two fragments.
 */
export function splitAfterEveryCRLFChar(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\r" || c === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.filter((x) => x.length > 0);
}

/** Convenience: choose a fragmentation strategy by name. */
export type Fragmentation =
  | { type: "single" }
  | { type: "fixed"; size: number }
  | { type: "random"; max: number; seed?: number }
  | { type: "adversarial-crlf" };

export function fragment(s: string, f: Fragmentation): string[] {
  switch (f.type) {
    case "single":
      return [s];
    case "fixed":
      return splitFixed(s, f.size);
    case "random":
      return splitRandom(s, f.max, f.seed ?? 123);
    case "adversarial-crlf":
      return splitAfterEveryCRLFChar(s);
  }
}
