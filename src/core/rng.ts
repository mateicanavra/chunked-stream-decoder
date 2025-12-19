/** Deterministic RNG for repeatable tests/benchmarks (LCG). */
export class Rng {
  private x: number;
  constructor(seed = 123456789) {
    this.x = seed >>> 0;
  }

  /** Returns uint32. */
  nextU32(): number {
    this.x = (1664525 * this.x + 1013904223) >>> 0;
    return this.x;
  }

  /** Returns float in [0, 1). */
  next(): number {
    return this.nextU32() / 0x1_0000_0000;
  }

  /** Returns int in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("min/max must be finite");
    if (max < min) throw new Error("max must be >= min");
    const span = max - min + 1;
    return min + (this.nextU32() % span);
  }

  /** Returns true with probability p (0..1). */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }
}
