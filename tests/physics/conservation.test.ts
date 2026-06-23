/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Full-sim conservation check for a pure brute-force run (no DM halo, no SMBH, no
 * active/passive split — `leapfrogStep` only ever calls `pairwiseAccel`, so those
 * extra terms are simply absent here). The shared pairwise kernel kicks every body
 * with `G·mass[j]·r̂/r²` and the engine sums each pair independently; Newton's third
 * law then says the per-pair kicks `mᵢaᵢ` / `mⱼaⱼ` cancel, so:
 *   1. total linear momentum `P = Σ mᵢvᵢ` is conserved (to roundoff), and
 *   2. the centre of mass travels in a straight line at `v_com = P/M` — with zero
 *      net momentum it does not move at all.
 *
 * Both are asserted relative over a long many-body run. There is no analytic
 * trajectory here; the point is purely the structural invariant, which catches any
 * accidental self-acceleration (e.g. a `j === i` bug or an asymmetric kick).
 */
import { describe, it, expect } from 'vitest';
import { makeSoA, leapfrogStep, type Body, type SoAState } from '../utils/soa';

/** Deterministic mulberry32 PRNG — keeps the cloud reproducible without the Phase 7 rng util. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Total linear momentum `{px, py}` of the current (stored) state. */
function momentum(s: SoAState): { px: number; py: number } {
    let px = 0;
    let py = 0;
    for (let i = 0; i < s.n; i++) {
        px += s.mass[i] * s.vx[i];
        py += s.mass[i] * s.vy[i];
    }
    return { px, py };
}

/** Centre-of-mass position `{x, y}` of the current state. */
function centreOfMass(s: SoAState): { x: number; y: number; M: number } {
    let x = 0;
    let y = 0;
    let M = 0;
    for (let i = 0; i < s.n; i++) {
        x += s.mass[i] * s.px[i];
        y += s.mass[i] * s.py[i];
        M += s.mass[i];
    }
    return { x: x / M, y: y / M, M };
}

/**
 * Builds a deterministic many-body cloud in a box of half-width `R`, masses in
 * `[0.5, 1.5]`, random velocities scaled by `vScale`, then adds a uniform bulk
 * velocity `bulk` to every body so the system has a clear net momentum.
 */
function makeCloud(n: number, seed: number, R: number, vScale: number, bulk: { x: number; y: number }): Body[] {
    const rng = mulberry32(seed);
    const bodies: Body[] = [];
    for (let i = 0; i < n; i++) {
        bodies.push({
            x: (rng() * 2 - 1) * R,
            y: (rng() * 2 - 1) * R,
            vx: (rng() * 2 - 1) * vScale + bulk.x,
            vy: (rng() * 2 - 1) * vScale + bulk.y,
            m: 0.5 + rng(),
        });
    }
    return bodies;
}

// Shared run parameters. Softening is generous (ε = 1) relative to the box so no
// close encounter produces a huge kick that would inflate per-step roundoff; the
// invariants hold regardless of dynamics, this just keeps the numbers clean.
const G = 1.0;
const SOFTENING_SQ = 1.0;
const DT = 0.01;
const STEPS = 4000;
const N = 30;
const R = 8.0;
const V_SCALE = 0.3;

describe('Full brute-force run — linear momentum & COM conservation', () => {
    it('conserves total linear momentum to roundoff over a long run', () => {
        const bulk = { x: 0.7, y: -0.4 };
        const state = makeSoA(makeCloud(N, 0x1234, R, V_SCALE, bulk));

        const P0 = momentum(state);
        const scale = Math.hypot(P0.px, P0.py); // |P0| is comfortably O(M·|bulk|) ≫ 0

        let maxRel = 0;
        for (let step = 0; step < STEPS; step++) {
            leapfrogStep(state, DT, G, SOFTENING_SQ);
            const P = momentum(state);
            const rel = Math.hypot(P.px - P0.px, P.py - P0.py) / scale;
            if (rel > maxRel) maxRel = rel;
        }

        // Measured 1.3e-15 (float64 roundoff floor); 1e-9 is the spec target with headroom.
        expect(maxRel).toBeLessThan(1e-9);
    });

    it('keeps the COM on the straight line x_com(t) = x_com(0) + (P/M)·t', () => {
        const bulk = { x: 0.7, y: -0.4 };
        const state = makeSoA(makeCloud(N, 0x1234, R, V_SCALE, bulk));

        const com0 = centreOfMass(state);
        const P0 = momentum(state);
        const vcx = P0.px / com0.M;
        const vcy = P0.py / com0.M;

        let maxDev = 0;
        for (let step = 1; step <= STEPS; step++) {
            leapfrogStep(state, DT, G, SOFTENING_SQ);
            const com = centreOfMass(state);
            // Each drift advances the COM by (P_postkick/M)·dt, and P is conserved at
            // P0, so after k steps the COM sits exactly at x_com(0) + (P0/M)·k·dt.
            const t = step * DT;
            const dx = com.x - (com0.x + vcx * t);
            const dy = com.y - (com0.y + vcy * t);
            const dev = Math.hypot(dx, dy) / R; // relative to box half-width
            if (dev > maxDev) maxDev = dev;
        }

        // Measured 3.1e-15; the COM is straight to roundoff once momentum is conserved.
        expect(maxDev).toBeLessThan(1e-9);
    });

    it('holds a zero-net-momentum system COM fixed', () => {
        const state = makeSoA(makeCloud(N, 0x99beef, R, V_SCALE, { x: 0, y: 0 }));

        // Subtract the mean momentum so total P = 0 exactly (to roundoff): COM must not drift.
        const P = momentum(state);
        const M = centreOfMass(state).M;
        for (let i = 0; i < state.n; i++) {
            state.vx[i] -= P.px / M;
            state.vy[i] -= P.py / M;
        }

        const com0 = centreOfMass(state);
        let maxDev = 0;
        for (let step = 0; step < STEPS; step++) {
            leapfrogStep(state, DT, G, SOFTENING_SQ);
            const com = centreOfMass(state);
            const dev = Math.hypot(com.x - com0.x, com.y - com0.y) / R;
            if (dev > maxDev) maxDev = dev;
        }

        // Residual COM motion is just the integral of momentum roundoff; ~1e-13 measured.
        expect(maxDev).toBeLessThan(1e-9);
    });
});
