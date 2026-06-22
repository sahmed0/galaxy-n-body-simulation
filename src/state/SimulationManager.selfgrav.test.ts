/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for the self-gravitating ("selfgrav") galaxy initial conditions in
 * {@link SimulationManager}. The physics-first model is an exponential disk of
 * equal-mass macro-particles embedded in the dark-matter halo, with a fixed
 * central black hole pinned at the origin (index 0) - an inert, source-only point
 * mass that pulls on the disk but feels nothing and never moves. Velocities come
 * from the *measured* 2-D rotation curve (disk + halo + BH, so the disk starts in
 * centrifugal balance with the engine's actual forces) warmed to a target Toomre Q
 * with an asymmetric-drift correction. These guard that the disk stays bound when
 * stepped - rather than expanding/exploding within a crossing time - and that the
 * BH stays pinned. initGalaxy()/BruteForceEngine touch no DOM or GPU, so they are
 * driven directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SimulationManager,
    ENGINE_PRESETS,
    MIN_DT_FRACTION,
    DISK_SCALE_LENGTH,
    TARGET_F_DISK,
    CORE_MASS,
} from './SimulationManager';
import { BruteForceEngine, BarnesHutEngine } from '../physics';

// Reaches the private rotation-curve internals (TS `private` is compile-time
// only) so the tests can sample the measured curve and derived frequencies.
interface SelfGravInternals {
    rotCurveAcc: Float64Array;
    rotCurveRMin: number;
    rotCurveRMax: number;
    vCircAt(r: number): number;
    kappaAt(r: number): number;
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

/** Builds a manager with a cheap star count and the given galaxy mode. */
function makeSim(mode: 'core' | 'selfgrav', count = 1500) {
    const sim = new SimulationManager();
    sim.params.count = count;
    sim.params.galaxyMode = mode;
    return sim;
}

/** Max distance of any particle from the origin. */
function maxRadius(sim: SimulationManager): number {
    let max = 0;
    for (let i = 0; i < sim.params.count; i++) {
        const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
        if (r > max) max = r;
    }
    return max;
}

/** RMS distance of all particles from the origin (a robust disk-size metric). */
function rmsRadius(sim: SimulationManager): number {
    let sumSq = 0;
    for (let i = 0; i < sim.params.count; i++) {
        sumSq += sim.state.positionX[i] ** 2 + sim.state.positionY[i] ** 2;
    }
    return Math.sqrt(sumSq / sim.params.count);
}

describe('SimulationManager - self-gravitating initial conditions', () => {
    it('reserves index 0 as the fixed BH and gives the disk equal-mass macro-particles totalling diskMass', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        // Index 0 is the pinned central black hole (CORE_MASS), not a disk particle.
        expect(sim.state.mass[0]).toBe(CORE_MASS);
        expect(sim.params.blackHoleMass).toBe(CORE_MASS);

        // The total disk mass is calibrated (not the seed constant); every disk
        // particle [1, count) is an equal-mass macro-particle of diskMass/nDiskActive.
        // With count=1500 the active count clamps to the whole disk, so that is
        // diskMass/(count - 1).
        const nDiskActive = sim.params.count - 1;
        const expected = sim.diskMass / nDiskActive;
        let total = 0;
        for (let i = 1; i < sim.params.count; i++) {
            // Relative tolerance: the calibrated mass can be large, so an absolute
            // toBeCloseTo would fail purely on float magnitude.
            expect(Math.abs(sim.state.mass[i] / expected - 1)).toBeLessThan(1e-4);
            total += sim.state.mass[i];
        }
        // Float32 storage accumulates a tiny rounding error over N particles.
        expect(Math.abs(total / sim.diskMass - 1)).toBeLessThan(1e-4);
        // BH (index 0) + the whole disk active: the source range end is the count.
        expect(sim.params.activeCount).toBe(sim.params.count);
    });

    it('pins the black hole at the origin with zero velocity', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        expect(sim.state.positionX[0]).toBe(0);
        expect(sim.state.positionY[0]).toBe(0);
        expect(sim.state.velocityX[0]).toBe(0);
        expect(sim.state.velocityY[0]).toBe(0);
    });

