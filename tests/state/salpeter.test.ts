/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Injectable seeded RNG + Salpeter KS test.
 *
 * Verifies that {@link sampleSalpeterMass} draws stellar masses from the Salpeter
 * IMF over [0.1, 50] (exponent p = 1.35). The sampler takes its generator as an
 * argument, so handing it a seeded `mulberry32` makes it deterministic and a
 * Kolmogorov-Smirnov goodness-of-fit test against the analytic Salpeter CDF is
 * non-flaky in CI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sampleSalpeterMass } from '../../src/state/ic/common';
import { mulberry32 } from '../utils/rng';
import { salpeterCDF, ksStatistic, ksCriticalValue } from '../utils/stats';

// Salpeter parameters baked into sampleSalpeterMass (kept in sync with the source).
const M_MIN = 0.1;
const M_MAX = 50.0;
const P = 1.35;

const SEED = 0x5a17e7;          // "salpeter"-ish
const N = 100_000;              // large enough for a tight KS band, fast enough for CI
const ALPHA = 0.01;             // significance level for the KS critical value

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

/** Draws `count` Salpeter masses from a seeded generator. */
function drawMasses(seed: number, count: number): number[] {
    const rng = mulberry32(seed);
    const masses: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        masses[i] = sampleSalpeterMass(rng);
    }
    return masses;
}

describe('Salpeter mass sampling (seeded RNG)', () => {
    it('keeps every sampled mass within the support [0.1, 50]', () => {
        const masses = drawMasses(SEED, N);
        let min = Infinity;
        let max = -Infinity;
        for (const m of masses) {
            if (m < min) min = m;
            if (m > max) max = m;
        }
        // Inverse-transform maps u ∈ [0,1] exactly onto [mMin, mMax]; allow float eps.
        expect(min).toBeGreaterThanOrEqual(M_MIN - 1e-9);
        expect(max).toBeLessThanOrEqual(M_MAX + 1e-9);
    });

    it('matches the analytic Salpeter CDF (KS test, D < D_crit at alpha=0.01)', () => {
        const masses = drawMasses(SEED, N);
        const D = ksStatistic(masses, (m) => salpeterCDF(m, M_MIN, M_MAX, P));
        const dCrit = ksCriticalValue(N, ALPHA);
        // Diagnostic: record the margin. D ~ O(1/√N) ≈ 3e-3,
        // dCrit ≈ 5.1e-3 → healthy margin, not knife-edge.
        expect(D).toBeLessThan(dCrit);
    });

    it('is deterministic: same seed reproduces the same draws', () => {
        const a = drawMasses(SEED, 1000);
        const b = drawMasses(SEED, 1000);
        expect(b).toEqual(a);
    });
});
