/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for the self-gravitating ("selfgrav") galaxy initial conditions in
 * {@link SimulationManager}. The physics-first model is an exponential disk of
 * equal-mass macro-particles embedded in the dark-matter halo, with no central
 * point mass. Velocities come from the *measured* 2-D rotation curve (so the disk
 * starts in centrifugal balance with the engine's actual forces) warmed to a
 * target Toomre Q with an asymmetric-drift correction. These guard that the disk
 * stays bound when stepped - rather than expanding/exploding within a crossing
 * time. initGalaxy()/BruteForceEngine touch no DOM or GPU, so they are driven
 * directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SimulationManager,
    SELF_GRAV_DISK_MASS,
} from './SimulationManager';
import { BruteForceEngine } from '../physics';

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
    it('uses equal-mass macro-particles (no central point mass) totalling SELF_GRAV_DISK_MASS', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        // Every particle - including index 0 - is an equal-mass disk macro-particle.
        const expected = SELF_GRAV_DISK_MASS / sim.params.count;
        let total = 0;
        for (let i = 0; i < sim.params.count; i++) {
            expect(sim.state.mass[i]).toBeCloseTo(expected, 0);
            total += sim.state.mass[i];
        }
        // Float32 storage accumulates a tiny rounding error over N particles.
        expect(Math.abs(total / SELF_GRAV_DISK_MASS - 1)).toBeLessThan(1e-4);
        expect(sim.diskMass).toBe(SELF_GRAV_DISK_MASS);
        // The whole disk self-gravitates: every particle is active.
        expect(sim.params.activeCount).toBe(sim.params.count);
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

describe('SimulationManager - core preset is unchanged', () => {
    it('keeps the preset softening (1.0) and an unequal Salpeter mass spectrum', () => {
        const sim = makeSim('core');
        sim.initGalaxy();

        expect(sim.params.softening).toBe(1.0);
        expect(sim.diskMass).toBe(0);

        // Salpeter sampling => a wide spread of disk masses (not all equal).
        let min = Infinity, max = -Infinity;
        for (let i = 1; i < sim.params.count; i++) {
            min = Math.min(min, sim.state.mass[i]);
            max = Math.max(max, sim.state.mass[i]);
        }
        expect(max / min).toBeGreaterThan(10);
    });
});
