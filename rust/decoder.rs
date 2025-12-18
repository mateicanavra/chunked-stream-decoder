//! Rust implementation of the simplified streaming chunked decoder used in this repo.
//!
//! Framing:
//!   `<hex-size>\r\n<payload>\r\n ... 0\r\n\r\n`
//!
//! Matches the TypeScript version (`src/decoder.ts`):
//! - Input is provided as text fragments (`&str`), assumed to be ASCII.
//! - Chunk size counts characters (ASCII => 1 char == 1 byte).
//! - No chunk extensions and no trailers.

use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    NonAsciiInput,
    ExpectedLfAfterCrInSizeLine,
    EmptyChunkSize,
    InvalidChunkSize,
    ChunkSizeOverflow,
    ExpectedCrlf,
    NotFinished,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::NonAsciiInput => write!(
                f,
                "Non-ASCII input is not supported (this repo assumes ASCII payload)."
            ),
            DecodeError::ExpectedLfAfterCrInSizeLine => write!(
                f,
                "Invalid chunked encoding: expected LF after CR in size line."
            ),
            DecodeError::EmptyChunkSize => write!(f, "Invalid chunk size: \"\""),
            DecodeError::InvalidChunkSize => write!(f, "Invalid chunk size."),
            DecodeError::ChunkSizeOverflow => write!(f, "Invalid chunk size (overflow)."),
            DecodeError::ExpectedCrlf => write!(f, "Invalid chunked encoding: expected CRLF."),
            DecodeError::NotFinished => write!(f, "Chunked stream not finished."),
        }
    }
}

impl Error for DecodeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Size,
    Payload,
    ExpectCrlf,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AfterExpect {
    Size,
    Done,
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Streaming decoder state machine (greedy, minimal buffering).
#[derive(Debug)]
pub struct ChunkedDecoder {
    state: State,

    // SIZE parsing
    size_acc: usize,
    size_digits: usize,
    saw_cr: bool,

    // PAYLOAD parsing
    remaining: usize,

    // CRLF expectation parsing
    expect_index: u8, // 0 => expect '\r', 1 => expect '\n'
    after_expect: AfterExpect,
}

impl ChunkedDecoder {
    pub fn new() -> Self {
        Self {
            state: State::Size,
            size_acc: 0,
            size_digits: 0,
            saw_cr: false,
            remaining: 0,
            expect_index: 0,
            after_expect: AfterExpect::Size,
        }
    }

    pub fn decode_chunk<F>(&mut self, chunk: &str, mut on_data: F) -> Result<(), DecodeError>
    where
        F: FnMut(&str),
    {
        if self.state == State::Done {
            return Ok(());
        }

        if !chunk.is_ascii() {
            return Err(DecodeError::NonAsciiInput);
        }

        let bytes = chunk.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            match self.state {
                State::Size => {
                    let b = bytes[i];
                    i += 1;

                    if self.saw_cr {
                        if b != b'\n' {
                            return Err(DecodeError::ExpectedLfAfterCrInSizeLine);
                        }
                        self.saw_cr = false;

                        if self.size_digits == 0 {
                            return Err(DecodeError::EmptyChunkSize);
                        }

                        let n = self.size_acc;
                        self.size_acc = 0;
                        self.size_digits = 0;
                        self.remaining = n;

                        if n == 0 {
                            self.start_expect_crlf(AfterExpect::Done);
                        } else {
                            self.state = State::Payload;
                        }
                        continue;
                    }

                    if b == b'\r' {
                        self.saw_cr = true;
                        continue;
                    }

                    let Some(d) = hex_value(b) else {
                        return Err(DecodeError::InvalidChunkSize);
                    };

                    self.size_acc = self
                        .size_acc
                        .checked_mul(16)
                        .and_then(|v| v.checked_add(d as usize))
                        .ok_or(DecodeError::ChunkSizeOverflow)?;
                    self.size_digits += 1;
                }
                State::Payload => {
                    let available = bytes.len() - i;
                    let take = self.remaining.min(available);

                    if take > 0 {
                        // ASCII => byte indices are valid UTF-8 boundaries.
                        on_data(&chunk[i..i + take]);
                        i += take;
                        self.remaining -= take;
                    }

                    if self.remaining == 0 {
                        self.start_expect_crlf(AfterExpect::Size);
                    }
                }
                State::ExpectCrlf => {
                    let expected = if self.expect_index == 0 { b'\r' } else { b'\n' };
                    let b = bytes[i];
                    i += 1;

                    if b != expected {
                        return Err(DecodeError::ExpectedCrlf);
                    }

                    self.expect_index += 1;
                    if self.expect_index == 2 {
                        self.expect_index = 0;
                        self.state = match self.after_expect {
                            AfterExpect::Done => State::Done,
                            AfterExpect::Size => State::Size,
                        };
                        if self.state == State::Done {
                            return Ok(());
                        }
                    }
                }
                State::Done => return Ok(()),
            }
        }

        Ok(())
    }

    pub fn is_done(&self) -> bool {
        self.state == State::Done
    }

    pub fn finalize(&self) -> Result<(), DecodeError> {
        if self.is_done() {
            Ok(())
        } else {
            Err(DecodeError::NotFinished)
        }
    }

    fn start_expect_crlf(&mut self, next: AfterExpect) {
        self.state = State::ExpectCrlf;
        self.expect_index = 0;
        self.after_expect = next;
    }
}

