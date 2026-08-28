/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Structure-of-Arrays test state + a leapfrog stepper that drives the *production*
 * kernels (`pairwiseAccel`/`applyKick`/`applyDrift`). The integrator under test is
 * therefore the exact one the engines use; only the storage differs.
 *
 * Storage is `Float64Array`, NOT the production `Float32Array`. The analytic
 * conservation tests assert angular momentum to ~1e-6 relative over 10^4 steps,
 * which is below the float32 round-walk (~6e-8·√1e4 ≈ 6e-6); float32 storage would
 * mask the symplectic property we are trying to verify. Production float32 behaviour
 * stays covered by the green selfgrav/accretion preset tests.
 */
import { pairwiseAccel, applyKick, applyDrift, type Accel } from '../../src/physics/kernels';

/** A single body's initial phase-space coordinates + mass. */
export interface Body {
    x: number;
    y: number;
    vx: number;
    vy: number;
    m: number;
}

/** Plain SoA particle state backed by Float64Arrays. */
export interface SoAState {
    n: number;
    px: Float64Array;
    py: Float64Array;
    vx: Float64Array;
    vy: Float64Array;
    mass: Float64Array;
}

/** Builds an {@link SoAState} from a list of bodies. */
export function makeSoA(bodies: Body[]): SoAState {
    const n = bodies.length;
    const state: SoAState = {
        n,
        px: new Float64Array(n),
        py: new Float64Array(n),
        vx: new Float64Array(n),
        vy: new Float64Array(n),
        mass: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
        state.px[i] = bodies[i].x;
        state.py[i] = bodies[i].y;
        state.vx[i] = bodies[i].vx;
        state.vy[i] = bodies[i].vy;
        state.mass[i] = bodies[i].m;
    }
    return state;
}

/**
 * Advances the state one leapfrog (kick-drift) step: kick every velocity by the
 * acceleration at the current positions, then drift every position by the kicked
 * velocity - the same order as {@link BruteForceEngine.update}. Velocities are
 * assumed half a step staggered ahead of positions (set up by the caller's IC).
 *
 * @param state - The SoA state, mutated in place.
 * @param dt - Time step.
 * @param G - Gravitational constant.
 * @param softeningSq - Squared Plummer softening length (ε²).
 */
export function leapfrogStep(
    state: SoAState,
    dt: number,
    G: number,
    softeningSq: number,
): void {
    const { n, px, py, vx, vy, mass } = state;
    const acc: Accel = { ax: 0, ay: 0 };
    for (let i = 0; i < n; i++) {
        pairwiseAccel(px, py, mass, n, i, G, softeningSq, acc);
        applyKick(vx, vy, i, acc.ax, acc.ay, dt);
    }
    for (let i = 0; i < n; i++) {
        applyDrift(px, py, vx, vy, i, dt);
    }
}
