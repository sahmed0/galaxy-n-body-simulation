/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Engine-class energy-conservation bands. The kernel tests prove the force law and
 * the integrator in isolation; these drive whole engines (BruteForce, BarnesHut)
 * stepping a real Float32 `PhysicsState` over thousands of steps and assert that the
 * total energy of the *active subsystem* stays inside a bounded band - the signature
 * of a symplectic (leapfrog) integrator - rather than drifting secularly.
 *
 * Energy is defined over the active indices `[start, activeCount)` with
 * `start = blackHoleMass > 0 ? 1 : 0`, exactly matching the engines' force topology:
 *   - KE  = ½ Σ mᵢ(vxᵢ² + vyᵢ²)
 *   - PE  = −G Σ_{i<j} mᵢmⱼ / √(dᵢⱼ² + ε²)   (each unordered active pair once)
 *   - +external analytic potentials (dark-matter halo, softened central BH) that the
 *     kernels apply as one-way central forces.
 * Each analytic potential is the exact one whose gradient is the corresponding kernel
 * force, so the total is a genuinely conserved quantity for the softened system.
 *
 * The potential *formulas* come from `src/physics/energy` - the single source of truth
 * they now share with the production `EnergyMonitor`. The summation loops below stay
 * deliberately independent of that module: the formulas are checked
 * once, and this suite remains an independent check on the summing. The frozen bands
 * are unchanged by that extraction, which is what proves it was numerically inert.
 *
 * All ICs are seeded (mulberry32) and deterministic; the reported bands were measured
 * here and frozen with margin, so a regression that breaks conservation trips the test.
 */
import { describe, it, expect } from 'vitest';
import { BruteForceEngine, BarnesHutEngine, PhysicsState } from '../../src/physics';
import type { PhysicsParams } from '../../src/physics/types';
import {
    pairPotential,
    darkMatterPotential,
    blackHolePotential,
    DEFAULT_DM_CORE_RADIUS,
} from '../../src/physics/energy';
import { mulberry32 } from '../utils/rng';
import { makeVirialCluster, staggerHalfStep } from '../utils/clusters';

/** Gravitational constant for the BH-disk case, whose accelerations are computed here. */
const G = 1.0;

/**
 * Total energy of the active subsystem `[start, activeCount)`, summed in float64
 * regardless of the state's float32 storage. Mirrors the engines' force topology.
 * External halo/BH potentials are included only when enabled.
 */
