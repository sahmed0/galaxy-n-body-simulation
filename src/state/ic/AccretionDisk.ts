/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { massToColor } from '../../utils';
import { presetFor } from '../enginePresets';
import type { SimulationParams } from '../params';
import {
    DISK_INNER_RADIUS,
    GALAXY_RADIUS,
    MIN_DT_FRACTION,
    STEPS_PER_ORBIT,
    haloAcc,
    sampleSalpeterMass,
    type IcContext,
    type InitialConditions,
} from './common';

/**
 * Mass of the accretion preset's central SMBH (the live particle at index 0 and
 * the source of {@link AccretionDisk.radialAcc}'s analytic Keplerian field).
 *
 * Over the test-particle annulus R in [DISK_INNER_RADIUS, DISK_INNER_RADIUS +
 * GALAXY_RADIUS] = [10, 510] at gravity = 1, this gives inner circular speed
 * v_c(10) = sqrt(1e6/10) ~ 316 and outer v_c(510) ~ 44 - clearly Keplerian
 * (v_c proportional to 1/sqrt(r)), with dramatic inner shear, and dwarfing the
 * total mass of the thousands of Salpeter test particles (0.1-50 each) so they
 * behave as a collisionless disk orbiting a dominant point mass. The adaptive
 * timestep ({@link AccretionDisk.adaptiveTimestep}) shrinks dt to keep the fast
 * inner orbits resolved.
 */
export const ACCRETION_BH_MASS = 1.001e6;

/**
 * Accretion preset: a central SMBH (index 0) surrounded by a thin annulus of
 * Salpeter-sampled test particles. The disk is light, so it behaves as test
 * particles orbiting the SMBH + halo and relaxes into concentric rings.
 */
export class AccretionDisk implements InitialConditions {
    readonly preset = 'accretion' as const;

    /**
     * The test-particle disk is massless to the field - the SMBH at index 0
     * dominates it - so there is no calibrated disk mass to report.
     */
    readonly diskMass = 0;

    /**
     * Builds the disk: pins the SMBH at the origin, seeds the annulus with
     * Salpeter-sampled stars sorted heaviest-first, derives dt from the analytic
     * field and sets every star on a near-circular orbit.
     */
    initialise(ctx: IcContext): void {
        const { params, state, rng } = ctx;

        // The accretion preset uses a live SMBH particle at index 0, so the
        // engines' analytic BH term stays off, and the engine preset softening
        // is already the right scale for a central-mass-dominated disk.
        params.blackHoleMass = 0;
        params.softening = this.effectiveSoftening(params);

        state.positionX[0] = 0;
        state.positionY[0] = 0;
        state.velocityX[0] = 0;
        state.velocityY[0] = 0;
        state.mass[0] = ACCRETION_BH_MASS;
        // Warm glow for the dominant central SMBH (instead of an invisible black point).
        state.colors[0] = 1;
        state.colors[1] = 1;
        state.colors[2] = 0.85;

        const particles: { x: number; y: number; mass: number; r: number; g: number; b: number; dist: number }[] = [];

        for (let i = 1; i < params.count; i++) {
            const angle = rng() * Math.PI * 2;
            const dist = DISK_INNER_RADIUS + rng() * GALAXY_RADIUS;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist;

            const mass = sampleSalpeterMass(rng);
            const [r, g, b] = massToColor(mass);
            particles.push({ x, y, mass, r, g, b, dist });
        }

        particles.sort((a, b) => b.mass - a.mass);

        // Derive a safe dt for the analytic orbital field BEFORE the velocity loop:
        // computeStarVelocity's leapfrog half-step reads params.dt.
        params.dt = this.adaptiveTimestep(params);

        let tempActiveCount = 0;

        for (let i = 1; i < params.count; i++) {
            const p = particles[i - 1];

            state.positionX[i] = p.x;
            state.positionY[i] = p.y;
            state.mass[i] = p.mass;

            state.colors[i * 3 + 0] = p.r;
            state.colors[i * 3 + 1] = p.g;
            state.colors[i * 3 + 2] = p.b;

            if (p.mass >= params.massThreshold) {
                tempActiveCount++;
            }

            this.computeStarVelocity(ctx, i, p.dist);
        }

        // The active set is the index range [0, activeCount). Particle 0 is the
        // central SMBH, so it occupies one slot; add 1 to the count of qualifying
        // heavy stars (indices 1..tempActiveCount) so none are demoted to passive.
        params.activeCount = tempActiveCount + 1;
    }

