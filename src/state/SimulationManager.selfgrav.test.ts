/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for the self-gravitating ("selfgrav") galaxy initial conditions in
 * {@link SimulationManager}. These guard the fix for the preset blowing up: the
 * disk must use equal-mass macro-particles and a softening on the order of the
 * inter-particle spacing (not the core preset's 1.0), and the disk must stay
 * bound when actually stepped - rather than scattering stars and ejecting the
 * SMBH within a crossing time. initGalaxy()/BruteForceEngine touch no DOM or GPU,
 * so they can be driven directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SimulationManager,
    SELF_GRAV_DISK_MASS,
    CORE_MASS,
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

/** Max distance of any disk particle (index >= 1) from the origin. */
function maxDiskRadius(sim: SimulationManager): number {
    let max = 0;
    for (let i = 1; i < sim.params.count; i++) {
        const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
        if (r > max) max = r;
    }
    return max;
}

describe('SimulationManager - self-gravitating initial conditions', () => {
    it('uses equal-mass disk macro-particles totalling SELF_GRAV_DISK_MASS', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();

        const expected = SELF_GRAV_DISK_MASS / (sim.params.count - 1);
        let total = 0;
        for (let i = 1; i < sim.params.count; i++) {
            expect(sim.state.mass[i]).toBeCloseTo(expected, 3);
            total += sim.state.mass[i];
        }
        expect(total).toBeCloseTo(SELF_GRAV_DISK_MASS, 0);
        // The central SMBH keeps its own mass and is not part of the disk total.
        expect(sim.state.mass[0]).toBe(CORE_MASS);
        // Every macro-particle exceeds the active threshold => full self-gravity.
        expect(sim.diskMass).toBe(SELF_GRAV_DISK_MASS);
        expect(sim.params.activeCount).toBe(sim.params.count);
    });

    it('softens on the order of the inter-particle spacing, not the core preset 1.0', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        // Disk spans ~50..550 over 1500 particles => spacing ~25; softening must
        // be far above the core preset value of 1.0 to keep the disk collisionless.
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
        // Mean speed per unit mass should be negligible vs orbital speeds (~300).
        expect(Math.hypot(px, py) / m).toBeLessThan(1e-3);
    });

    it('stays bound when stepped: no mass blow-out, SMBH stays near centre', () => {
        const sim = makeSim('selfgrav');
        sim.initGalaxy();
        const r0 = maxDiskRadius(sim);

        const engine = new BruteForceEngine(sim.state);
        for (let step = 0; step < 80; step++) engine.update(sim.params.dt, sim.params);

        // A few stars on eccentric orbits is fine; a blow-up sends a large
        // fraction past several times the initial radius (pre-fix: ~13%).
        let flung = 0;
        for (let i = 1; i < sim.params.count; i++) {
            const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
            if (r > 3 * r0) flung++;
        }
        expect(flung / (sim.params.count - 1)).toBeLessThan(0.02);

        // The SMBH (index 0) must not be ejected from the disk.
        expect(Math.hypot(sim.state.positionX[0], sim.state.positionY[0])).toBeLessThan(r0);
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
