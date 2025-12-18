# Rust port (standalone)

This directory is intentionally not wired into the repo build/test system.

This Rust version matches the simplified TypeScript decoder: it accepts ASCII `&str` fragments and chunk sizes count characters (ASCII => 1 char == 1 byte).

## Files

- `rust/decoder.rs`: idiomatic Rust implementation of the simplified chunked framing (`ChunkedDecoder`, `ChunkedCollectingDecoder`)
- `rust/example_decode.rs`: tiny CLI example that decodes a full chunked message from stdin

## Build / run the example

```bash
rustc rust/example_decode.rs -O -o /tmp/chunked_decode
cat /path/to/chunked.txt | /tmp/chunked_decode
```

## Run the Rust unit tests (optional)

```bash
rustc --test rust/decoder.rs -O -o /tmp/decoder_tests
/tmp/decoder_tests
```
