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
 * This file is the home for all accretion-preset tests; further phases add the
 * adaptive-timestep and high-central-mass (Keplerian/stability/glow) checks here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulationManager, ENGINE_PRESETS } from './SimulationManager';

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

describe('SimulationManager - accretion preset baseline', () => {
    it('keeps the preset softening (1.0) and an unequal Salpeter mass spectrum', () => {
        const sim = makeSim('accretion');
        sim.initGalaxy();

        expect(sim.params.softening).toBe(1.0);
        expect(sim.diskMass).toBe(0);
        // The accretion preset uses a live index-0 SMBH particle, not the analytic
        // fixed-BH term, so the latter stays off.
        expect(sim.params.blackHoleMass).toBe(0);

        // The adaptive timestep is a no-op for the accretion preset: dt stays the
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
