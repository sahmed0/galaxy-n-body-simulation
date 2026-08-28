/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Analytic verification of the leapfrog integrator (the shared `kernels.ts` force
 * law + kick/drift steps). Three claims:
 *   1. A two-body circular orbit returns to its starting position after one period.
 *   2. On a Kepler ellipse the synchronized energy stays in a bounded band with no
 *      secular trend, and angular momentum is conserved - the symplectic property.
 *   3. Forward Euler over the SAME force law drifts secularly: leapfrog's band is
 *      far smaller than Euler's drift, demonstrating symplecticity is what matters.
 *
 * Everything runs on plain SoA Float64Arrays driven through the production kernels.
 */
import { describe, it, expect } from 'vitest';
import { pairwiseAccel, type Accel } from '../../src/physics/kernels';
import { makeSoA, leapfrogStep, type Body, type SoAState } from '../utils/soa';
import { eulerStep } from '../utils/euler';
import {
    orbitalPeriod,
    circularVelocity,
    totalEnergy,
    synchronizedEnergy,
    synchronizedAngularMomentum,
} from '../utils/kepler';

const G = 1;
const SOFT = 1e-6;
const SOFT_SQ = SOFT * SOFT;

/** Staggers every velocity back half a step (v(0) -> v(-dt/2)) for kick-first leapfrog. */
function staggerHalfStep(state: SoAState, dt: number): void {
    const { n, px, py, mass, vx, vy } = state;
    const ax = new Float64Array(n);
    const ay = new Float64Array(n);
    const a: Accel = { ax: 0, ay: 0 };
    for (let i = 0; i < n; i++) {
        pairwiseAccel(px, py, mass, n, i, G, SOFT_SQ, a);
        ax[i] = a.ax;
        ay[i] = a.ay;
    }
    for (let i = 0; i < n; i++) {
        vx[i] -= ax[i] * dt * 0.5;
        vy[i] -= ay[i] * dt * 0.5;
    }
}

/** Least-squares slope of y vs its integer index 0..N-1. */
function regressionSlope(y: number[]): number {
    const n = y.length;
    const meanX = (n - 1) / 2;
    let meanY = 0;
    for (const v of y) meanY += v;
    meanY /= n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const dx = i - meanX;
        num += dx * (y[i] - meanY);
        den += dx * dx;
    }
    return num / den;
}

/** Relative peak-to-peak band of a series about its mean. */
function relativeBand(y: number[]): number {
    let min = Infinity;
    let max = -Infinity;
    let mean = 0;
    for (const v of y) {
        if (v < min) min = v;
        if (v > max) max = v;
        mean += v;
    }
    mean /= y.length;
    return (max - min) / Math.abs(mean);
}

/**
 * Two equal masses on a circular orbit about their common COM at the origin.
 * Separation `r`, masses `m`; each body sits at ±r/2 with perpendicular speed
 * v_body = √(G·m/(2r)) and zero net momentum.
 */
function circularTwoBody(m: number, r: number): { bodies: Body[]; period: number } {
    const vBody = Math.sqrt((G * m) / (2 * r));
    const bodies: Body[] = [
        { x: -r / 2, y: 0, vx: 0, vy: -vBody, m },
        { x: r / 2, y: 0, vx: 0, vy: vBody, m },
    ];
    return { bodies, period: orbitalPeriod(2 * m, r, G) };
}

describe('leapfrog integrator - two-body circular orbit', () => {
    it('returns to its starting position after one period', () => {
        const m = 1;
        const r = 1;
        const { bodies, period } = circularTwoBody(m, r);
        const state = makeSoA(bodies);

        const nSteps = 1000;
        const dt = period / nSteps;
        staggerHalfStep(state, dt);

        const x0 = Float64Array.from(state.px);
        const y0 = Float64Array.from(state.py);
        for (let s = 0; s < nSteps; s++) leapfrogStep(state, dt, G, SOFT_SQ);

        for (let i = 0; i < state.n; i++) {
            const err = Math.hypot(state.px[i] - x0[i], state.py[i] - y0[i]);
            expect(err).toBeLessThan(1e-2 * r);
        }
    });
});

/**
 * Two-body Kepler ellipse: a heavy central mass and a light companion, COM at the
 * origin with zero net momentum, started at separation `r0` with relative speed
 * below circular (f<1) so the orbit is an ellipse.
 */
