/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Adaptive timestep tests for {@link SimulationManager.computeAdaptiveTimestep}.
 *
 * computeAdaptiveTimestep() derives a safe dt as the minimum of three limits,
 * floored so a mis-scaling can never stall the sim:
 *   1. the engine preset dt (never run faster);
 *   2. an orbital-resolution limit: one period at the peak angular frequency
 *      Omega_max, divided by STEPS_PER_ORBIT;
 *   3. (galaxy only) a close-encounter limit for the heavy macro-particles,
 *      ENCOUNTER_SAFETY * sqrt(eps^3 / (G * m_particle)).
 *   ...then max'd against presetDt * MIN_DT_FRACTION (the floor).
 *
 * These tests mirror the function's own math (reaching the private rotation-curve /
 * analytic-field internals via a cast, as the accretion/selfgrav tests do) and
 * assert the three behavioural claims: orbits are resolved to >= STEPS_PER_ORBIT,
 * the floor is honoured, and the close-encounter term becomes the binding limit
 * when the macro-particles are heavy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    SimulationManager,
    ENGINE_PRESETS,
    STEPS_PER_ORBIT,
    MIN_DT_FRACTION,
    ENCOUNTER_SAFETY,
    DISK_INNER_RADIUS,
    GALAXY_RADIUS,
} from '../../src/state/SimulationManager';
import { mulberry32 } from '../utils/rng';

// Default seed for the injected RNG. initGalaxy() samples the disk through the
// manager's RNG field, which defaults to Math.random - so without a
// seed the realized disk (and hence the measured rotation curve and Omega_max)
// varies every run, making the orbital limit non-deterministic. Seeding it pins
// every derived quantity so the tight close-encounter assertion is stable.
const SEED = 0x71e57e9;

