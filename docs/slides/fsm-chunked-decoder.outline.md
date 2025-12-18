# FSM Chunked Decoder Slideshow Outline

## Narrative Arc
**Abstract → Tension → Architecture → Implementation → Resolution**

Concept-first didactic opening builds FSM intuition, problem statement creates tension, solution overview provides the map, code tour delivers the details, evaluation resolves against success criteria.

---

## Concepts Registry

| ID | Label | Color | Purpose |
|----|-------|-------|---------|
| `fsm-theory` | FSM Theory | blue | Abstract state machine concepts |
| `problem` | The Problem | orange | Constraints and challenges |
| `architecture` | Architecture | purple | Solution design overview |
| `implementation` | Implementation | green | Code-level details |
| `evaluation` | Evaluation | rose | Assessment against criteria |

---

## Slide Sequence

### Slide 1: "What is a Finite State Machine?"
**Concept:** `fsm-theory`
**Purpose:** Establish the abstract pattern before any domain context

**Blocks:**
1. `explanation` — Definition: discrete states, deterministic transitions, input-driven
2. `diagram` — Simple 3-state FSM (e.g., traffic light or turnstile) as intuition builder
3. `explanation` — Key insight: "Remember where you are, not everything you've seen"

---

### Slide 2: "Anatomy of an FSM"
**Concept:** `fsm-theory`
**Purpose:** Formalize the components

**Blocks:**
1. `layers` (stack layout) — Three layers: States, Transitions, State Variables
2. `explanation` — States = "what mode am I in?", Transitions = "what input moves me?", Variables = "what minimal context do I carry?"

---

### Slide 3: "Why FSMs for Streaming Parsers?"
**Concept:** `fsm-theory`
**Purpose:** Bridge abstract to applied — why this pattern fits streaming

**Blocks:**
1. `explanation` — The streaming constraint: data arrives in arbitrary fragments, can't wait for "complete" input
2. `table` — Comparison: Buffering vs FSM approach (memory, latency, complexity)
3. `explanation` — FSM superpower: process each byte exactly once, carry only essential state

---

### Slide 4: "The Chaos Monkey Challenge"
**Concept:** `problem`
**Purpose:** Create tension — the problem is harder than it looks

**Blocks:**
1. `explanation` — HTTP Chunked Encoding: `<hex>\r\n<payload>\r\n...0\r\n\r\n`
2. `diagram` — Visual of the protocol format (linear flow)
3. `explanation` — The twist: network can split ANYWHERE. Mid-hex. Mid-CRLF. Mid-payload.

---

### Slide 5: "Why Naive Solutions Fail"
**Concept:** `problem`
**Purpose:** Eliminate the obvious approach, justify FSM necessity

**Blocks:**
1. `codeBlock` — The trap: `this.buffer += chunk` (naive accumulation)
2. `explanation` — At millions of connections, this explodes memory. Also: when do you parse? You don't know when you have "enough."
3. `explanation` — The requirement: **greedy processing** — extract and discard immediately

---

### Slide 6: "ChunkedDecoder: The Four States"
**Concept:** `architecture`
**Purpose:** Reveal the solution's structure — the FSM design

**Blocks:**
1. `explanation` — Four states map to four protocol phases
2. `layers` (stack layout) — SIZE → PAYLOAD → EXPECT_CRLF → DONE with descriptions
3. `explanation` — Note: EXPECT_CRLF is reusable — parameterized by "where to go next"

---

### Slide 7: "State Transitions: The Full Picture"
**Concept:** `architecture`
**Purpose:** Visual mental model of the entire machine

**Blocks:**
1. `diagram` — Complete Mermaid state diagram showing all transitions
2. `explanation` — Key insight: the loop (SIZE → PAYLOAD → CRLF → SIZE) repeats until size=0

---

### Slide 8: "The State Variables"
**Concept:** `architecture`
**Purpose:** Show how little memory is actually needed