function keplerEllipse(): { state: SoAState; period: number } {
    const m1 = 1000;
    const m2 = 1;
    const M = m1 + m2;
    const r0 = 1;
    const f = 0.8; // sub-circular -> r0 is apoapsis, orbit is an ellipse
    const vRel = f * circularVelocity(M, r0, G);

    // COM at origin: m1 at -d1, m2 at +d2 with m1*d1 = m2*d2 and d1+d2 = r0.
    const d1 = (m2 / M) * r0;
    const d2 = (m1 / M) * r0;
    // Zero net momentum: m1*v1 + m2*v2 = 0, |v2 - v1| = vRel (perpendicular).
    const v1 = -(m2 / M) * vRel;
    const v2 = (m1 / M) * vRel;

    const state = makeSoA([
        { x: -d1, y: 0, vx: 0, vy: v1, m: m1 },
        { x: d2, y: 0, vx: 0, vy: v2, m: m2 },
    ]);
    return { state, period: orbitalPeriod(M, r0, G) };
}

describe('leapfrog integrator - Kepler ellipse conservation', () => {
    it('keeps synchronized energy bounded with no secular trend, and conserves L', () => {
        const { state, period } = keplerEllipse();
        // 400 steps/orbit keeps the O(dt²) energy band comfortably under 1e-3
        // (measured ~5e-4); the band is deterministic (no RNG), so this is stable.
        const dt = period / 400;
        const nSteps = 10000;
        staggerHalfStep(state, dt);

        const energy: number[] = [];
        const L0 = synchronizedAngularMomentum(state, dt, G, SOFT_SQ);
        let maxRelL = 0;
        for (let s = 0; s < nSteps; s++) {
            leapfrogStep(state, dt, G, SOFT_SQ);
            energy.push(synchronizedEnergy(state, dt, G, SOFT_SQ));
            const L = synchronizedAngularMomentum(state, dt, G, SOFT_SQ);
            maxRelL = Math.max(maxRelL, Math.abs(L / L0 - 1));
        }

        const band = relativeBand(energy);
        // Drift of the linear fit across the whole run, relative to the mean.
        const meanE = energy.reduce((a, b) => a + b, 0) / energy.length;
        const slopeRel = Math.abs((regressionSlope(energy) * nSteps) / meanE);

        expect(band).toBeLessThan(1e-3);
        // No secular trend: the end-to-end fitted drift is far below the band.
        expect(slopeRel).toBeLessThan(0.1 * band);
        expect(maxRelL).toBeLessThan(1e-6);
    });
});

describe('leapfrog vs forward Euler - symplecticity', () => {
    it("Euler energy drifts secularly while leapfrog's band stays tiny", () => {
        const m = 1;
        const r = 1;
        const { bodies, period } = circularTwoBody(m, r);
        const dt = period / 200;
        const nSteps = 4000; // 20 orbits

        // Leapfrog: synchronized-energy band.
        const lf = makeSoA(bodies);
        staggerHalfStep(lf, dt);
        const lfEnergy: number[] = [];
        for (let s = 0; s < nSteps; s++) {
            leapfrogStep(lf, dt, G, SOFT_SQ);
            lfEnergy.push(synchronizedEnergy(lf, dt, G, SOFT_SQ));
        }
        const lfBand = relativeBand(lfEnergy);

        // Forward Euler over the same force law. Explicit Euler keeps x and v at the
        // same time, so read total energy directly (no half-step stagger - that is a
        // leapfrog-only convention).
        const eu = makeSoA(bodies);
        const baseE = totalEnergy(eu.px, eu.py, eu.vx, eu.vy, eu.mass, eu.n, G);
        let euDrift = 0;
        for (let s = 0; s < nSteps; s++) {
            eulerStep(eu, dt, G, SOFT_SQ);
            const e = totalEnergy(eu.px, eu.py, eu.vx, eu.vy, eu.mass, eu.n, G);
            euDrift = Math.max(euDrift, Math.abs(e / baseE - 1));
        }

        expect(euDrift).toBeGreaterThan(0.1); // Euler visibly drifts
        expect(lfBand).toBeLessThan(0.1 * euDrift); // leapfrog band far smaller
    });
});