// Reaches the private analytic field + measured rotation-curve internals + the
// injectable RNG field (TS `private` is compile-time only) so the tests can
// deterministically mirror the dt limits.
interface AdaptiveInternals {
    radialAcc(r: number): number;
    rotCurveAcc: Float64Array;
    rotCurveRMin: number;
    rotCurveRMax: number;
    vCircAt(r: number): number;
    effectiveSoftening(): number;
    selfGravActiveCount(): number;
    rng: () => number;
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

function makeSim(mode: 'accretion' | 'galaxy', count = 1500, seed = SEED) {
    const sim = new SimulationManager();
    sim.params.count = count;
    sim.params.preset = mode;
    // Inject before initGalaxy() - that is where the disk is sampled.
    (sim as unknown as AdaptiveInternals).rng = mulberry32(seed);
    return sim;
}

function presetDtOf(sim: SimulationManager): number {
    return ENGINE_PRESETS[sim.params.engineType as keyof typeof ENGINE_PRESETS].timeStep;
}

/** Peak angular frequency over the accretion annulus (mirrors the function grid). */
function accretionOmegaMax(sim: SimulationManager): number {
    const s = sim as unknown as AdaptiveInternals;
    const rMin = DISK_INNER_RADIUS;
    const rMax = DISK_INNER_RADIUS + GALAXY_RADIUS;
    const N = 128;
    let omegaMax = 0;
    for (let k = 0; k < N; k++) {
        const r = rMin + ((rMax - rMin) * k) / (N - 1);
        if (r <= 0) continue;
        const vCirc = Math.sqrt(Math.max(s.radialAcc(r) * r, 0));
        omegaMax = Math.max(omegaMax, vCirc / r);
    }
    return omegaMax;
}

/** Peak angular frequency over the measured galaxy rotation curve. */
function galaxyOmegaMax(sim: SimulationManager): number {
    const s = sim as unknown as AdaptiveInternals;
    const Nr = s.rotCurveAcc.length;
    let omegaMax = 0;
    for (let k = 0; k < Nr; k++) {
        const rk = s.rotCurveRMin + ((s.rotCurveRMax - s.rotCurveRMin) * k) / (Nr - 1);
        if (rk <= 0) continue;
        const omega = s.vCircAt(rk) / rk;
        if (omega > omegaMax) omegaMax = omega;
    }
    return omegaMax;
}

/** Mirrors the galaxy close-encounter limit: ENCOUNTER_SAFETY*sqrt(eps^3/(G*m)). */
function galaxyEncounterLimit(sim: SimulationManager): number {
    const s = sim as unknown as AdaptiveInternals;
    const eps = s.effectiveSoftening();
    const mParticle = sim.diskMass / s.selfGravActiveCount();
    return ENCOUNTER_SAFETY * Math.sqrt((eps * eps * eps) / (sim.params.gravity * mParticle));
}

describe('SimulationManager - adaptive timestep resolves the fastest orbit', () => {
    // When the orbital limit binds, dt = (2*pi/Omega_max)/STEPS_PER_ORBIT exactly,
    // so steps == STEPS_PER_ORBIT; when any tighter limit (presetDt / encounter)
    // binds, dt is smaller and steps > STEPS_PER_ORBIT. Either way >= holds, as
    // long as the floor does not bite (covered by the floor test below). The tiny
    // epsilon absorbs float rounding in the exact-orbital-bind case.
    it('accretion: >= STEPS_PER_ORBIT steps over the fastest orbit', () => {
        const sim = makeSim('accretion');
        sim.initGalaxy();
        const dt = sim.computeAdaptiveTimestep();
        const stepsPerOrbit = (2 * Math.PI / accretionOmegaMax(sim)) / dt;
        expect(stepsPerOrbit).toBeGreaterThanOrEqual(STEPS_PER_ORBIT - 1e-6);
    });

    it('galaxy: >= STEPS_PER_ORBIT steps over the fastest orbit', () => {
        const sim = makeSim('galaxy');
        sim.initGalaxy();
        const dt = sim.computeAdaptiveTimestep();
        const stepsPerOrbit = (2 * Math.PI / galaxyOmegaMax(sim)) / dt;
        expect(stepsPerOrbit).toBeGreaterThanOrEqual(STEPS_PER_ORBIT - 1e-6);
    });
});

describe('SimulationManager - adaptive timestep floor', () => {
    it('clamps dt to the MIN_DT_FRACTION floor when the orbital limit collapses', () => {
        const sim = makeSim('accretion');
        // Crank gravity so Omega_max explodes and the orbital limit drops far below
        // the floor; dt must then clamp to exactly presetDt * MIN_DT_FRACTION.
        sim.params.gravity = 5000;
        sim.initGalaxy();
        const dt = sim.computeAdaptiveTimestep();
        const presetDt = presetDtOf(sim);
        const floor = presetDt * MIN_DT_FRACTION;
        const orbital = (2 * Math.PI / accretionOmegaMax(sim)) / STEPS_PER_ORBIT;

        // The orbital limit really is below the floor, so the floor is what bites
        // (not a no-op clamp on an already-larger dt).
        expect(orbital).toBeLessThan(floor);
        expect(dt).toBeCloseTo(floor, 12);
        // And never below it.
        expect(dt).toBeGreaterThanOrEqual(floor);
    });
});

describe('SimulationManager - adaptive timestep close-encounter limit', () => {
    it('the encounter/softening criterion bites when the macro-particles are heavy', () => {
        // A strong halo raises the *calibrated* disk mass (vExt^2 ∝ dmStrength^2,
        // and the disk-mass solve gives mTarget ∝ vExt^2), so each macro-particle is
        // heavy while the softening (tied to the fixed SELF_GRAV_DISK_MASS seed) stays
        // moderate. The close-encounter limit ENCOUNTER_SAFETY*sqrt(eps^3/(G*m)) then
        // drops below both presetDt and the orbital limit and becomes binding.
        // count=6000 gives a smooth, well-resolved inner rotation curve (the orbital
        // limit's Omega_max is otherwise dominated by inner-bin Poisson noise); the
        // encounter limit is essentially count-independent (~4.6e-3). The seed pins the
        // realization: at this one encounter/orbital ≈ 0.64 - comfortably binding, not
        // knife-edge. No engine stepping, so the single O(N) init stays well under the
        // 5s vitest timeout (~0.9s).
        const sim = makeSim('galaxy', 6000, 0xabc123);
        sim.params.dmStrength = 5000;
        sim.initGalaxy();
        const dt = sim.computeAdaptiveTimestep();

        const presetDt = presetDtOf(sim);
        const orbital = (2 * Math.PI / galaxyOmegaMax(sim)) / STEPS_PER_ORBIT;
        const encounter = galaxyEncounterLimit(sim);
        const floor = presetDt * MIN_DT_FRACTION;
        const expected = Math.max(Math.min(presetDt, orbital, encounter), floor);

        // The encounter limit is strictly the binding one (below both presetDt and
        // the orbital limit), with comfortable margin.
        expect(encounter).toBeLessThan(orbital);
        expect(encounter).toBeLessThan(presetDt);
        expect(encounter).toBeGreaterThan(floor); // it binds, the floor does not
        // dt tracks the encounter limit exactly (it is the min, above the floor).
        expect(dt).toBeCloseTo(expected, 12);
        expect(dt).toBeCloseTo(encounter, 12);
    });
});
