from __future__ import annotations

import re
from collections.abc import Callable
from typing import Literal

OnData = Callable[[str], None]


_HEX_PREFIX_RE = re.compile(r"^[0-9a-fA-F]+")


def _parse_int_like_js_parse_int_base16(s: str) -> int:
    """
    Parse a chunk-size line similarly to `Number.parseInt(str, 16)` in JS:
    - Trims whitespace.
    - Accepts optional +/- sign.
    - Accepts optional 0x/0X prefix.
    - Parses a leading run of hex digits and ignores the rest.

    Raises ValueError if no valid digits are found.
    """
    s = s.strip()
    if s == "":
        return 0

    sign = 1
    if s[0] in "+-":
        if s[0] == "-":
            sign = -1
        s = s[1:]

    if s.startswith(("0x", "0X")):
        s = s[2:]

    m = _HEX_PREFIX_RE.match(s)
    if not m:
        raise ValueError(f"Invalid chunk size: {s!r}")

    return sign * int(m.group(0), 16)


class ChunkedDecoder:
    """
    Streaming chunked decoder for the simplified “problem set” format:

      <hex-size>\\r\\n<payload>\\r\\n ... 0\\r\\n\\r\\n

    Assumptions (matches the prompt examples):
    - Input arrives as Python strings.
    - “Size” counts Python characters (ASCII payload). This is NOT byte-accurate for UTF-8/binary.
    - No chunk extensions (e.g. ";ext=...") and no trailers.
    """

    def __init__(self, on_data: OnData) -> None:
        self._on_data = on_data

        self._state: Literal["SIZE", "PAYLOAD", "EXPECT_CRLF", "DONE"] = "SIZE"

        # SIZE parsing (tiny state)
        self._size_hex = ""
        self._saw_cr = False

        # PAYLOAD parsing
        self._remaining = 0

        # CRLF expectation parsing
        self._expect_index = 0  # 0 => expect '\r', 1 => expect '\n'
        self._after_expect: Literal["SIZE", "DONE"] = "SIZE"

    def decode_chunk(self, chunk: str) -> None:
        if self._state == "DONE":
            return

        i = 0
        while i < len(chunk):
            if self._state == "SIZE":
                c = chunk[i]
                i += 1

                # We previously consumed a '\r' for the size line,
                # so the next char MUST be '\n'.
                if self._saw_cr:
                    if c != "\n":
                        raise ValueError("Invalid chunked encoding: expected LF after CR in size line.")
                    self._saw_cr = False

                    try:
                        n = _parse_int_like_js_parse_int_base16(self._size_hex or "0")
                    except ValueError:
                        raise ValueError(f'Invalid chunk size: "{self._size_hex}"') from None

                    if n < 0:
                        raise ValueError(f'Invalid chunk size: "{self._size_hex}"')

                    self._size_hex = ""
                    self._remaining = n

                    if n == 0:
                        # Simplified termination: after "0\r\n" we expect the final "\r\n".
                        self._start_expect_crlf("DONE")
                    else:
                        self._state = "PAYLOAD"
                    continue

                if c == "\r":
                    self._saw_cr = True
                    continue

                # Assumption: valid stream, no extensions. Collect the size line verbatim until CR.
                self._size_hex += c
                continue

            if self._state == "PAYLOAD":
                available = len(chunk) - i
                take = min(self._remaining, available)

                if take > 0:
                    self._on_data(chunk[i : i + take])
                    i += take
                    self._remaining -= take

                if self._remaining == 0:
                    # After payload there must be a CRLF terminator.
                    self._start_expect_crlf("SIZE")
                continue

            if self._state == "EXPECT_CRLF":
                expected = "\r" if self._expect_index == 0 else "\n"
                c = chunk[i]
                i += 1

                if c != expected:
                    raise ValueError("Invalid chunked encoding: expected CRLF.")

                self._expect_index += 1
                if self._expect_index == 2:
                    self._expect_index = 0
                    self._state = "DONE" if self._after_expect == "DONE" else "SIZE"
                    if self._state == "DONE":
                        return
                continue

            # DONE
            return

    def is_done(self) -> bool:
        return self._state == "DONE"

    def finalize(self) -> None:
        """Throws unless we have consumed a full terminal 0-sized chunk (0\\r\\n\\r\\n)."""
        if not self.is_done():
            raise RuntimeError("Chunked stream not finished.")

    def _start_expect_crlf(self, next_state: Literal["SIZE", "DONE"]) -> None:
        self._state = "EXPECT_CRLF"
        self._expect_index = 0
        self._after_expect = next_state


class _BlockCollector:
    """
    A collector that avoids pathological memory churn when the stream is split into
    extremely tiny fragments. It groups many small fragments into medium-sized blocks.
    """

    def __init__(self, max_pending_chars: int = 64 * 1024, max_pending_parts: int = 2048) -> None:
        self._blocks: list[str] = []
        self._pending: list[str] = []
        self._pending_chars = 0
        self._max_pending_chars = max_pending_chars
        self._max_pending_parts = max_pending_parts

    def push(self, fragment: str) -> None:
        if fragment == "":
            return

        self._pending.append(fragment)
        self._pending_chars += len(fragment)

        if self._pending_chars >= self._max_pending_chars or len(self._pending) >= self._max_pending_parts:
            self.flush()

    def flush(self) -> None:
        if not self._pending:
            return
        self._blocks.append("".join(self._pending))
        self._pending = []
        self._pending_chars = 0

    def to_string(self) -> str:
        if not self._blocks:
            # Avoid one extra join in the common case.
            if not self._pending:
                return ""
            if len(self._pending) == 1:
                return self._pending[0]
            return "".join(self._pending)

        # Flush pending into blocks once, then do a single final join.
        self.flush()

        if len(self._blocks) == 1:
            return self._blocks[0]
        return "".join(self._blocks)


class CollectingDecoder:
    """
    Convenience wrapper matching the “decoder with a result” style.

    Use ChunkedDecoder directly if you want true streaming output.
    """

    def __init__(self) -> None:
        self._collector = _BlockCollector()
        self._decoder = ChunkedDecoder(self._collector.push)

    def decode_chunk(self, chunk: str) -> None:
        self._decoder.decode_chunk(chunk)

    def finalize(self) -> None:
        self._decoder.finalize()

    @property
    def result(self) -> str:
        # Allow partial results (matches the TS version's current behavior).
        return self._collector.to_string()

