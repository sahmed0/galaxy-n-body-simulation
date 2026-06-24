/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Deterministic seeded PRNG shared across the test suite. Mulberry32 — a small,
 * fast, well-distributed 32-bit generator — gives reproducible draws so that
 * statistical tests (e.g. the Salpeter KS test) are non-flaky in CI. The exact
 * implementation was inlined in earlier phases' tests (quadtree, barnes-hut);
 * this is the shared extraction those phases deferred to Phase 7.
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
