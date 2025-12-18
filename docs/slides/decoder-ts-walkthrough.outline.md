# Deck: `decoder.ts` — Streaming Chunked Decoder (String-based)

Topic: Explain how `src/decoder.ts` works (step-by-step / component-by-component: roles, function, I/O, invariants).

Schema reference: `/Users/mateicanavra/.claude/skills/slides-creator/SKILL.md`

Narrative structure: **Alt A (state machine walkthrough)** as the spine, with a mid-deck **Alt C vignette** (adversarial fragmentation story), plus one **Alt B-style vertical slide** (API contract & invariants).

## Concepts (for slide grouping)
- `format`: The simplified chunked wire framing
- `core`: The `ChunkedDecoder` state machine
- `states`: State-by-state behavior
- `fragmentation`: Why fragmentation is hard + how this design handles it
- `collect`: `CollectingDecoder` + `BlockCollector` memory strategy
- `contract`: External API + invariants + error modes
- `appendix`: Optional validation via tests

## Slides

### Slide 1 — The Frame We’re Decoding (and what “size” means here)
Purpose: Set the exact protocol and the repo’s simplifying assumptions so later details don’t feel like gotchas.
Concept: `format`
Blocks:
- `explanation`: Show framing: `<hex-size>\r\n<payload>\r\n ... 0\r\n\r\n`; emphasize **string/ASCII char-count** assumption; no extensions/trailers.
- `codeBlock`: `src/decoder.ts` lines 3–12 (header comment), highlight 8–11.

### Slide 2 — The Cast: Streaming vs Collecting
Purpose: Establish the two “user-facing” entrypoints and why the callback exists.
Concept: `core`
Blocks:
- `layers` (stack): Layers for “Input fragments → ChunkedDecoder (state machine) → onData callback → your sink” and an optional parallel layer “CollectingDecoder → BlockCollector → result string”.
- `codeBlock`: `src/decoder.ts` lines 1–1 (OnData), and 181–199 (CollectingDecoder) with highlight 181–187 and 193–198.

### Slide 3 — The State Machine in One Picture
Purpose: Provide a mental model for everything that follows.
Concept: `core`
Blocks:
- `diagram` (mermaid): State transitions `SIZE -> PAYLOAD -> EXPECT_CRLF -> SIZE` and `SIZE (n=0) -> EXPECT_CRLF -> DONE`.
- `codeBlock`: `src/decoder.ts` lines 13–26 (state + state variables), highlight 14, 17–18, 21, 24–25.

### Slide 4 — `decodeChunk()` Control Flow: “Cursor i” + Persistent State
Purpose: Explain why this works with arbitrary fragmentation: local cursor inside the current fragment + class fields across calls.
Concept: `core`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 29–34 (early return + cursor + loop), highlight 30–33.
- `explanation`: Notes: `i` resets per call; `state/*fields` persist; loop consumes exactly what it can.

### Slide 5 — SIZE: Reading the Hex Line (without buffering the world)
Purpose: Walk through size-line parsing and the `sawCR` trick for CRLF that might be split across fragments.
Concept: `states`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 34–65, highlight 37–55 and 57–64.
- `explanation`: Notes:
  - accumulate `sizeHex` until CR
  - `sawCR` means “we’ve already seen CR; next char must be LF”
  - parse `n`, reset `sizeHex`, set `remaining`
  - `n===0` triggers terminal `EXPECT_CRLF("DONE")`, else go to `PAYLOAD`

### Slide 6 — PAYLOAD: Emit Slices, Don’t Copy
Purpose: Show the “greedy consume” behavior and the I/O contract of `onData(fragment)`.
Concept: `states`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 67–83, highlight 68–76 and 78–81.
- `explanation`: Notes:
  - `take = min(remaining, available)` allows partial payload in this fragment
  - emits immediately (`onData(slice)`) and updates `remaining`
  - when payload completes, expects a protocol CRLF next (transition to `EXPECT_CRLF("SIZE")`)

### Slide 7 — EXPECT_CRLF: Turning “Delimiter Parsing” into Its Own State
Purpose: Explain why CRLF validation is centralized and how it supports split delimiters.
Concept: `states`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 85–98, highlight 86–96.
- `codeBlock`: `src/decoder.ts` lines 114–118, highlight 114–118.
- `explanation`: Notes:
  - `expectIndex` tracks whether we’re expecting `\r` or `\n`
  - `afterExpect` decides the next state (`SIZE` vs `DONE`)

### Slide 8 — Vignette: Worst-Case Fragmentation (CRLF split, payload contains CR/LF)
Purpose: Tell the “adversarial fragmentation” story (Alt C) to make the design feel inevitable.
Concept: `fragmentation`
Blocks:
- `diagram` (mermaid sequence): A short trace showing fragments like `"7\r"`, `"\nNewtonX\r"`, `"\n"` and the corresponding internal state transitions.
- `table`: Rows mapping “incoming fragment” → “consumed chars” → “state after” → “side effect”.
- `explanation`: Emphasize: payload may contain CR/LF; only protocol CRLF is consumed by `EXPECT_CRLF`.

### Slide 9 — DONE + `finalize()`: What “Complete” Actually Means
Purpose: Explain terminal behavior and how callers learn they’ve fed enough data.
Concept: `states`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 48–52 (the `n===0` branch), highlight 48–51.
- `codeBlock`: `src/decoder.ts` lines 105–112 (isDone/finalize), highlight 105–112.
- `explanation`: Notes: must consume `0\r\n\r\n`; `finalize()` is an assertion, not a “flush”.

### Slide 10 — `BlockCollector`: Avoid Death by a Thousand Tiny Strings
Purpose: Explain the memory/perf rationale of batching tiny fragments before joining.
Concept: `collect`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 121–173, highlight 132–151 and 160–173.
- `explanation`: Notes:
  - `pending` accumulates fragments; flush joins occasionally
  - `toString()` flushes once then final-joins blocks (bounded copying)

### Slide 11 — `CollectingDecoder`: Convenience Layer over Streaming
Purpose: Show the thin wrapper and the “result is only valid when done” guard.
Concept: `collect`
Blocks:
- `codeBlock`: `src/decoder.ts` lines 181–199, highlight 182–187 and 193–198.
- `explanation`: Notes: still uses streaming internally; `result` throws until terminal chunk read.

### Slide 12 — API Contract & Invariants (Vertical Summary)
Purpose: A single “B-style” slide you can revisit when using/extending the code.
Concept: `contract`
Blocks:
- `layers` (stack): 4 layers:
  1) Inputs (`decodeChunk(string)` fragments, arbitrary boundaries)
  2) Outputs (`onData(payloadFragment)` streaming; or `result` after `finalize()`)
  3) Invariants (`remaining` counts payload chars left; `EXPECT_CRLF` always consumes protocol CRLF; `DONE` is terminal)
  4) Error modes (bad size-line CRLF, bad CRLF after payload, invalid hex/negative size, `finalize()` before done)

### Slide 13 (Appendix) — Tests that Exercise the Guarantees
Purpose: Ground the above claims in what’s actually tested in this repo.
Concept: `appendix`
Blocks:
- `codeBlock`: `tests/decoder.test.ts` lines 21–91, highlight 35–44 and 46–78 and 80–91.
- `explanation`: Notes: adversarial CR/LF fragmentation; randomized chaos across strategies; malformed cases.

