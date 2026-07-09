/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Barnes-Hut accuracy test. Routes the BH engine's exact (leaf) interactions
 * and its theta-accepted internal-node interactions through the *same* `pairwiseAccel`
 * kernel that brute force uses, so the only thing a BH-vs-brute comparison can expose
 * is the theta tree approximation - never two different force formulas.
 *
 * Strategy: build one random cloud as a Float32 `PhysicsState`. The brute reference is
 * `pairwiseAccel` evaluated on those exact float32 positions (float64 ground truth). The
 * BH acceleration is read out of the *real* engine: with all velocities 0 and dt = 1, a
 * single `update` leaves `velocity == acceleration` (the leapfrog kick is `v += a*dt`,
 * and the position drift afterwards does not touch velocity). So this exercises the
 * production code path, confirming the engine genuinely uses the shared kernel.
 *
 * Error metric: Global RMS
 * relative force error `sqrt(Σ|Δa|² / Σ|a|²)`, which weights by force magnitude and is
 * robust to those outliers. The per-particle max is kept only for the theta = 0 exactness
 * check, where every node is rejected so BH == brute and the ratio is well-conditioned.
 *
 * As theta shrinks the tree opens more nodes, so the error must shrink monotonically; at
 * theta = 0 every internal node is rejected and BH reduces to the exact direct sum
 * (matching brute to the float32 storage floor of the velocity readout).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BarnesHutEngine, PhysicsState } from '../../src/physics';
import type { PhysicsParams } from '../../src/physics/types';
import { pairwiseAccel } from '../../src/physics/kernels';

/** Deterministic mulberry32 PRNG — keeps the cloud reproducible without the rng util. */
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

const N = 256;
const SEED = 0x5eed; // recorded for reproducibility; the envelopes below are measured here
const R = 20.0; // box half-width
const G = 1.0;
const SOFTENING = 0.5; // small vs the mean spacing (~2*R/sqrt(N) ≈ 2.5) so the field is non-trivial
const SOFTENING_SQ = SOFTENING * SOFTENING;
const THETAS = [0, 0.2, 0.5, 1.0] as const;

/** A single body's coordinates + mass. */
interface CloudBody { x: number; y: number; m: number; }

/** Builds a deterministic random cloud in a box of half-width R, masses in [0.5, 1.5]. */
function makeCloud(): CloudBody[] {
    const rng = mulberry32(SEED);
    const bodies: CloudBody[] = [];
    for (let i = 0; i < N; i++) {
        bodies.push({
            x: (rng() * 2 - 1) * R,
            y: (rng() * 2 - 1) * R,
            m: 0.5 + rng(),
        });
    }
    return bodies;
}

/** Fills a fresh Float32 PhysicsState from the cloud, velocities zeroed. */
function makeState(cloud: CloudBody[]): PhysicsState {
    const state = new PhysicsState(cloud.length);
    for (let i = 0; i < cloud.length; i++) {
        state.positionX[i] = cloud[i].x;
        state.positionY[i] = cloud[i].y;
        state.velocityX[i] = 0;
        state.velocityY[i] = 0;
        state.mass[i] = cloud[i].m;
    }
    return state;
}

/** Base params: no BH, no DM, no active/passive — pure N-body so only theta varies. */
function makeParams(theta: number): PhysicsParams {
    return {
        gravity: G,
        dt: 1, // dt = 1 => velocity after one kick equals the acceleration
        softening: SOFTENING,
        activeCount: N,
        useActivePassive: false,
        theta,
        dmStrength: 0,
        blackHoleMass: 0,
    };
}

/**
 * Drives the real BH engine one step for a given theta and returns the error vs brute:
 * the per-particle max `|Δa|/|a|` and the global RMS relative force error
 * `sqrt(Σ|Δa|² / Σ|a|²)`.
 */
function errorsAt(cloud: CloudBody[], aBruteX: Float64Array, aBruteY: Float64Array, theta: number): { max: number; rms: number } {
    const state = makeState(cloud);
    const engine = new BarnesHutEngine(state);
    engine.step(1, makeParams(theta)); // dt = 1, v starts at 0 => v == acceleration

    let maxRel = 0;
    let sumDsq = 0;
    let sumAsq = 0;
    for (let i = 0; i < N; i++) {
        const dax = state.velocityX[i] - aBruteX[i];
        const day = state.velocityY[i] - aBruteY[i];
        const dMag = Math.hypot(dax, day);
        const aMag = Math.hypot(aBruteX[i], aBruteY[i]);
        const rel = dMag / aMag;
        if (rel > maxRel) maxRel = rel;
        sumDsq += dMag * dMag;
        sumAsq += aMag * aMag;
    }
    engine.dispose(); // return pooled nodes to the static QuadTree pool
    return { max: maxRel, rms: Math.sqrt(sumDsq / sumAsq) };
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

describe('Barnes-Hut vs brute force — shared pairwise kernel + theta error envelope', () => {
    const cloud = makeCloud();

    // Brute reference: float64 ground truth from the exact float32 positions the engine sees.
    const refState = makeState(cloud);
    const aBruteX = new Float64Array(N);
    const aBruteY = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const { ax, ay } = pairwiseAccel(refState.positionX, refState.positionY, refState.mass, N, i, G, SOFTENING_SQ);
        aBruteX[i] = ax;
        aBruteY[i] = ay;
    }

    // Compute every theta once; share across the assertions below.
    const err = new Map<number, { max: number; rms: number }>();
    for (const theta of THETAS) err.set(theta, errorsAt(cloud, aBruteX, aBruteY, theta));

    it('matches brute force to the float32 storage floor at theta = 0 (every node rejected)', () => {
        // theta = 0 => s/dist < 0 is never true => full recursion to leaves => exact direct sum.
        // The only residual is rounding the float64 tree sum into the float32 velocity readout;
        // here every |a| is healthy so the per-particle max ratio is well-conditioned.
        // Measured per-particle max 5.9e-8; assert < 1e-6 (float eps, not the 1e-14 float64 floor).
        expect(err.get(0)!.max).toBeLessThan(1e-6);
    });

    it('keeps the RMS relative force error within its per-theta envelope', () => {
        // Measured RMS at SEED=0x5eed, N=256, ε=0.5:
        //   theta=0.2 ≈ 1.3e-4, theta=0.5 ≈ 4.3e-3, theta=1.0 ≈ 3.5e-2 — all leave margin against seed/refactor float noise.
        expect(err.get(0.2)!.rms).toBeLessThan(0.005);
        expect(err.get(0.5)!.rms).toBeLessThan(0.03);
        expect(err.get(1.0)!.rms).toBeLessThan(0.1);
    });

    it('shrinks the error monotonically as theta shrinks (opening more nodes)', () => {
        // The RMS error is the robust monotonicity witness (a per-particle max is too noisy,
        // dominated by force-balance outliers). Strictly increasing in theta at every step.
        expect(err.get(1.0)!.rms).toBeGreaterThan(err.get(0.5)!.rms);
        expect(err.get(0.5)!.rms).toBeGreaterThan(err.get(0.2)!.rms);
        expect(err.get(0.2)!.rms).toBeGreaterThan(err.get(0)!.rms);
    });
});
