/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Injectable seeded RNG + Salpeter KS test.
 *
 * Verifies that {@link SimulationManager.sampleSalpeterMass} draws stellar masses
 * from the Salpeter IMF over [0.1, 50] (exponent p = 1.35). With a seeded RNG
 * injected (`mulberry32`), the sampler is deterministic, so a Kolmogorov–Smirnov
 * goodness-of-fit test against the analytic Salpeter CDF is non-flaky in CI.
 *
 * The RNG is a private instance field defaulting to Math.random; tests reach it
 * via a cast (TS `private` is compile-time only), matching the private-access
 * pattern used by the existing accretion/selfgrav preset tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulationManager } from '../../src/state/SimulationManager';
import { mulberry32 } from '../utils/rng';
import { salpeterCDF, ksStatistic, ksCriticalValue } from '../utils/stats';

// Salpeter parameters baked into sampleSalpeterMass (kept in sync with the source).
const M_MIN = 0.1;
const M_MAX = 50.0;
const P = 1.35;

const SEED = 0x5a17e7;          // "salpeter"-ish
const N = 100_000;              // large enough for a tight KS band, fast enough for CI
const ALPHA = 0.01;             // significance level for the KS critical value

// Reaches the private RNG field + private sampler (TS `private` is compile-time only).
interface SalpeterInternals {
    rng: () => number;
    sampleSalpeterMass(): number;
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

/** Builds a manager with a seeded RNG and draws `count` Salpeter masses. */
function drawMasses(seed: number, count: number): number[] {
    const sim = new SimulationManager();
    (sim as unknown as SalpeterInternals).rng = mulberry32(seed);
    const internals = sim as unknown as SalpeterInternals;
    const masses: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        masses[i] = internals.sampleSalpeterMass();
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
        // Diagnostic: record the margin (see PROGRESS.md). D ~ O(1/√N) ≈ 3e-3,
        // dCrit ≈ 5.1e-3 → healthy margin, not knife-edge.
        expect(D).toBeLessThan(dCrit);
    });

    it('is deterministic: same seed reproduces the same draws', () => {
        const a = drawMasses(SEED, 1000);
        const b = drawMasses(SEED, 1000);
        expect(b).toEqual(a);
    });
});