    it('keeps the black hole fixed at the origin when stepped (feels no force, never moves)', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        const engine = new BruteForceEngine(sim.state);
        for (let step = 0; step < 80; step++) engine.update(sim.params.dt, sim.params);

        // The BH is an inert, pinned marker: position and velocity are untouched.
        expect(sim.state.positionX[0]).toBe(0);
        expect(sim.state.positionY[0]).toBe(0);
        expect(sim.state.velocityX[0]).toBe(0);
        expect(sim.state.velocityY[0]).toBe(0);
    });

    it('also pins the BH and keeps the disk bound under the Barnes-Hut engine', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        const r0 = maxRadius(sim);

        // Barnes-Hut excludes the BH by *not inserting* it into the tree (rather
        // than a loop bound), so guard that path independently of BruteForce.
        const engine = new BarnesHutEngine(sim.state);
        for (let step = 0; step < 80; step++) engine.update(sim.params.dt, sim.params);

        expect(sim.state.positionX[0]).toBe(0);
        expect(sim.state.positionY[0]).toBe(0);
        expect(sim.state.velocityX[0]).toBe(0);
        expect(sim.state.velocityY[0]).toBe(0);

        // The disk should hold together rather than blow out.
        let flung = 0;
        for (let i = 1; i < sim.params.count; i++) {
            const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
            if (r > 3 * r0) flung++;
        }
        expect(flung / sim.params.count).toBeLessThan(0.05);
    });

    it('calibrates the disk mass so f_disk at 2.2 R_d hits TARGET_F_DISK', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        // The realized particle field carries Poisson scatter, so allow a modest band.
        const fDisk = sim.diskFractionAt(2.2 * DISK_SCALE_LENGTH);
        expect(Math.abs(fDisk - TARGET_F_DISK)).toBeLessThan(0.05);
    });

    it('softens on the order of the inter-particle spacing, not the core preset 1.0', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        // Exponential disk (R_d = 150) over 1500 particles => half-mass-radius
        // spacing ~20, far above the core preset value of 1.0.
        expect(sim.params.softening).toBeGreaterThan(5);
    });

    it('carries (near) zero net momentum so the galaxy does not bulk-drift', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        let px = 0, py = 0, m = 0;
        for (let i = 0; i < sim.params.count; i++) {
            px += sim.state.mass[i] * sim.state.velocityX[i];
            py += sim.state.mass[i] * sim.state.velocityY[i];
            m += sim.state.mass[i];
        }
        // Mean speed per unit mass should be negligible vs orbital speeds.
        expect(Math.hypot(px, py) / m).toBeLessThan(1e-3);
    });

    it('centres the disk COM on the origin so the origin-pinned halo pulls symmetrically', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        let rx = 0, ry = 0, m = 0;
        for (let i = 0; i < sim.params.count; i++) {
            rx += sim.state.mass[i] * sim.state.positionX[i];
            ry += sim.state.mass[i] * sim.state.positionY[i];
            m += sim.state.mass[i];
        }
        // The subtraction is exact up to Float32 storage rounding, so the residual
        // mass-weighted COM offset should be tiny relative to the disk scale length.
        expect(Math.hypot(rx, ry) / m).toBeLessThan(1e-3);
    });

    it('derives a dt that resolves the disk and never exceeds the preset dt', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        const presetDt = ENGINE_PRESETS[sim.params.engineType as keyof typeof ENGINE_PRESETS].timeStep;

        // Adaptive dt must not run faster than the engine preset...
        expect(sim.params.dt).toBeLessThanOrEqual(presetDt);
        // ...nor collapse below the floor that guards against a stalled sim.
        expect(sim.params.dt).toBeGreaterThanOrEqual(presetDt * MIN_DT_FRACTION);

        // The fastest orbit (peak angular frequency over the measured rotation
        // curve) must be resolved by at least ~30 leapfrog steps. Reach through
        // the runtime for the private curve (TS `private` is compile-time only).
        const s = sim as unknown as SelfGravInternals;
        const acc: Float64Array = s.rotCurveAcc;
        let omegaMax = 0;
        for (let k = 0; k < acc.length; k++) {
            const rk = s.rotCurveRMin + ((s.rotCurveRMax - s.rotCurveRMin) * k) / (acc.length - 1);
            if (rk <= 0) continue;
            const omega = s.vCircAt(rk) / rk;
            if (omega > omegaMax) omegaMax = omega;
        }
        const stepsPerOrbit = (2 * Math.PI / omegaMax) / sim.params.dt;
        expect(stepsPerOrbit).toBeGreaterThanOrEqual(30);
    });

    it('produces a smooth epicyclic frequency kappa(R) with no per-grid-cell staircase', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        // Reach through the runtime for the private kappaAt (TS `private` is
        // compile-time only) and sample it on a fine radius grid, finer than the
        // rotation-curve table spacing so a per-cell staircase would show up as
        // large cell-to-cell jumps. Start at 0.5 R_d: inside that the fixed central
        // BH (softening ~25) makes kappa genuinely Keplerian-steep, so the cell-to-
        // cell change there is physical, not a staircase artifact.
        const s = sim as unknown as SelfGravInternals;
        const rLo = 0.5 * DISK_SCALE_LENGTH;
        const rHi = 3 * DISK_SCALE_LENGTH;
        const N = 200;
        const kappa: number[] = [];
        for (let i = 0; i < N; i++) {
            const r = rLo + ((rHi - rLo) * i) / (N - 1);
            const k = s.kappaAt(r);
            expect(Number.isFinite(k)).toBe(true);
            expect(k).toBeGreaterThan(0);
            kappa.push(k);
        }

        // Successive samples should vary smoothly: the widened stencil and the
        // table smoothing remove the staircase, so the max relative cell-to-cell
        // jump stays modest (the staircased derivative produced much larger jumps).
        let maxRelJump = 0;
        for (let i = 1; i < kappa.length; i++) {
            const rel = Math.abs(kappa[i] - kappa[i - 1]) / kappa[i];
            if (rel > maxRelJump) maxRelJump = rel;
        }
        expect(maxRelJump).toBeLessThan(0.05);
    });

    it('stays bound when stepped: no blow-out and no runaway expansion', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        const r0 = maxRadius(sim);
        const rms0 = rmsRadius(sim);

        const engine = new BruteForceEngine(sim.state);
        for (let step = 0; step < 80; step++) engine.update(sim.params.dt, sim.params);

        // A few stars on eccentric orbits is fine; a blow-up sends a large
        // fraction past several times the initial radius.
        let flung = 0;
        for (let i = 0; i < sim.params.count; i++) {
            const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
            if (r > 3 * r0) flung++;
        }
        expect(flung / sim.params.count).toBeLessThan(0.02);

        // The disk should neither explode nor collapse: its RMS radius stays
        // within a factor of ~2 of the initial value.
        const rms1 = rmsRadius(sim);
        expect(rms1 / rms0).toBeGreaterThan(0.5);
        expect(rms1 / rms0).toBeLessThan(2.0);
    });
});

