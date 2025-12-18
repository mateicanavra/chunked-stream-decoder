from __future__ import annotations

from collections.abc import Callable

OnData = Callable[[str], None]

_STATE_SIZE = 0
_STATE_PAYLOAD = 1
_STATE_EXPECT_CRLF = 2
_STATE_DONE = 3

_NEXT_SIZE = 0
_NEXT_DONE = 1


def _hex_value(c: str) -> int:
    o = ord(c)
    if 48 <= o <= 57:  # 0-9
        return o - 48
    if 65 <= o <= 70:  # A-F
        return o - 55
    if 97 <= o <= 102:  # a-f
        return o - 87
    return -1


class ChunkedDecoder:
    """
    Streaming chunked decoder for the simplified “problem set” format:

      <hex-size>\\r\\n<payload>\\r\\n ... 0\\r\\n\\r\\n

    Assumptions:
    - Input arrives as Python strings.
    - “Size” counts Python characters (ASCII payload). This is NOT byte-accurate for UTF-8/binary.
    - No chunk extensions (e.g. ";ext=...") and no trailers.
    - Stream is valid; fragmentation is arbitrary.
    """

    __slots__ = (
        "_on_data",
        "_state",
        "_saw_size_cr",
        "_size_acc",
        "_size_any",
        "_remaining",
        "_expect_index",
        "_after_expect",
    )

    def __init__(self, on_data: OnData) -> None:
        self._on_data = on_data

        self._state = _STATE_SIZE

        # SIZE line parsing: greedy incremental base-16 accumulator.
        self._saw_size_cr = False
        self._size_acc = 0
        self._size_any = False

        # PAYLOAD parsing
        self._remaining = 0

        # CRLF expectation parsing (after payload or terminal "0\r\n")
        self._expect_index = 0  # 0 => expect '\r', 1 => expect '\n'
        self._after_expect = _NEXT_SIZE

    def decode_chunk(self, chunk: str) -> None:
        if self._state == _STATE_DONE:
            return

        i = 0
        n = len(chunk)

        while i < n:
            state = self._state

            if state == _STATE_SIZE:
                if self._saw_size_cr:
                    c = chunk[i]
                    i += 1
                    # Valid stream assumption; keep a cheap check anyway.
                    if c != "\n":
                        raise ValueError("Invalid chunked encoding: expected LF after CR in size line.")

                    self._saw_size_cr = False

                    size = self._size_acc if self._size_any else 0
                    self._size_acc = 0
                    self._size_any = False

                    self._remaining = size
                    if size == 0:
                        self._start_expect_crlf(_NEXT_DONE)
                    else:
                        self._state = _STATE_PAYLOAD
                    continue

                cr = chunk.find("\r", i)
                end = n if cr == -1 else cr

                acc = self._size_acc
                any_digit = self._size_any

                for c in chunk[i:end]:
                    v = _hex_value(c)
                    if v < 0:
                        raise ValueError("Invalid chunk size line (expected hex digits).")
                    acc = (acc << 4) | v
                    any_digit = True

                self._size_acc = acc
                self._size_any = any_digit

                i = end
                if cr != -1:
                    i += 1
                    self._saw_size_cr = True
                continue

            if state == _STATE_PAYLOAD:
                remaining = self._remaining
                available = n - i

                if remaining <= available:
                    if remaining:
                        self._on_data(chunk[i : i + remaining])
                        i += remaining
                    self._remaining = 0
                    self._start_expect_crlf(_NEXT_SIZE)
                else:
                    # Consume the entire fragment, leave the decoder in PAYLOAD state.
                    self._on_data(chunk[i:])
                    self._remaining = remaining - available
                    return
                continue

            if state == _STATE_EXPECT_CRLF:
                # Fast path when both delimiter characters are available in this fragment.
                if self._expect_index == 0 and i + 2 <= n and chunk[i : i + 2] == "\r\n":
                    i += 2
                    self._finish_expect_crlf()
                    if self._state == _STATE_DONE:
                        return
                    continue

                expected = "\r" if self._expect_index == 0 else "\n"
                c = chunk[i]
                i += 1
                if c != expected:
                    raise ValueError("Invalid chunked encoding: expected CRLF.")

                self._expect_index += 1
                if self._expect_index == 2:
                    self._finish_expect_crlf()
                    if self._state == _STATE_DONE:
                        return
                continue

            # DONE
            return

    def is_done(self) -> bool:
        return self._state == _STATE_DONE

    def finalize(self) -> None:
        """Raises unless we have consumed a full terminal 0-sized chunk (0\\r\\n\\r\\n)."""
        if not self.is_done():
            raise RuntimeError("Chunked stream not finished.")

    def _start_expect_crlf(self, next_state: int) -> None:
        self._state = _STATE_EXPECT_CRLF
        self._expect_index = 0
        self._after_expect = next_state

    def _finish_expect_crlf(self) -> None:
        self._expect_index = 0
        self._state = _STATE_DONE if self._after_expect == _NEXT_DONE else _STATE_SIZE


class _BlockCollector:
    __slots__ = ("_blocks", "_pending", "_pending_chars", "_max_pending_chars", "_max_pending_parts")

    def __init__(self, max_pending_chars: int = 64 * 1024, max_pending_parts: int = 2048) -> None:
        self._blocks: list[str] = []
        self._pending: list[str] = []
        self._pending_chars = 0
        self._max_pending_chars = max_pending_chars
        self._max_pending_parts = max_pending_parts

    def push(self, fragment: str) -> None:
        if not fragment:
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
            if not self._pending:
                return ""
            if len(self._pending) == 1:
                return self._pending[0]
            return "".join(self._pending)

        self.flush()
        if len(self._blocks) == 1:
            return self._blocks[0]
        return "".join(self._blocks)


class Decoder:
    """
    Collecting streaming decoder matching the canonical interface:

    - `decode_chunk(chunk: str) -> None`
    - `result` property returns accumulated payload so far
    """

    __slots__ = ("_collector", "_decoder")

    def __init__(self) -> None:
        self._collector = _BlockCollector()
        self._decoder = ChunkedDecoder(self._collector.push)

    def decode_chunk(self, chunk: str) -> None:
        self._decoder.decode_chunk(chunk)

    @property
    def result(self) -> str:
        # Allow partial results, even before the terminal 0-sized chunk is seen.
        return self._collector.to_string()

    def finalize(self) -> None:
        self._decoder.finalize()


CollectingDecoder = Decoder
ChunkedCollectingDecoder = Decoder
