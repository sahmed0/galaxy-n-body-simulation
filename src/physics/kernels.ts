/**
 * Copyright (c) 2026 Sajid Ahmed
 */
/**
 * Pure physics kernels: the single source of truth for the pairwise gravity law
 * and the leapfrog (kick-drift) integrator steps. Engines (brute force, Barnes-Hut)
 * call these so the only thing differing between backends is the spatial
 * approximation, never the force formula.
 *
 * Design rule (non-negotiable): kernels produce **acceleration** - no `dt`, no
 * `mass[i]` factor folded in. The integrator applies `dt` separately via
 * {@link applyKick}/{@link applyDrift}. This lets tests compare accelerations directly.
 *
 * The force kernels write into a caller-owned {@link Accel} (`out`) rather than
 * returning a fresh object, so the per-step tree walk / O(N²) loop allocates
 * nothing in steady state. Each call **overwrites** `out.ax`/`out.ay`.
 *
 * Read-only position/mass arrays are typed {@link ArrayLike} so the same kernel
 * serves production (`Float32Array`) and the analytic tests (`Float64Array`).
 */

/** A 2-D acceleration returned by the force kernels. */
export interface Accel {
    ax: number;
    ay: number;
}

/** Any indexable, mutable float buffer the integrator can write back into. */
export type MutableFloatArray = Float32Array | Float64Array | number[];

/**
 * Newton pairwise gravitational acceleration on body `i` from all other bodies
 * `j ∈ [0, n), j ≠ i`, with Plummer softening. Writes the **acceleration** on `i`
 * into `out` (no `dt`, no `mass[i]` factor).
 *
 * Per pair: `distSq = dx² + dy² + softeningSq`, `dist = √distSq`,
 * `inv = G·mass[j] / (distSq·dist)`, contributing `inv·dx`, `inv·dy`. Sums are
 * accumulated in float64 locals regardless of the input array precision.
 *
 * @param px - X positions.
 * @param py - Y positions.
 * @param mass - Per-body masses (only `mass[j]` of the sources matters).
 * @param n - Number of bodies to sum over (`[0, n)`).
 * @param i - Index of the body the acceleration is computed for.
 * @param G - Gravitational constant.
 * @param softeningSq - Squared Plummer softening length (ε²).
 * @param out - Overwritten with the acceleration `{ax, ay}` on body `i`.
 */
export function pairwiseAccel(
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    mass: ArrayLike<number>,
    n: number,
    i: number,
    G: number,
    softeningSq: number,
    out: Accel,
): void {
    const xi = px[i];
    const yi = py[i];
    let ax = 0;
    let ay = 0;
    for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = px[j] - xi;
        const dy = py[j] - yi;
        const distSq = dx * dx + dy * dy + softeningSq;
        const dist = Math.sqrt(distSq);
        const inv = (G * mass[j]) / (distSq * dist);
        ax += inv * dx;
        ay += inv * dy;
    }
    out.ax = ax;
    out.ay = ay;
}

/**
 * Dark-matter halo acceleration on a body at `(x, y)`: an isothermal halo pulling
 * inward toward the origin. Magnitude `dmStrength² · r / (r² + rcore²)`, directed
 * along `-r̂`. Writes the **acceleration** into `out` (no `dt`).
 *
 * The radial `dist` cancels analytically, leaving only squared terms (no sqrt):
 * `aBase = dmStrength² / (r² + rcore²)`, contributing `-x·aBase`, `-y·aBase`.
 *
 * @param x - X position.
 * @param y - Y position.
 * @param dmStrength - Halo velocity scale (asymptotic circular speed).
 * @param dmCoreRadius - Core radius `rcore` softening the centre.
 * @param out - Overwritten with the inward acceleration `{ax, ay}`.
 */
export function darkMatterAccel(
    x: number,
    y: number,
    dmStrength: number,
    dmCoreRadius: number,
    out: Accel,
): void {
    const distSq = x * x + y * y;
    const aBase = (dmStrength * dmStrength) / (distSq + dmCoreRadius * dmCoreRadius);
    out.ax = -x * aBase;
    out.ay = -y * aBase;
}

/**
 * Supermassive-black-hole central acceleration on a body at `(x, y)` from a point
 * mass at the origin, with Plummer softening. Magnitude `G·M / (r² + ε²)^{3/2} · r`,
 * directed inward along `-r̂`. Writes the **acceleration** into `out` (no `dt`).
 *
 * `distSq = r² + ε²`, `dist = √distSq`, `aBase = G·M / (distSq·dist)`, contributing
 * `-x·aBase`, `-y·aBase`. As `ε → 0` this is Keplerian: `|a|·r² → G·M`.
 *
 * @param x - X position.
 * @param y - Y position.
 * @param G - Gravitational constant.
 * @param mass - Central black-hole mass `M`.
 * @param smbhSoftening - Plummer softening length `ε`.
 * @param out - Overwritten with the inward acceleration `{ax, ay}`.
 */
export function smbhAccel(
    x: number,
    y: number,
    G: number,
    mass: number,
    smbhSoftening: number,
    out: Accel,
): void {
    const distSq = x * x + y * y + smbhSoftening * smbhSoftening;
    const dist = Math.sqrt(distSq);
    const aBase = (G * mass) / (distSq * dist);
    out.ax = -x * aBase;
    out.ay = -y * aBase;
}

/**
 * Leapfrog kick: advances the velocity of body `i` by `accel · dt`.
 * @param vx - X velocities (mutated in place).
 * @param vy - Y velocities (mutated in place).
 * @param i - Body index.
 * @param ax - X acceleration.
 * @param ay - Y acceleration.
 * @param dt - Time step.
 */
export function applyKick(
    vx: MutableFloatArray,
    vy: MutableFloatArray,
    i: number,
    ax: number,
    ay: number,
    dt: number,
): void {
    vx[i] += ax * dt;
    vy[i] += ay * dt;
}

/**
 * Leapfrog drift: advances the position of body `i` by `velocity · dt`.
 * @param px - X positions (mutated in place).
 * @param py - Y positions (mutated in place).
 * @param vx - X velocities.
 * @param vy - Y velocities.
 * @param i - Body index.
 * @param dt - Time step.
 */
export function applyDrift(
    px: MutableFloatArray,
    py: MutableFloatArray,
    vx: ArrayLike<number>,
    vy: ArrayLike<number>,
    i: number,
    dt: number,
): void {
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
}
