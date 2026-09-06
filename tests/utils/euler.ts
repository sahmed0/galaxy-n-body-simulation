/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Forward (explicit) Euler stepper over the SAME pairwise force law as the
 * leapfrog kernel - the non-symplectic foil. Used only by tests to demonstrate the
 * secular energy growth that leapfrog avoids; there is no production Euler engine.
 */
import { pairwiseAccel, type Accel } from '../../src/physics/kernels';
import type { SoAState } from './soa';

/**
 * One explicit forward-Euler step: both updates read the *current* state.
 * Acceleration is snapshotted at the current positions, positions are drifted with
 * the OLD velocities (`x += v·dt`), then velocities are kicked (`v += a·dt`).
 * Because x is not advanced with the updated v, the scheme is not symplectic and
 * energy drifts secularly.
 *
 * @param state - The SoA state, mutated in place.
 * @param dt - Time step.
 * @param G - Gravitational constant.
 * @param softeningSq - Squared Plummer softening length (ε²).
 */
export function eulerStep(
    state: SoAState,
    dt: number,
    G: number,
    softeningSq: number,
): void {
    const { n, px, py, vx, vy, mass } = state;
    // Snapshot accelerations from the current positions before anything moves.
    const ax = new Float64Array(n);
    const ay = new Float64Array(n);
    const a: Accel = { ax: 0, ay: 0 };
    for (let i = 0; i < n; i++) {
        pairwiseAccel(px, py, mass, n, i, G, softeningSq, a);
        ax[i] = a.ax;
        ay[i] = a.ay;
    }
    // Drift positions with the OLD velocities (explicit, not semi-implicit).
    for (let i = 0; i < n; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
    }
    // Kick velocities with the snapshotted accelerations.
    for (let i = 0; i < n; i++) {
        vx[i] += ax[i] * dt;
        vy[i] += ay[i] * dt;
    }
}
