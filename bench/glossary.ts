export function printBenchGlossary(kind: "basic" | "compare"): void {
  const lines: string[] = [];

  lines.push("=== Bench glossary / setup notes ===");
  lines.push("");
  lines.push("Consumer modes:");
  lines.push("- consumer=sha256: hashes decoded payload; simulates real work and prevents dead-code elimination.");
  lines.push("- consumer=count: counts decoded chars; closer to parser/callback overhead.");
  lines.push("");
  lines.push("Fragmentation strategies (how the encoded input is split into streaming chunks):");
  lines.push("- single fragment (full buffer): everything in one chunk (best case).");
  lines.push("- fixed 64B fragments: constant-size splits; models small-ish reads.");
  lines.push("- random <= 64B fragments: variable splits; models jittery reads.");
  lines.push("- random <= 7B fragments: very fragmented; stresses per-fragment overhead.");
  lines.push("- worst-case 1B fragments: extremely fragmented; reveals pathological behavior.");
  lines.push("- adversarial CR/LF splits: splits after every \\r or \\n; stresses CRLF boundary handling.");

  if (kind === "compare") {
    lines.push("");
    lines.push("Compare bench specifics:");
    lines.push("- Batch decoders (decoder-01*) are benchmarked on full-buffer input only (in-kind).");
    lines.push("- Streaming decoder is benchmarked across fragmentations.");
    lines.push("- reassembly | fragments.join(): measures the cost to join fragments back into a full buffer (reported separately).");
    lines.push("");
    lines.push("Flags:");
    lines.push("- SKIP_WORST_CASES=1 or --skip-worst: skip the most extreme fragmentations.");
    lines.push("- HORIZONTAL=1 or --horizontal: print one row per bench/consumer with decoders side-by-side.");
    lines.push("- --scenario <file> / --only-scenarios: add JSON fixtures as inputs (e.g. chunked_sample_50.json).");
    lines.push("- --emit / --emit-limit N / --emit-all: print expected decoded output.");
    lines.push("- --emit-escaped: render \\r/\\n visibly to avoid terminal overwrite artifacts.");
  }

  lines.push("");

  console.log(lines.join("\n"));
}
