/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Seeded initial-condition builders shared by the energy suites: a self-gravitating
 * cluster in approximate virial balance, plus the primitives it is built from
 * (net-momentum removal, the leapfrog half-step stagger, a direct pairwise
 * accelerator, and a pairwise-potential sum).
 *
 * These live here rather than in a test file because importing one test file from
 * another would re-register the imported file's `describe` blocks into the importer,
 * silently duplicating a whole suite. `tests/utils/` is the established home for
 * shared fixtures (see `rng.ts`, `soa.ts`, `kepler.ts`, `euler.ts`).
 *
 * The potential/force formulas come from `src/physics/energy` (single source of
 * truth) but the summation loops are the tests' own.
 */
import { PhysicsState } from '../../src/physics';
import type { PhysicsParams } from '../../src/physics/types';
import { pairPotential } from '../../src/physics/energy';
import { mulberry32 } from './rng';

/**
 * Removes the net momentum from an SoA velocity pair over `[start, n)` (zero-drift COM).
 * @param state - The state to modify in place.
 * @param start - First index to include.
 */
export function removeNetMomentum(state: PhysicsState, start: number): void {
    const { velocityX: vx, velocityY: vy, mass } = state;
    let px = 0, py = 0, M = 0;
    for (let i = start; i < state.n; i++) {
        px += mass[i] * vx[i];
        py += mass[i] * vy[i];
        M += mass[i];
    }
    const vcx = px / M, vcy = py / M;
    for (let i = start; i < state.n; i++) {
        vx[i] -= vcx;
        vy[i] -= vcy;
    }
}

/**
 * Applies the leapfrog half-step stagger: shifts every velocity back half a step
 * (`v -= a·dt/2`) from the acceleration `accelFn(i)` at the initial positions, so the
 * subsequent kick-drift steps see velocities offset the required half step ahead.
 * @param state - The state to modify in place.
 * @param start - First index to stagger.
 * @param dt - The time step the integrator will run with.
 * @param accelFn - Acceleration on body `i` at the initial positions.
 */
export function staggerHalfStep(
    state: PhysicsState,
    start: number,
    dt: number,
    accelFn: (i: number) => { ax: number; ay: number },
): void {
    const { velocityX: vx, velocityY: vy } = state;
    for (let i = start; i < state.n; i++) {
        const a = accelFn(i);
        vx[i] -= a.ax * dt * 0.5;
        vy[i] -= a.ay * dt * 0.5;
    }
}

/**
 * Softened pairwise potential of the active subsystem (helper for virial scaling).
 * @param state - The state to measure.
 * @param params - Supplies `gravity` and `softening`.
 * @param start - First active index.
 * @param activeCount - One past the last active index.
 * @returns The summed pairwise potential energy.
 */
export function potentialOnly(
    state: PhysicsState,
    params: PhysicsParams,
    start: number,
    activeCount: number,
): number {
    const { positionX: px, positionY: py, mass } = state;
    const epsSq = params.softening * params.softening;
    let pe = 0;
    for (let i = start; i < activeCount; i++) {
        for (let j = i + 1; j < activeCount; j++) {
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            pe += pairPotential(dx * dx + dy * dy, epsSq, params.gravity, mass[i], mass[j]);
        }
    }
    return pe;
}

/**
 * Direct pairwise acceleration on body `i` over `[start, n)` (for the half-step stagger).
 * @param state - The state to measure.
 * @param params - Supplies `gravity` and `softening`.
 * @param start - First source index.
 * @param n - One past the last source index.
 * @param i - The body the acceleration is computed for.
 * @returns The acceleration on body `i`.
 */
export function pairAccel(
    state: PhysicsState,
    params: PhysicsParams,
    start: number,
    n: number,
    i: number,
): { ax: number; ay: number } {
    const { positionX: px, positionY: py, mass } = state;
    const epsSq = params.softening * params.softening;
    let ax = 0, ay = 0;
    for (let j = start; j < n; j++) {
        if (j === i) continue;
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const distSq = dx * dx + dy * dy + epsSq;
        const inv = (params.gravity * mass[j]) / (distSq * Math.sqrt(distSq));
        ax += inv * dx;
        ay += inv * dy;
    }
    return { ax, ay };
}

/**
 * Builds a seeded, centrally-concentrated 2-D cluster of `n` equal-mass bodies in
 * approximate virial balance: positions from a smooth centrally-peaked profile, random
 * isotropic velocities rescaled so KE = ½|PE|, net momentum removed, then half-step
 * staggered for leapfrog. No halo/BH - pure self-gravity.
 * @param n - Number of bodies.
 * @param seed - Seed for the mulberry32 draw.
 * @param params - Supplies `gravity`, `softening`, and the `dt` the stagger uses.
 * @returns The initialised state.
 */
export function makeVirialCluster(n: number, seed: number, params: PhysicsParams): PhysicsState {
    const rng = mulberry32(seed);
    const state = new PhysicsState(n);
    const scale = 5.0;
    for (let i = 0; i < n; i++) {
        // r = scale·√(−ln(1−u)) - an exponential-in-r² blob, smooth and bounded.
        const r = scale * Math.sqrt(-Math.log(1 - rng()));
        const theta = rng() * 2 * Math.PI;
        state.positionX[i] = r * Math.cos(theta);
        state.positionY[i] = r * Math.sin(theta);
        state.velocityX[i] = rng() * 2 - 1;
        state.velocityY[i] = rng() * 2 - 1;
        state.mass[i] = 1.0;
    }

    // Rescale velocities to KE = ½|PE| (2-D virial balance for the softened field).
    const pe = potentialOnly(state, params, 0, n);
    let ke = 0;
    for (let i = 0; i < n; i++) {
        ke += 0.5 * state.mass[i] * (state.velocityX[i] ** 2 + state.velocityY[i] ** 2);
    }
    const targetKE = 0.5 * Math.abs(pe);
    const vScale = Math.sqrt(targetKE / ke);
    for (let i = 0; i < n; i++) {
        state.velocityX[i] *= vScale;
        state.velocityY[i] *= vScale;
    }

    removeNetMomentum(state, 0);
    staggerHalfStep(state, 0, params.dt, (i) => pairAccel(state, params, 0, n, i));
    return state;
}