**Blocks:**
1. `table` — Variable | Type | Purpose | Size for each: state, sizeHex, sawCR, remaining, expectIndex, afterExpect
2. `explanation` — Total footprint: ~20 bytes + small string. Handles gigabytes of throughput.

---

### Slide 9: "Code Tour: The Main Loop"
**Concept:** `implementation`
**Purpose:** Establish the processing structure before diving into states

**Blocks:**
1. `codeBlock` — `decodeChunk` outer structure: early return if DONE, while loop over chars
2. `explanation` — Pattern: cursor `i` advances through chunk, state machine dispatches per-character
3. `explanation` — Note: no buffering of raw input — we process in-place

---

### Slide 10: "SIZE State: Parsing the Hex Header"
**Concept:** `implementation`
**Purpose:** Deep dive into the first state

**Blocks:**
1. `explanation` — Goal: accumulate hex digits until CRLF, then parse to integer
2. `codeBlock` — SIZE state handler (lines 36-67)
3. `explanation` — Key details: `sawCR` handles split CRLF, `sizeHex` cleared after parse, transitions to PAYLOAD or EXPECT_CRLF(DONE)

---

### Slide 11: "PAYLOAD State: Greedy Bulk Processing"
**Concept:** `implementation`
**Purpose:** Show the efficiency optimization

**Blocks:**
1. `explanation` — Unlike SIZE (char-by-char), PAYLOAD uses bulk `slice()` for speed
2. `codeBlock` — PAYLOAD state handler (lines 69-85)
3. `explanation` — Pattern: take min(remaining, available), emit via callback, decrement counter. Zero buffering.

---

### Slide 12: "EXPECT_CRLF: The Reusable Sub-State"
**Concept:** `implementation`
**Purpose:** Highlight elegant design pattern

**Blocks:**
1. `explanation` — CRLF appears twice in protocol: after payload, after zero-chunk. Same logic, different next state.
2. `codeBlock` — EXPECT_CRLF handler + `startExpectCRLF` helper (lines 87-100, 116-120)
3. `explanation` — `afterExpect` parameterizes the destination. One implementation, two use cases.

---

### Slide 13: "BlockCollector: Taming String Concatenation"
**Concept:** `implementation`
**Purpose:** Address the output accumulation concern (separate from parsing)

**Blocks:**
1. `explanation` — Problem: if fragments are tiny, `result += fragment` is O(n²)
2. `diagram` — Two-tier structure: pending[] → blocks[] → final join
3. `explanation` — Each character copied at most twice. Handles pathological fragmentation gracefully.

---

### Slide 14: "Evaluation: Does It Meet the Criteria?"
**Concept:** `evaluation`
**Purpose:** Resolve against the original success criteria

**Blocks:**
1. `table` — Criterion | Requirement | How ChunkedDecoder Satisfies (Correctness, Efficiency, Elegance)
2. `explanation` — Verdict: FSM architecture delivers on all three axes. Minimal state, greedy processing, clean separation of concerns.

---

### Slide 15: "The FSM Pattern: Takeaways"
**Concept:** `fsm-theory`
**Purpose:** Return to the abstract, reinforce the lesson

**Blocks:**
1. `layers` (pyramid) — Bottom: "Know your states", Middle: "Minimize carried context", Top: "Process greedily"
2. `explanation` — FSMs turn chaotic streaming input into predictable, memory-efficient processing. The pattern applies far beyond HTTP parsing.

---

## Block Type Usage Summary

| Block Type | Count | Slides |
|------------|-------|--------|
| explanation | 22 | 1-15 |
| diagram | 4 | 1, 4, 7, 13 |
| codeBlock | 5 | 5, 9, 10, 11, 12 |
| layers | 3 | 2, 6, 15 |
| table | 3 | 3, 8, 14 |

**Angle compliance:** Technical — primary blocks are codeBlock, diagram, explanation, layers. Tables used sparingly for structured comparisons.
