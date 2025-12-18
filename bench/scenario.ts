import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type ChunkedScenarioChunk = {
  sizeHex: string;
  payloadFragment: string;
};

export type ChunkedScenarioJson = {
  name?: string;
  payload: string;
  chunks: ChunkedScenarioChunk[];
  encoded: string;
  fragments?: string[];
  payloadSha256Hex?: string;
};

export type LoadedScenario = {
  name: string;
  payload: string;
  encoded: string;
  fragmentsFromFile: string[] | null;
  payloadSha256Hex: string;
};

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildEncodedFromChunks(chunks: ChunkedScenarioChunk[]): string {
  let out = "";
  for (const c of chunks) {
    out += `${c.sizeHex}\r\n${c.payloadFragment}\r\n`;
  }
  out += "0\r\n\r\n";
  return out;
}

export function loadScenarioJson(path: string): ChunkedScenarioJson {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as ChunkedScenarioJson;
  return parsed;
}

export function validateAndNormalizeScenario(path: string, s: ChunkedScenarioJson): LoadedScenario {
  if (typeof s.payload !== "string") throw new Error(`Scenario ${path}: missing/invalid "payload"`);
  if (!Array.isArray(s.chunks)) throw new Error(`Scenario ${path}: missing/invalid "chunks"`);
  if (typeof s.encoded !== "string") throw new Error(`Scenario ${path}: missing/invalid "encoded"`);

  const name = s.name?.trim() || basename(path);

  let reconstructedPayload = "";
  for (let idx = 0; idx < s.chunks.length; idx++) {
    const c = s.chunks[idx];
    if (!c || typeof c.sizeHex !== "string" || typeof c.payloadFragment !== "string") {
      throw new Error(`Scenario ${path}: invalid chunks[${idx}]`);
    }
    const expectedLen = Number.parseInt(c.sizeHex.trim() || "0", 16);
    if (!Number.isFinite(expectedLen) || expectedLen < 0) {
      throw new Error(`Scenario ${path}: invalid chunks[${idx}].sizeHex="${c.sizeHex}"`);
    }
    if (c.payloadFragment.length !== expectedLen) {
      throw new Error(
        `Scenario ${path}: chunks[${idx}] length mismatch (sizeHex=${c.sizeHex} => ${expectedLen}, got=${c.payloadFragment.length})`
      );
    }
    reconstructedPayload += c.payloadFragment;
  }

  if (reconstructedPayload !== s.payload) {
    throw new Error(`Scenario ${path}: payload != chunks.join("") (got ${reconstructedPayload.length} chars)`);
  }

  const reconstructedEncoded = buildEncodedFromChunks(s.chunks);
  if (reconstructedEncoded !== s.encoded) {
    throw new Error(`Scenario ${path}: encoded != reconstructed (got ${reconstructedEncoded.length} chars)`);
  }

  const fragmentsFromFile = Array.isArray(s.fragments) ? s.fragments.map(String) : null;
  if (fragmentsFromFile) {
    const joined = fragmentsFromFile.join("");
    if (joined !== s.encoded) {
      throw new Error(
        `Scenario ${path}: fragments.join("") != encoded (got ${joined.length} chars, expected ${s.encoded.length})`
      );
    }
  }

  const payloadSha256Hex = s.payloadSha256Hex ?? sha256Hex(s.payload);
  if (typeof payloadSha256Hex !== "string" || payloadSha256Hex.length === 0) {
    throw new Error(`Scenario ${path}: missing/invalid payloadSha256Hex`);
  }
  const computedHash = sha256Hex(s.payload);
  if (computedHash !== payloadSha256Hex) {
    throw new Error(`Scenario ${path}: payloadSha256Hex mismatch (${payloadSha256Hex} != ${computedHash})`);
  }

  return {
    name,
    payload: s.payload,
    encoded: s.encoded,
    fragmentsFromFile,
    payloadSha256Hex,
  };
}

