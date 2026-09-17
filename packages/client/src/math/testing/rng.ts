/// Deterministic bigint random source for the math tests.
///
/// Test inputs must be reproducible: a failure has to be re-runnable from the seed alone, the way
/// `spec_reference.py` fixes `Random(20260911)`. `Math.random` is therefore never used in this package's
/// tests. This file is excluded from the published build (`tsconfig.build.json` excludes `src/**/testing/**`).

const MASK64 = (1n << 64n) - 1n;

/// A seeded xorshift64* generator. Not cryptographic, and not meant to be: it only has to spread test inputs
/// across the uint256 range in a way that reproduces exactly on every machine.
export interface Rng {
  /// Next 64 pseudorandom bits.
  next64(): bigint;
  /// `bits` pseudorandom bits, 1-256.
  nextBits(bits: number): bigint;
  /// A value in `[0, bound)`; `bound` must be positive.
  below(bound: bigint): bigint;
  /// An integer in `[min, max]`.
  intBetween(min: number, max: number): number;
}

/// Creates a generator from a fixed seed.
export function createRng(seed: bigint): Rng {
  let state = seed & MASK64;
  if (state === 0n) state = 0x9e3779b97f4a7c15n;

  const next64 = (): bigint => {
    state ^= (state << 13n) & MASK64;
    state ^= state >> 7n;
    state ^= (state << 17n) & MASK64;
    state &= MASK64;
    return (state * 0x2545f4914f6cdd1dn) & MASK64;
  };

  const nextBits = (bits: number): bigint => {
    if (!Number.isInteger(bits) || bits < 1 || bits > 256)
      throw new RangeError(`bits must be 1-256: ${bits}`);
    let value = 0n;
    for (let produced = 0; produced < bits; produced += 64) value = (value << 64n) | next64();
    return value & ((1n << BigInt(bits)) - 1n);
  };

  const below = (bound: bigint): bigint => {
    if (bound <= 0n) throw new RangeError(`bound must be positive: ${bound}`);
    return nextBits(256) % bound;
  };

  return {
    next64,
    nextBits,
    below,
    intBetween: (min: number, max: number): number => min + Number(below(BigInt(max - min + 1))),
  };
}
