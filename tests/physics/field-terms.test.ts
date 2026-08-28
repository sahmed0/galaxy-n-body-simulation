/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Analytic verification of the central-field kernels (`darkMatterAccel`, `smbhAccel`)
 * and the Plummer-softening behaviour of `pairwiseAccel`, all against closed form:
 *   1. `smbhAccel` matches `G·M/(r²+ε²)^{3/2}·r` in magnitude, points radially inward,
 *      and satisfies the Keplerian invariant `|a|·r² → G·M` as ε → 0.
 *   2. `darkMatterAccel` matches the isothermal form `dmStrength²·r/(r²+rcore²)` inward.
 *   3. `pairwiseAccel` is finite and → 0 as r → 0 with softening, and → Newtonian
 *      `G·m/r²` for r ≫ ε.
 */
import { describe, it, expect } from 'vitest';
import {
    pairwiseAccel as pairwiseAccelOut,
    darkMatterAccel as darkMatterAccelOut,
    smbhAccel as smbhAccelOut,
    type Accel,
} from '../../src/physics/kernels';

// The kernels now write into a caller-owned Accel. These thin wrappers allocate that
// out-param and return it, so the analytic assertions below can read the result
// directly (per-call allocation is fine in tests).
function pairwiseAccel(
    px: ArrayLike<number>, py: ArrayLike<number>, mass: ArrayLike<number>,
    n: number, i: number, G: number, softeningSq: number,
): Accel {
    const out: Accel = { ax: 0, ay: 0 };
    pairwiseAccelOut(px, py, mass, n, i, G, softeningSq, out);
    return out;
}
function darkMatterAccel(x: number, y: number, dmStrength: number, dmCoreRadius: number): Accel {
    const out: Accel = { ax: 0, ay: 0 };
    darkMatterAccelOut(x, y, dmStrength, dmCoreRadius, out);
    return out;
}
function smbhAccel(x: number, y: number, G: number, mass: number, smbhSoftening: number): Accel {
    const out: Accel = { ax: 0, ay: 0 };
    smbhAccelOut(x, y, G, mass, smbhSoftening, out);
    return out;
}

/** Magnitude of an acceleration. */
function mag(a: { ax: number; ay: number }): number {
    return Math.hypot(a.ax, a.ay);
}

describe('smbhAccel — point-mass central force with Plummer softening', () => {
    const G = 2.5;
    const M = 137.0;
    const eps = 0.3;

    it('matches the closed-form magnitude at several radii', () => {
        for (const r of [1, 3, 10, 50, 200]) {
            const a = smbhAccel(r, 0, G, M, eps);
            const expected = (G * M * r) / Math.pow(r * r + eps * eps, 1.5);
            expect(Math.abs(mag(a) - expected) / expected).toBeLessThan(1e-12);
        }
    });

    it('points radially inward (anti-parallel to the position vector)', () => {
        // Pick an off-axis point; acceleration must be -k·(x,y) for some k>0.
        const x = 7;
        const y = -11;
        const a = smbhAccel(x, y, G, M, eps);
        // Cross product with position must vanish (collinear).
        expect(Math.abs(x * a.ay - y * a.ax)).toBeLessThan(1e-12);
        // Dot product must be negative (inward).
        expect(x * a.ax + y * a.ay).toBeLessThan(0);
    });

    it('satisfies the Keplerian invariant |a|·r² → G·M as ε → 0', () => {
        const r = 25;
        // With ε → 0, |a| = G·M/r², so |a|·r² → G·M independent of r.
        let prevErr = Infinity;
        for (const e of [1.0, 0.1, 0.01, 0.001]) {
            const a = smbhAccel(r, 0, G, M, e);
            const invariant = mag(a) * r * r;
            const err = Math.abs(invariant - G * M) / (G * M);
            expect(err).toBeLessThan(prevErr); // monotone convergence to G·M
            prevErr = err;
        }
        // Tightest ε is essentially exact.
        const aTight = smbhAccel(r, 0, G, M, 1e-6);
        expect(Math.abs(mag(aTight) * r * r - G * M) / (G * M)).toBeLessThan(1e-8);
    });

    it('is finite at the origin (softening regularises the singularity)', () => {
        const a = smbhAccel(0, 0, G, M, eps);
        expect(Number.isFinite(a.ax)).toBe(true);
        expect(Number.isFinite(a.ay)).toBe(true);
        expect(mag(a)).toBe(0);
    });
});

