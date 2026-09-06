/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * `EnergyMonitor` - the production energy diagnostic behind the live ΔE/E₀ panel.
 * The panel's whole claim is that the number on screen is *exact*, so the thing under
 * test is not the physics (the kernel and engine suites own that) but the machinery
 * that makes an exact O(N²) sum affordable: a snapshot, a resumable triangular
 * cursor, and a baseline.
 *
 * Three properties are locked here:
 *   1. Chunking is inert. The chunked sum must equal a direct double loop written
 *      independently in this file, to float64 round-off, for any chunk budget. The
 *      chunk *count* is asserted too: a resume bug that revisits or skips a row shows
 *      up as a wrong count (or a hang) long before it shows up in the total.
 *   2. Monitor and engine agree. Driving a real BruteForceEngine through the
 *      monitor must reproduce the engine suite's Case-A conservation band.
 *   3. The baseline behaves. `deltaE0()` is null until there is something honest
 *      to report, exactly 0 on the first sample, and resets cleanly.
 *
 * All ICs are seeded (mulberry32) and deterministic; every frozen threshold below is
 * commented with the value actually measured here and the margin left on it.
 */
import { describe, it, expect } from 'vitest';
import { BruteForceEngine, PhysicsState } from '../../src/physics';
import type { PhysicsParams } from '../../src/physics/types';
import { EnergyMonitor, DEFAULT_DM_CORE_RADIUS } from '../../src/physics/energy';
import { mulberry32 } from '../utils/rng';
import { makeVirialCluster } from '../utils/clusters';

/** Guard on every `while (!processChunk())` loop so a cursor bug fails instead of hanging. */
const MAX_CHUNKS = 100_000;

/** Builds a seeded, unstructured N-body system - no symmetry for a bug to hide behind. */
function makeRandomSystem(n: number, seed: number): PhysicsState {
    const rng = mulberry32(seed);
    const state = new PhysicsState(n);
    for (let i = 0; i < n; i++) {
        state.positionX[i] = (rng() * 2 - 1) * 40;
        state.positionY[i] = (rng() * 2 - 1) * 40;
        state.velocityX[i] = (rng() * 2 - 1) * 3;
        state.velocityY[i] = (rng() * 2 - 1) * 3;
        state.mass[i] = 0.5 + rng() * 2;
    }
    return state;
}

/**
 * Reference energy: a direct, unchunked double loop written here and owed nothing to
 * the module under test beyond the shape of the definition.
 */
