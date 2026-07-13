/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for the accretion ("accretion") initial conditions in
 * {@link SimulationManager}. The accretion preset is an SMBH accretion disk in the
 * collisionless (ballistic) limit: a dominant central black hole as a *live*
 * particle at index 0, surrounded by a thin annulus of Salpeter-sampled test
 * particles that orbit the SMBH + dark-matter halo and shear into rings. The disk
 * is light (diskMass = 0): the particles carry their raw Salpeter masses but do
 * not self-gravitate, so there is no fixed-BH analytic term ({@link
 * SimulationManager.params.blackHoleMass} stays 0) and no measured rotation curve.
 * initGalaxy()/BruteForceEngine touch no DOM or GPU, so they are driven directly.
 *
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SimulationManager,
    presetFor,
    MIN_DT_FRACTION,
    ACCRETION_BH_MASS,
    GALAXY_CENTRAL_BH_MASS,
    DISK_INNER_RADIUS,
    GALAXY_RADIUS,
} from './SimulationManager';
import { BruteForceEngine } from '../physics';

// Reaches the private analytic rotation curve (TS `private` is compile-time only)
// so the tests can sample v_c(r) about the central SMBH directly.
interface AccretionInternals {
    radialAcc(r: number): number;
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

/** Builds a manager with a cheap star count on the accretion preset. */
function makeSim(mode: 'accretion' | 'galaxy', count = 1500) {
    const sim = new SimulationManager();
    sim.params.count = count;
    sim.params.preset = mode;
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

/**
 * Peak angular frequency Omega_max = max over the annulus of v_c(r)/r, sampled
 * from the analytic accretion field. Mirrors computeAdaptiveTimestep's grid.
 */
function maxOmega(sim: SimulationManager): number {
    const s = sim as unknown as AccretionInternals;
    const rMin = DISK_INNER_RADIUS;
    const rMax = DISK_INNER_RADIUS + GALAXY_RADIUS;
    const N = 128;
    let omegaMax = 0;
    for (let k = 0; k < N; k++) {
        const r = rMin + ((rMax - rMin) * k) / (N - 1);
        if (r <= 0) continue;
        const vCirc = Math.sqrt(Math.max(s.radialAcc(r) * r, 0));
        omegaMax = Math.max(omegaMax, vCirc / r);
    }
    return omegaMax;
}

describe('SimulationManager - accretion preset baseline', () => {
    it('keeps the preset softening (1.0) and an unequal Salpeter mass spectrum', () => {
        const sim = makeSim('accretion');
        sim.initGalaxy();

        expect(sim.params.softening).toBe(1.0);
        expect(sim.diskMass).toBe(0);
        // The accretion preset uses a live index-0 SMBH particle, not the analytic
        // fixed-BH term, so the latter stays off.
        expect(sim.params.blackHoleMass).toBe(0);

        // With the high central mass the adaptive timestep shrinks dt below the
        // fixed preset value to resolve the fast inner orbits.
        const presetDt = presetFor(sim.params.engineType).timeStep;
        expect(sim.params.dt).toBeLessThanOrEqual(presetDt);
        // The fastest orbit (peak angular frequency over the annulus) must be
        // resolved by at least ~30 leapfrog steps.
        const stepsPerOrbit = (2 * Math.PI / maxOmega(sim)) / sim.params.dt;
        expect(stepsPerOrbit).toBeGreaterThanOrEqual(30);

        // Salpeter sampling => a wide spread of disk masses (not all equal).
        let min = Infinity, max = -Infinity;
        for (let i = 1; i < sim.params.count; i++) {
            min = Math.min(min, sim.state.mass[i]);
            max = Math.max(max, sim.state.mass[i]);
        }
        expect(max / min).toBeGreaterThan(10);
    });
});

describe('SimulationManager - accretion adaptive timestep', () => {
    it('derives a finite dt within [floor, presetDt] for the accretion preset', () => {
        const sim = makeSim('accretion');
        sim.initGalaxy();
        const presetDt = presetFor(sim.params.engineType).timeStep;
        expect(Number.isFinite(sim.params.dt)).toBe(true);
        expect(sim.params.dt).toBeGreaterThan(0);
        expect(sim.params.dt).toBeLessThanOrEqual(presetDt);
        expect(sim.params.dt).toBeGreaterThanOrEqual(presetDt * MIN_DT_FRACTION);
    });
});

describe('SimulationManager - accretion central SMBH', () => {
    it('puts ACCRETION_BH_MASS on the central particle and gives it the warm glow', () => {
        const sim = makeSim('accretion');
        sim.initGalaxy();

        expect(sim.state.mass[0]).toBe(ACCRETION_BH_MASS);
        // Sanity: the split actually raised the accretion mass above the galaxy's.
        expect(sim.state.mass[0]).toBeGreaterThan(GALAXY_CENTRAL_BH_MASS);

        // Warm glow (RGB ~ 1, 1, 0.85), not the old invisible black point.
        expect(sim.state.colors[0]).toBe(1);
        expect(sim.state.colors[1]).toBe(1);
        // Float32 storage, so compare approximately.
        expect(sim.state.colors[2]).toBeCloseTo(0.85);
    });

    it('has a Keplerian v_c proportional to 1/sqrt(r) about the SMBH (DM off)', () => {
        const sim = makeSim('accretion');
        // Isolate the central mass: with no halo, radialAcc(r)*r = G*M is constant
        // for a pure point mass (softening 1.0 << r makes the deviation negligible).
        // Force DM=0 explicitly - the P4 per-preset default is not in yet.
        sim.params.dmStrength = 0;
        sim.initGalaxy();

        // radialAcc is the centripetal acceleration a = v_c^2 / r, so v_c^2 = a*r
        // and the Keplerian invariant v_c^2 * r = a * r^2 = G*M is constant.
        // (Softening 1.0 << r makes the deviation ~(eps/r)^2, negligible.)
        const s = sim as unknown as AccretionInternals;
        const radii = [60, 150, 300, 500];
        const gm = radii.map((r) => s.radialAcc(r) * r * r);
        const mean = gm.reduce((a, b) => a + b, 0) / gm.length;
        for (const v of gm) {
            // For pure Kepler this is G*M = constant; 3% is comfortable headroom.
            expect(Math.abs(v / mean - 1)).toBeLessThan(0.03);
        }
    });

    it('stays bound as a clean Keplerian disk when stepped', () => {
        const sim = makeSim('accretion', 1000);
        sim.params.dmStrength = 0;
        sim.initGalaxy();

        // Resolve ~1.5 inner orbits: T_in = 2*pi*r_in / v_c(r_in).
        const s = sim as unknown as AccretionInternals;
        const rIn = DISK_INNER_RADIUS;
        const vIn = Math.sqrt(s.radialAcc(rIn) * rIn);
        const Tin = (2 * Math.PI * rIn) / vIn;
        const steps = Math.ceil((1.5 * Tin) / sim.params.dt);

        const r0 = maxRadius(sim);
        const rms0 = rmsRadius(sim);

        const engine = new BruteForceEngine(sim.state);
        for (let step = 0; step < steps; step++) engine.step(sim.params.dt, sim.params);

        // Keplerian orbits are clean closed ellipses: very few stars get flung out,
        // and the disk neither expands nor collapses appreciably (tighter than the
        // self-gravitating disk's bands).
        let flung = 0;
        for (let i = 0; i < sim.params.count; i++) {
            const r = Math.hypot(sim.state.positionX[i], sim.state.positionY[i]);
            if (r > 3 * r0) flung++;
        }
        expect(flung / sim.params.count).toBeLessThan(0.01);

        const rms1 = rmsRadius(sim);
        expect(rms1 / rms0).toBeGreaterThan(0.8);
        expect(rms1 / rms0).toBeLessThan(1.25);

        // No particle should have gone non-finite.
        for (let i = 0; i < sim.params.count; i++) {
            expect(Number.isFinite(sim.state.positionX[i])).toBe(true);
            expect(Number.isFinite(sim.state.positionY[i])).toBe(true);
        }
    });
});