function totalEnergy(state: PhysicsState, params: PhysicsParams, start: number, activeCount: number): number {
    const { positionX: px, positionY: py, velocityX: vx, velocityY: vy, mass } = state;
    const epsSq = params.softening * params.softening;

    // Kinetic energy over every active body.
    let ke = 0;
    for (let i = start; i < activeCount; i++) {
        ke += 0.5 * mass[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
    }

    // Softened pairwise potential - each unordered active pair counted once.
    let pe = 0;
    for (let i = start; i < activeCount; i++) {
        for (let j = i + 1; j < activeCount; j++) {
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            pe += pairPotential(dx * dx + dy * dy, epsSq, params.gravity, mass[i], mass[j]);
        }
    }

    // External analytic potentials (one-way central forces), per active body.
    const dmStrength = params.dmStrength || 0;
    if (dmStrength > 0) {
        const rcore = params.dmCoreRadius || DEFAULT_DM_CORE_RADIUS;
        for (let i = start; i < activeCount; i++) {
            const rSq = px[i] * px[i] + py[i] * py[i];
            pe += mass[i] * darkMatterPotential(rSq, dmStrength, rcore);
        }
    }
    const bhMass = params.blackHoleMass || 0;
    if (bhMass > 0) {
        const bhEpsSq = (params.blackHoleSoftening || params.softening) ** 2;
        for (let i = start; i < activeCount; i++) {
            const rSq = px[i] * px[i] + py[i] * py[i];
            pe += mass[i] * blackHolePotential(rSq, bhEpsSq, params.gravity, bhMass);
        }
    }

    return ke + pe;
}

/**
 * Steps `engine`, sampling `totalEnergy` every `sampleEvery` steps, and reports the
 * fractional band `max|E−E₀|/|E₀|` plus the secular-drift check: the difference between
 * the mean of the first and last 10 % of samples (relative to |E₀|). A symplectic
 * integrator keeps the band bounded and the drift ≪ band.
 */
function runBand(
    engine: BruteForceEngine | BarnesHutEngine,
    state: PhysicsState,
    params: PhysicsParams,
    start: number,
    activeCount: number,
    steps: number,
    sampleEvery: number,
): { band: number; drift: number } {
    const samples: number[] = [];
    const e0 = totalEnergy(state, params, start, activeCount);
    samples.push(e0);
    for (let s = 0; s < steps; s++) {
        engine.step(params.dt, params);
        if ((s + 1) % sampleEvery === 0) {
            samples.push(totalEnergy(state, params, start, activeCount));
        }
    }
    const absE0 = Math.abs(e0);
    let band = 0;
    for (const e of samples) {
        const rel = Math.abs(e - e0) / absE0;
        if (rel > band) band = rel;
    }
    const window = Math.max(1, Math.floor(samples.length * 0.1));
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const first = mean(samples.slice(0, window));
    const last = mean(samples.slice(samples.length - window));
    const drift = Math.abs(last - first) / absE0;
    return { band, drift };
}

/**
 * Builds a seeded disk of `n−1` light test particles on ~circular orbits around a
 * pinned, softened central black hole at index 0 (position/velocity zero, mass = bhMass).
 * Disk masses are small so mutual gravity is a perturbation on the BH field.
 */
function makeBhDisk(n: number, seed: number, params: PhysicsParams): PhysicsState {
    const rng = mulberry32(seed);
    const state = new PhysicsState(n);
    const bhMass = params.blackHoleMass || 0;
    const bhEpsSq = (params.blackHoleSoftening || params.softening) ** 2;

    // Index 0: the pinned BH marker. The engines never integrate it (start = 1).
    state.positionX[0] = 0;
    state.positionY[0] = 0;
    state.velocityX[0] = 0;
    state.velocityY[0] = 0;
    state.mass[0] = bhMass;

    for (let i = 1; i < n; i++) {
        const r = 3.0 + rng() * 9.0; // annulus [3, 12]
        const theta = rng() * 2 * Math.PI;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        // Circular speed in the softened point-mass field: v² = r·|a|.
        const accMag = (G * bhMass * r) / (r * r + bhEpsSq) ** 1.5;
        const vc = Math.sqrt(r * accMag);
        state.positionX[i] = x;
        state.positionY[i] = y;
        // Tangential (perpendicular to the radius vector), consistent handedness.
        state.velocityX[i] = -vc * Math.sin(theta);
        state.velocityY[i] = vc * Math.cos(theta);
        state.mass[i] = 0.001;
    }

    // Half-step stagger from the full (BH + disk) acceleration, skipping the pinned BH.
    staggerHalfStep(state, 1, params.dt, (i) => bhDiskAccel(state, params, i));
    return state;
}

/** BH-central plus disk pairwise acceleration on body `i` (index 0 excluded as a source). */
function bhDiskAccel(state: PhysicsState, params: PhysicsParams, i: number): { ax: number; ay: number } {
    const { positionX: px, positionY: py, mass } = state;
    const bhMass = params.blackHoleMass || 0;
    const bhEpsSq = (params.blackHoleSoftening || params.softening) ** 2;
    const epsSq = params.softening * params.softening;

    // Central BH term.
    const rSq = px[i] * px[i] + py[i] * py[i] + bhEpsSq;
    const aBh = (G * bhMass) / (rSq * Math.sqrt(rSq));
    let ax = -px[i] * aBh;
    let ay = -py[i] * aBh;

    // Disk self-gravity (excludes the pinned BH at index 0).
    for (let j = 1; j < state.n; j++) {
        if (j === i) continue;
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const distSq = dx * dx + dy * dy + epsSq;
        const inv = (G * mass[j]) / (distSq * Math.sqrt(distSq));
        ax += inv * dx;
        ay += inv * dy;
    }
    return { ax, ay };
}

describe('Engine-class energy-conservation bands', () => {
    const N = 64;
    const CLUSTER_SEED = 0xC0FFEE;

    // Shared self-gravity params for Cases A/B (no halo, no BH, full N-body).
    const clusterParams: PhysicsParams = {
        gravity: G,
        dt: 0.004,
        softening: 1.0,
        activeCount: N,
        useActivePassive: false,
        theta: 0.7,
        dmStrength: 0,
        blackHoleMass: 0,
    };

    it('Case A - BruteForce keeps a self-gravitating cluster in a bounded energy band', () => {
        const state = makeVirialCluster(N, CLUSTER_SEED, clusterParams);
        const engine = new BruteForceEngine(state);
        const { band, drift } = runBand(engine, state, clusterParams, 0, N, 5000, 50);

        // Measured band ≈ 6.2e-4 (leapfrog + float32 state); frozen with ~2.4× margin.
        expect(band).toBeLessThan(1.5e-3);
        // Band, not secular drift: the first/last-decile means stay within half the band.
        expect(drift).toBeLessThan(band * 0.5);
    });

    it('Case B - BarnesHut (θ=0.7) preserves the band despite the tree approximation', () => {
        const state = makeVirialCluster(N, CLUSTER_SEED, clusterParams);
        const engine = new BarnesHutEngine(state);
        const { band } = runBand(engine, state, clusterParams, 0, N, 5000, 50);
        engine.dispose();

        // Wider than Case A: the θ tree approximation perturbs the force but must not
        // destroy the band. Measured ≈ 4.6e-3; frozen with ~2× margin.
        expect(band).toBeLessThan(1e-2);
    });

    it('Case C - pinned BH stays at the origin and the disk energy stays banded', () => {
        const bhParams: PhysicsParams = {
            gravity: G,
            dt: 0.01,
            softening: 1.0,
            activeCount: N,
            useActivePassive: false,
            theta: 0.7,
            dmStrength: 0,
            blackHoleMass: 1000,
            blackHoleSoftening: 0.5,
        };
        const state = makeBhDisk(N, 0xBEEF, bhParams);
        const engine = new BruteForceEngine(state);
        const { band } = runBand(engine, state, bhParams, 1, N, 2000, 50);

        // The pinned marker (index 0) is never integrated: it must not move at all.
        expect(state.positionX[0]).toBe(0);
        expect(state.positionY[0]).toBe(0);
        expect(state.velocityX[0]).toBe(0);
        expect(state.velocityY[0]).toBe(0);

        // Energy band with the analytic BH potential included. Circular orbits keep this
        // very tight - measured ≈ 4.5e-6; frozen at 1e-4 (a real break jumps orders of magnitude).
        expect(band).toBeLessThan(1e-4);
    });
});