describe('SimulationManager - self-gravitating active/passive split', () => {
    /** Builds a selfgrav sim with the active/passive split engaged. */
    function makeSplitSim(count = 4000, nActive = 1000) {
        const sim = makeSim('selfgrav', count);
        sim.params.selfGravActiveCount = nActive;
        return sim;
    }

    it('marks the BH plus the first selfGravActiveCount disk particles active', () => {
        const sim = makeSplitSim(4000, 1000);
        sim.initGalaxy();
        // Source range [1, activeCount) = 1000 disk sources, so activeCount = 1001
        // (the BH at index 0 occupies the leading slot, mirroring the core preset).
        expect(sim.params.activeCount).toBe(1001);
        // Sanity: the split must actually be engaged (not clamped to count).
        expect(sim.params.activeCount).toBeLessThan(sim.params.count);
    });

    it('puts the full calibrated disk mass on the active set (passive tracers share the render mass)', () => {
        const sim = makeSplitSim(4000, 1000);
        sim.initGalaxy();

        // Every disk particle [1, count) carries the same per-active-particle mass =
        // diskMass/nDiskActive (passive ones for render parity; never summed as a
        // source). Index 0 is the BH (CORE_MASS) and is excluded.
        const nDiskActive = sim.params.activeCount - 1;
        const expected = sim.diskMass / nDiskActive;
        let activeSum = 0;
        for (let i = 1; i < sim.params.count; i++) {
            expect(Math.abs(sim.state.mass[i] / expected - 1)).toBeLessThan(1e-4);
            if (i < sim.params.activeCount) activeSum += sim.state.mass[i];
        }
        // The field-generating (active disk) mass totals the calibrated disk mass.
        expect(Math.abs(activeSum / sim.diskMass - 1)).toBeLessThan(1e-4);
    });

    it('still calibrates f_disk at 2.2 R_d from the active-set field', () => {
        const sim = makeSplitSim(4000, 1000);
        sim.initGalaxy();
        const fDisk = sim.diskFractionAt(2.2 * DISK_SCALE_LENGTH);
        expect(Math.abs(fDisk - TARGET_F_DISK)).toBeLessThan(0.05);
    });

    it('is inert when selfGravActiveCount >= count (every particle active)', () => {
        const sim = makeSim('selfgrav', 1500);
        sim.params.selfGravActiveCount = 8000; // > count
        sim.initGalaxy();
        expect(sim.params.activeCount).toBe(sim.params.count);
    });

    it('keeps the passive tracer cloud bound when stepped', () => {
        const sim = makeSplitSim(4000, 1000);
        sim.initGalaxy();
        const r0 = maxRadius(sim);
        const rms0 = rmsRadius(sim);

        // The engine reads activeCount + useActivePassive: active feel active,
        // passive feel active, neither feels passive.
        const engine = new BruteForceEngine(sim.state);
        for (let step = 0; step < 80; step++) engine.update(sim.params.dt, sim.params);

        // The grainier active backbone makes the disk a touch hotter, so allow a
        // slightly larger flung fraction than the fully-sampled disk, but it must
        // still hold together rather than blow out.
        let flung = 0;
        for (let i = 0; i < sim.params.count; i++) {
            const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
            if (r > 3 * r0) flung++;
        }
        expect(flung / sim.params.count).toBeLessThan(0.05);

        const rms1 = rmsRadius(sim);
        expect(rms1 / rms0).toBeGreaterThan(0.5);
        expect(rms1 / rms0).toBeLessThan(2.0);
    });
});

describe('SimulationManager - core preset is unchanged', () => {
    it('keeps the preset softening (1.0) and an unequal Salpeter mass spectrum', () => {
        const sim = makeSim('core');
        sim.initGalaxy();

        expect(sim.params.softening).toBe(1.0);
        expect(sim.diskMass).toBe(0);
        // The "core" preset uses a live index-0 SMBH particle, not the analytic
        // fixed-BH term, so the latter stays off.
        expect(sim.params.blackHoleMass).toBe(0);

        // The adaptive timestep is a no-op for the core preset: dt stays the
        // fixed engine preset value.
        expect(sim.params.dt).toBe(ENGINE_PRESETS[sim.params.engineType as keyof typeof ENGINE_PRESETS].timeStep);

        // Salpeter sampling => a wide spread of disk masses (not all equal).
        let min = Infinity, max = -Infinity;
        for (let i = 1; i < sim.params.count; i++) {
            min = Math.min(min, sim.state.mass[i]);
            max = Math.max(max, sim.state.mass[i]);
        }
        expect(max / min).toBeGreaterThan(10);
    });
});
