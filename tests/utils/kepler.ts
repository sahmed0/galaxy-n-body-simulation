/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Analytic two-body / Kepler reference helpers and the conserved diagnostics
 * (energy, angular momentum) the integrator tests measure against.
 */
import { pairwiseAccel, type Accel } from '../../src/physics/kernels';
import type { SoAState } from './soa';

/**
 * Circular relative orbital speed for a two-body system of total mass `Mtot` at
 * separation `r`: `v = √(G·Mtot/r)`.
 */
export function circularVelocity(Mtot: number, r: number, G: number): number {
    return Math.sqrt((G * Mtot) / r);
}

/**
 * Orbital period of a two-body system of total mass `Mtot` and semi-major axis
 * (here: separation `r`): `T = 2π·√(r³/(G·Mtot))`.
 */
export function orbitalPeriod(Mtot: number, r: number, G: number): number {
    return 2 * Math.PI * Math.sqrt((r * r * r) / (G * Mtot));
}

/**
 * Total mechanical energy `E = ½Σ mᵢvᵢ² − Σ_{i<j} G·mᵢmⱼ/rᵢⱼ` (Newtonian /
 * unsoftened potential). Valid for the analytic tests because ε ≪ r at every
 * radius sampled, so the softened-vs-unsoftened mismatch is ~(ε/r)², negligible.
 */
export function totalEnergy(
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    vx: ArrayLike<number>,
    vy: ArrayLike<number>,
    mass: ArrayLike<number>,
    n: number,
    G: number,
): number {
    let ke = 0;
    for (let i = 0; i < n; i++) {
        ke += 0.5 * mass[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
    }
    let pe = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            const r = Math.sqrt(dx * dx + dy * dy);
            pe -= (G * mass[i] * mass[j]) / r;
        }
    }
    return ke + pe;
}

/**
 * Total (scalar, z-component) angular momentum about the origin:
 * `L = Σ mᵢ(xᵢ·vyᵢ − yᵢ·vxᵢ)`.
 */
export function angularMomentum(
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    vx: ArrayLike<number>,
    vy: ArrayLike<number>,
    mass: ArrayLike<number>,
    n: number,
): number {
    let L = 0;
    for (let i = 0; i < n; i++) {
        L += mass[i] * (px[i] * vy[i] - py[i] * vx[i]);
    }
    return L;
}

/**
 * Velocities synchronized to the same time as the positions. In kick-then-drift
 * leapfrog the stored velocity lags the position by half a step (after a full step
 * we hold x at t and v at t−dt/2), so the naive energy/L oscillate at O(dt). A
 * forward half-kick `v + a·dt/2` (a evaluated at the current positions) brings v
 * onto x's time, leaving the genuine O(dt²) symplectic band. Returns fresh arrays;
 * does not mutate the input state.
 *
 * @param state - The SoA state (read-only here).
 * @param dt - Time step.
 * @param G - Gravitational constant.
 * @param softeningSq - Squared Plummer softening length (ε²).
 */
export function synchronizedVelocities(
    state: SoAState,
    dt: number,
    G: number,
    softeningSq: number,
): { vx: Float64Array; vy: Float64Array } {
    const { n, px, py, vx, vy, mass } = state;
    const vxs = new Float64Array(n);
    const vys = new Float64Array(n);
    const acc: Accel = { ax: 0, ay: 0 };
    for (let i = 0; i < n; i++) {
        pairwiseAccel(px, py, mass, n, i, G, softeningSq, acc);
        vxs[i] = vx[i] + acc.ax * dt * 0.5;
        vys[i] = vy[i] + acc.ay * dt * 0.5;
    }
    return { vx: vxs, vy: vys };
}

/**
 * Total energy with the velocity synchronized to the position
 * (see {@link synchronizedVelocities}). This is the quantity with the bounded
 * O(dt²) symplectic band, used for the no-secular-drift assertion.
 */
export function synchronizedEnergy(
    state: SoAState,
    dt: number,
    G: number,
    softeningSq: number,
): number {
    const { vx, vy } = synchronizedVelocities(state, dt, G, softeningSq);
    return totalEnergy(state.px, state.py, vx, vy, state.mass, state.n, G);
}

/**
 * Total angular momentum with the velocity synchronized to the position
 * (see {@link synchronizedVelocities}).
 */
export function synchronizedAngularMomentum(
    state: SoAState,
    dt: number,
    G: number,
    softeningSq: number,
): number {
    const { vx, vy } = synchronizedVelocities(state, dt, G, softeningSq);
    return angularMomentum(state.px, state.py, vx, vy, state.mass, state.n);
}