impl Default for ChunkedDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience wrapper matching the prompt-style `Decoder { decodeChunk, result }`.
#[derive(Debug, Default)]
pub struct ChunkedCollectingDecoder {
    decoder: ChunkedDecoder,
    result: String,
}

impl ChunkedCollectingDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode_chunk(&mut self, chunk: &str) -> Result<(), DecodeError> {
        let out = &mut self.result;
        self.decoder.decode_chunk(chunk, |frag| out.push_str(frag))
    }

    pub fn is_done(&self) -> bool {
        self.decoder.is_done()
    }

    pub fn finalize(&self) -> Result<(), DecodeError> {
        self.decoder.finalize()
    }

    pub fn result(&self) -> &str {
        &self.result
    }
}

/// Backwards-compatible alias.
pub type CollectingDecoder = ChunkedCollectingDecoder;

/// Alias for the prompt's class name.
pub type Decoder = ChunkedCollectingDecoder;

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_chunked(payload: &str, chunk_sizes: &[usize]) -> String {
        assert!(payload.is_ascii());

        let bytes = payload.as_bytes();
        let mut i = 0usize;
        let mut out = String::new();

        for &size in chunk_sizes {
            if i >= bytes.len() {
                break;
            }
            let take = size.min(bytes.len() - i);
            out.push_str(&format!("{:x}\r\n", take));
            out.push_str(std::str::from_utf8(&bytes[i..i + take]).unwrap());
            out.push_str("\r\n");
            i += take;
        }

        if i < bytes.len() {
            let take = bytes.len() - i;
            out.push_str(&format!("{:x}\r\n", take));
            out.push_str(std::str::from_utf8(&bytes[i..]).unwrap());
            out.push_str("\r\n");
        }

        out.push_str("0\r\n\r\n");
        out
    }

    #[test]
    fn decodes_across_arbitrary_fragmentation() {
        let payload = "Hello, world! This is chunked.";
        let encoded = encode_chunked(payload, &[1, 2, 3, 4, 5]);

        let mut out = String::new();
        let mut decoder = ChunkedDecoder::new();

        for frag in encoded.as_bytes().chunks(3) {
            let frag = std::str::from_utf8(frag).unwrap();
            decoder.decode_chunk(frag, |d| out.push_str(d)).unwrap();
        }
        decoder.finalize().unwrap();

        assert_eq!(out, payload);
    }

    #[test]
    fn collecting_decoder_matches_streaming_output() {
        let payload = "abcdefg";
        let encoded = encode_chunked(payload, &[2, 2, 3]);

        let mut dec = ChunkedCollectingDecoder::new();
        for frag in encoded.as_bytes().chunks(2) {
            dec.decode_chunk(std::str::from_utf8(frag).unwrap()).unwrap();
        }
        dec.finalize().unwrap();
        assert_eq!(dec.result(), payload);
    }

    #[test]
    fn payload_can_contain_crlf() {
        let payload = "a\r\nb\r\nc";
        let encoded = encode_chunked(payload, &[2, 2, 2]);

        let mut dec = ChunkedCollectingDecoder::new();
        for frag in encoded.as_bytes().chunks(1) {
            dec.decode_chunk(std::str::from_utf8(frag).unwrap()).unwrap();
        }
        dec.finalize().unwrap();
        assert_eq!(dec.result(), payload);
    }
}