function referenceEnergy(
    state: PhysicsState,
    params: PhysicsParams,
    start: number,
): { E: number; KE: number; PE: number } {
    const { positionX: px, positionY: py, velocityX: vx, velocityY: vy, mass } = state;
    const end = Math.min(params.activeCount, state.n);
    const G = params.gravity;
    const epsSq = params.softening * params.softening;

    let KE = 0;
    for (let i = start; i < end; i++) {
        KE += 0.5 * mass[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
    }

    let PE = 0;
    for (let i = start; i < end; i++) {
        for (let j = i + 1; j < end; j++) {
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            PE -= (G * mass[i] * mass[j]) / Math.sqrt(dx * dx + dy * dy + epsSq);
        }
    }

    const dmStrength = params.dmStrength ?? 0;
    if (dmStrength > 0) {
        const rcoreSq = (params.dmCoreRadius ?? DEFAULT_DM_CORE_RADIUS) ** 2;
        for (let i = start; i < end; i++) {
            const rSq = px[i] * px[i] + py[i] * py[i];
            PE += mass[i] * 0.5 * dmStrength * dmStrength * Math.log(rSq + rcoreSq);
        }
    }
    const bhMass = params.blackHoleMass ?? 0;
    if (bhMass > 0) {
        const bhEpsSq = (params.blackHoleSoftening ?? params.softening) ** 2;
        for (let i = start; i < end; i++) {
            const rSq = px[i] * px[i] + py[i] * py[i];
            PE -= (G * bhMass * mass[i]) / Math.sqrt(rSq + bhEpsSq);
        }
    }

    return { E: KE + PE, KE, PE };
}

/** Runs a cycle to completion at the given budget, returning the number of chunks it took. */
function runCycle(monitor: EnergyMonitor, maxPairs: number): number {
    let chunks = 0;
    while (!monitor.processChunk(maxPairs)) {
        chunks++;
        expect(chunks, 'cycle failed to terminate - cursor bug').toBeLessThan(MAX_CHUNKS);
    }
    return chunks + 1;
}

describe('EnergyMonitor - chunked pairwise sum', () => {
    const N = 200;

    it('reproduces a direct double-loop sum exactly, at any chunk budget', () => {
        // gravity ≠ 1 on purpose: the prototype this was extracted from hardcoded G = 1,
        // so a non-unit G is what asserts production actually reads params.gravity.
        const params: PhysicsParams = {
            gravity: 1.3,
            dt: 0.01,
            softening: 1.0,
            activeCount: N,
            useActivePassive: false,
            theta: 0.7,
            dmStrength: 0,
            blackHoleMass: 0,
        };
        const state = makeRandomSystem(N, 0xA11CE);
        const ref = referenceEnergy(state, params, 0);

        // 200 bodies from index 0 → 200·199/2 = 19 900 pairs.
        const nPairs = (N * (N - 1)) / 2;
        for (const [maxPairs, expectedChunks] of [
            [1_000, Math.ceil(nPairs / 1_000)], // 20
            [1_000_000, 1],
        ] as const) {
            const monitor = new EnergyMonitor();
            monitor.beginCycle(state, params, 0);
            const chunks = runCycle(monitor, maxPairs);

            // Every chunk but the last consumes exactly maxPairs, so the count is
            // deterministic: a resume bug shows here as a wrong count.
            expect(chunks, `maxPairs=${maxPairs}`).toBe(expectedChunks);

            const sample = monitor.lastSample!;
            // Chunking only re-associates float64 additions, and with no external terms
            // it does not even do that: measured relative error is exactly 0 at both
            // budgets. Frozen at 1e-12 - loose enough to survive a future re-association,
            // tight enough that any real arithmetic change trips it.
            expect(Math.abs(sample.E - ref.E) / Math.abs(ref.E)).toBeLessThan(1e-12);
            expect(Math.abs(sample.PE - ref.PE) / Math.abs(ref.PE)).toBeLessThan(1e-12);
            expect(Math.abs(sample.KE - ref.KE) / Math.abs(ref.KE)).toBeLessThan(1e-12);
        }
    });

    it('folds in the halo and pinned-BH potentials and skips the pinned index', () => {
        // blackHoleMass > 0 ⇒ start = 1, so index 0 leaves both the sums and the pair
        // count. This also covers the Φ_DM branch, which no other suite exercises.
        const params: PhysicsParams = {
            gravity: 1.3,
            dt: 0.01,
            softening: 1.0,
            activeCount: N,
            useActivePassive: false,
            theta: 0.7,
            dmStrength: 120,
            dmCoreRadius: 800,
            blackHoleMass: 500,
            blackHoleSoftening: 0.5,
        };
        const state = makeRandomSystem(N, 0xBADCAB);
        const ref = referenceEnergy(state, params, 1);

        const monitor = new EnergyMonitor();
        monitor.beginCycle(state, params, 0);
        const active = N - 1; // index 0 is the pinned BH
        const chunks = runCycle(monitor, 1_000);

        // 199 active bodies → 19 701 pairs → 20 chunks at 1e3.
        expect(chunks).toBe(Math.ceil((active * (active - 1)) / 2 / 1_000));

        const sample = monitor.lastSample!;
        // The external terms group their factors differently from the reference loop, so
        // this one lands a single ulp out: measured 1.27e-16 relative, on both E and PE.
        expect(Math.abs(sample.E - ref.E) / Math.abs(ref.E)).toBeLessThan(1e-12);
        expect(Math.abs(sample.PE - ref.PE) / Math.abs(ref.PE)).toBeLessThan(1e-12);
    });
});

describe('EnergyMonitor - engine agreement', () => {
    it("matches the engine suite's Case-A conservation band for a real BruteForce cluster", () => {
        const N = 64;
        const params: PhysicsParams = {
            gravity: 1,
            dt: 0.004,
            softening: 1.0,
            activeCount: N,
            useActivePassive: false,
            theta: 0.7,
            dmStrength: 0,
            blackHoleMass: 0,
        };
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const engine = new BruteForceEngine(state);
        const monitor = new EnergyMonitor();

        let simTime = 0;
        let maxDrift = 0;
        for (let step = 0; step <= 2000; step++) {
            if (step % 50 === 0) {
                monitor.beginCycle(state, params, simTime);
                // A deliberately small budget so the smoke test drives the chunked
                // resume path end-to-end rather than completing in one pass.
                runCycle(monitor, 1000);
                const d = monitor.deltaE0();
                expect(d).not.toBeNull();
                maxDrift = Math.max(maxDrift, Math.abs(d!));
            }
            engine.step(params.dt, params);
            simTime += params.dt;
        }

        expect(monitor.sampleCount).toBe(41); // step 0 plus every 50th to 2000
        // The engine suite's Case-A band (1.5e-3) over the same ICs - the monitor must agree with
        // the engine suite's independent summation. 2000 steps is a subset of Case A's
        // 5000, so this must come in under its measured 6.163e-4, and it does: measured
        // 5.765e-4 here, ~2.6× margin on the frozen bound.
        expect(maxDrift).toBeLessThan(1.5e-3);
    });
});

describe('EnergyMonitor - baseline lifecycle', () => {
    const N = 32;
    const params: PhysicsParams = {
        gravity: 1,
        dt: 0.004,
        softening: 1.0,
        activeCount: N,
        useActivePassive: false,
        theta: 0.7,
        dmStrength: 0,
        blackHoleMass: 0,
    };

    it('reports nothing until a cycle completes, then exactly zero drift', () => {
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const monitor = new EnergyMonitor();

        expect(monitor.deltaE0()).toBeNull();
        expect(monitor.baselineEnergy()).toBeNull();

        monitor.beginCycle(state, params, 0);
        monitor.processChunk(1); // in flight, nothing published yet
        expect(monitor.inFlight).toBe(true);
        expect(monitor.deltaE0()).toBeNull();

        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);
        // The first sample *is* the baseline: E − E ≡ 0 by construction, not by luck.
        expect(monitor.deltaE0()).toBeCloseTo(0, 12);
        expect(monitor.baselineEnergy()).toBe(monitor.lastSample!.E);
        expect(monitor.sampleCount).toBe(1);
    });

    it('reports a small non-zero drift once the system has been stepped', () => {
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const engine = new BruteForceEngine(state);
        const monitor = new EnergyMonitor();

        monitor.beginCycle(state, params, 0);
        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);

        for (let s = 0; s < 200; s++) engine.step(params.dt, params);
        monitor.beginCycle(state, params, 200 * params.dt);
        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);

        const drift = monitor.deltaE0();
        expect(drift).not.toBeNull();
        expect(drift).not.toBe(0);
        // Leapfrog on a 32-body cluster: measured 7.736e-7 after 200 steps. The claim is
        // only that the drift is real but bounded well inside the Case-A band, so the
        // bound stays 1.5e-3 rather than tracking the measurement.
        expect(Math.abs(drift!)).toBeLessThan(1.5e-3);
        expect(monitor.history()).toHaveLength(2);
    });

    it('clears the baseline, the history, and any in-flight cycle on reset', () => {
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const monitor = new EnergyMonitor();

        monitor.beginCycle(state, params, 0);
        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);
        expect(monitor.sampleCount).toBe(1);

        monitor.resetBaseline();
        expect(monitor.deltaE0()).toBeNull();
        expect(monitor.baselineEnergy()).toBeNull();
        expect(monitor.sampleCount).toBe(0);
        expect(monitor.history()).toHaveLength(0);

        monitor.beginCycle(state, params, 1);
        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);
        expect(monitor.deltaE0()).toBeCloseTo(0, 12); // fresh baseline, so zero again
    });

    it('discards an in-flight cycle when reset mid-sum', () => {
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const monitor = new EnergyMonitor();

        monitor.beginCycle(state, params, 0);
        monitor.resetBaseline();
        expect(monitor.inFlight).toBe(false);
        // The abandoned cycle must not resurface as a sample built on a stale snapshot.
        expect(monitor.processChunk()).toBe(false);
        expect(monitor.sampleCount).toBe(0);
        expect(monitor.lastSample).toBeNull();
    });

    it('cancelCycle drops the in-flight cycle but keeps the baseline and history', () => {
        const state = makeVirialCluster(N, 0xC0FFEE, params);
        const monitor = new EnergyMonitor();

        monitor.beginCycle(state, params, 0);
        runCycle(monitor, EnergyMonitor.DEFAULT_MAX_PAIRS);
        const baseline = monitor.baselineEnergy();

        monitor.beginCycle(state, params, 5);
        monitor.cancelCycle();
        expect(monitor.inFlight).toBe(false);
        expect(monitor.processChunk()).toBe(false);

        // This is the difference from resetBaseline: closing the panel must not wipe
        // the trace it will show again on reopen.
        expect(monitor.sampleCount).toBe(1);
        expect(monitor.baselineEnergy()).toBe(baseline);
        expect(monitor.history()).toHaveLength(1);
    });
});