describe('darkMatterAccel — isothermal halo', () => {
    const dmStrength = 4.0;
    const rcore = 50.0;

    it('matches the closed-form isothermal magnitude at several radii', () => {
        for (const r of [1, 25, 50, 100, 500]) {
            const a = darkMatterAccel(r, 0, dmStrength, rcore);
            const expected = (dmStrength * dmStrength * r) / (r * r + rcore * rcore);
            expect(Math.abs(mag(a) - expected) / expected).toBeLessThan(1e-12);
        }
    });

    it('points radially inward', () => {
        const x = 13;
        const y = 29;
        const a = darkMatterAccel(x, y, dmStrength, rcore);
        expect(Math.abs(x * a.ay - y * a.ax)).toBeLessThan(1e-12);
        expect(x * a.ax + y * a.ay).toBeLessThan(0);
    });

    it('rises ~linearly inside the core and falls ~1/r outside', () => {
        // r ≪ rcore: a ≈ dmStrength²·r/rcore²  (linear, rising)
        const inner = darkMatterAccel(1, 0, dmStrength, rcore);
        const innerExpected = (dmStrength * dmStrength * 1) / (rcore * rcore);
        expect(Math.abs(mag(inner) - innerExpected) / innerExpected).toBeLessThan(1e-3);
        // r ≫ rcore: a ≈ dmStrength²/r  (flat rotation curve → falling accel)
        const r = 5000;
        const outer = darkMatterAccel(r, 0, dmStrength, rcore);
        const outerExpected = (dmStrength * dmStrength) / r;
        expect(Math.abs(mag(outer) - outerExpected) / outerExpected).toBeLessThan(1e-3);
    });

    it('vanishes at the origin', () => {
        const a = darkMatterAccel(0, 0, dmStrength, rcore);
        expect(mag(a)).toBe(0);
    });
});

describe('pairwiseAccel — Plummer softening limits', () => {
    const G = 1.5;
    const mj = 10.0;

    // Two bodies: source j=0 at origin (mass mj), receiver i=1 at (r,0) (massless test).
    function accelOnReceiver(r: number, softeningSq: number) {
        const px = [0, r];
        const py = [0, 0];
        const mass = [mj, 0];
        return pairwiseAccel(px, py, mass, 2, 1, G, softeningSq);
    }

    it('approaches Newtonian G·m/r² for r ≫ ε', () => {
        const eps = 0.01;
        const softeningSq = eps * eps;
        for (const r of [10, 100, 1000]) {
            const a = accelOnReceiver(r, softeningSq);
            const newton = (G * mj) / (r * r);
            // Receiver pulled toward the source at the origin → -x direction.
            expect(a.ax).toBeLessThan(0);
            expect(Math.abs(mag(a) - newton) / newton).toBeLessThan(1e-3);
        }
    });

    it('stays finite and → 0 as r → 0 with softening', () => {
        const softeningSq = 1.0; // ε = 1
        let prev = Infinity;
        for (const r of [0.5, 0.1, 0.01, 0.0]) {
            const a = accelOnReceiver(r, softeningSq);
            expect(Number.isFinite(mag(a))).toBe(true);
            expect(mag(a)).toBeLessThanOrEqual(prev + 1e-15); // monotone decreasing toward 0
            prev = mag(a);
        }
        // Exactly at coincidence the acceleration is zero (dx = dy = 0).
        const a0 = accelOnReceiver(0, softeningSq);
        expect(mag(a0)).toBe(0);
    });

    it('matches the softened closed form G·m·r/(r²+ε²)^{3/2}', () => {
        const softeningSq = 0.25; // ε = 0.5
        for (const r of [0.3, 1, 5, 20]) {
            const a = accelOnReceiver(r, softeningSq);
            const expected = (G * mj * r) / Math.pow(r * r + softeningSq, 1.5);
            expect(Math.abs(mag(a) - expected) / expected).toBeLessThan(1e-12);
        }
    });
});
