/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Deterministic seeded PRNG. Mulberry32 - a small, fast, well-distributed 32-bit
 * generator - backs both reproducible initial conditions (seeded permalinks) and
 * non-flaky statistical tests. Same seed, same call sequence, same realization.
 */

/**
 * Builds a generator producing a repeatable sequence in [0, 1).
 * @param seed - Stream selector; coerced to uint32, so one seed is one stream.
 * @returns A generator yielding the next draw on each call.
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Draws a fresh uint32 seed. Not part of any reproducible stream - this only picks
 * *which* stream to run, where unpredictability is the whole point.
 * @returns A uint32 suitable for {@link mulberry32}.
 */
export function randomUint32(): number {
    return (Math.random() * 2 ** 32) >>> 0;
}