    /**
     * Re-derives every test-particle velocity from its current radius. Index 0 is
     * the live SMBH and keeps its own velocity; a particle sitting exactly at the
     * origin has no orbital plane, so it is left alone.
     */
    resetVelocities(ctx: IcContext): void {
        const { params, state } = ctx;
        for (let i = 1; i < params.count; i++) {
            const distSq = state.positionX[i] * state.positionX[i] + state.positionY[i] * state.positionY[i];
            const dist = Math.sqrt(distSq);
            if (dist === 0) continue;
            this.computeStarVelocity(ctx, i, dist);
        }
    }

    /**
     * Timestep for the accretion preset: test particles in a static SMBH + halo
     * potential, so only the orbital-resolution limit applies, computed
     * analytically from {@link radialAcc} over the disk annulus. No
     * close-encounter term - the test particles are massless to the field and
     * exert no two-body kicks - and floored at {@link MIN_DT_FRACTION} of the
     * engine preset dt so a mis-scaling can't stall the sim.
     */
    adaptiveTimestep(params: SimulationParams): number {
        const presetDt = presetFor(params.engineType).timeStep;
        // Resolve the fastest orbit about the central SMBH + halo. Sample
        // Omega(r) = vCirc(r)/r analytically over the annulus
        // [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. For a central
        // mass Omega is monotone-decreasing (peak at the inner edge); the grid is
        // just robustness against the halo term.
        const rMin = DISK_INNER_RADIUS;
        const rMax = DISK_INNER_RADIUS + GALAXY_RADIUS;
        const N = 128;
        let omegaMax = 0;
        for (let k = 0; k < N; k++) {
            const r = rMin + ((rMax - rMin) * k) / (N - 1);
            if (r <= 0) continue;
            const vCirc = Math.sqrt(Math.max(this.radialAcc(r, params) * r, 0));
            omegaMax = Math.max(omegaMax, vCirc / r);
        }
        let dt = presetDt; // limit 1: never faster than the preset.
        if (omegaMax > 0) dt = Math.min(dt, (2 * Math.PI / omegaMax) / STEPS_PER_ORBIT);
        // Floor so a pathological choice can't crawl the sim to a halt.
        return Math.max(dt, presetDt * MIN_DT_FRACTION);
    }

    /**
     * Softening for the accretion preset: the engine preset value. The disk is
     * light and the field is dominated by the central point mass, so there is no
     * macro-particle collisionality scale to soften against (unlike the
     * self-gravitating disk).
     */
    effectiveSoftening(params: SimulationParams): number {
        return presetFor(params.engineType).softening;
    }

    /**
     * Total inward radial acceleration on a test particle at radius `r` from the
     * central SMBH plus the dark-matter halo. (The self-gravitating preset uses a
     * *measured* rotation curve instead; see GalaxyDisk.)
     */
    radialAcc(r: number, params: SimulationParams): number {
        const softenedDistSq = r * r + params.softening * params.softening;
        const coreAcc = (params.gravity * ACCRETION_BH_MASS) / softenedDistSq;
        return coreAcc + haloAcc(r, params);
    }

    /**
     * Sets the staggered (leapfrog half-step) velocity for star `i` at radius
     * `dist`: a near-circular orbit about the central SMBH + halo with a little
     * scatter.
     */
    private computeStarVelocity(ctx: IcContext, i: number, dist: number) {
        const { params, state, rng } = ctx;
        const px = state.positionX[i];
        const py = state.positionY[i];
        const r = Math.max(dist, 1e-3);

        // Radial (outward) and tangential (counter-clockwise) unit vectors.
        const ux = px / r;
        const uy = py / r;
        const tx = -uy;
        const ty = ux;

        const aTot = this.radialAcc(r, params);
        const vCirc = Math.sqrt(Math.max(aTot * r, 0));
        const velocity = vCirc * (0.9 + rng() * 0.2);
        const vx = tx * velocity;
        const vy = ty * velocity;

        // Leapfrog half-step offset using the (inward) radial acceleration, so
        // velocity stays staggered half a step ahead of position. The analytic
        // radialAcc already is this test particle's true force, so no O(N^2)
        // pass is needed.
        const ax = -ux * aTot;
        const ay = -uy * aTot;
        state.velocityX[i] = vx + ax * (params.dt / 2);
        state.velocityY[i] = vy + ay * (params.dt / 2);
    }
}
