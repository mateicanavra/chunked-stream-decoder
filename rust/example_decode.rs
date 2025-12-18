mod decoder;

use std::io::{self, Read, Write};

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("Failed to read stdin.");
        std::process::exit(2);
    }

    let mut dec = decoder::Decoder::new();
    if let Err(e) = dec.decode_chunk(&input) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    if let Err(e) = dec.finalize() {
        eprintln!("{e}");
        std::process::exit(1);
    }
    if !dec.is_done() {
        eprintln!("Decoder not finished (internal invariant).");
        std::process::exit(1);
    }

    if io::stdout().write_all(dec.result().as_bytes()).is_err() {
        eprintln!("Failed to write stdout.");
        std::process::exit(2);
    }
}
