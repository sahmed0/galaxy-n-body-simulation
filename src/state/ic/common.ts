/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { PhysicsState } from '../../physics';
import type { PresetName, SimulationParams } from '../params';

/**
 * Base radius for galaxy particle distribution generation. Used by the accretion
 * preset, which seeds the disk in the annulus
 * [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. The self-gravitating
 * preset instead uses an exponential profile (see DISK_SCALE_LENGTH).
 */
export const GALAXY_RADIUS = 500;

/**
 * Inner radius of the accretion-preset annulus (see {@link GALAXY_RADIUS}).
 */
export const DISK_INNER_RADIUS = 10;

/**
 * Minimum number of leapfrog steps used to resolve the fastest (innermost) orbit
 * of a disk: the orbital-resolution dt limit is one orbital period at the peak
 * angular frequency divided by this. Shared by both presets' adaptive timestep.
 */
export const STEPS_PER_ORBIT = 50;

/**
 * Floor on the adaptive timestep, as a fraction of the engine preset dt, so a
 * pathological choice can't make the simulation crawl to a halt. Hitting this
 * floor signals the disk mass / halo are mis-scaled (but is not treated as an
 * error). Shared by both presets' adaptive timestep.
 */
export const MIN_DT_FRACTION = 1 / 64;

/**
 * Default dark-matter halo strength for each preset. The galaxy wants a halo
 * (a flat outer rotation curve); the accretion preset is a clean Keplerian
 * test-particle disk about a dominant SMBH, so DM is off by default. This is the
 * single source for both the initial {@link SimulationParams}.dmStrength
 * and the DM-only reset performed when the user switches presets in the UI.
 * @param preset - The simulation preset.
 * @returns The default dmStrength for that preset (0 for accretion, 250 for galaxy).
 */
export function presetDmDefault(preset: PresetName): number {
    return preset === 'accretion' ? 0 : 250;
}

/**
 * The mutable simulation surface an initial-conditions object writes into. The
 * manager replaces `state` on every re-initialisation, so the context is built
 * fresh per call rather than cached on the IC object.
 */
export interface IcContext {
    state: PhysicsState;
    params: SimulationParams;
    rng: () => number;
}

/**
 * How a preset builds and maintains its disk. One implementation per preset; the
 * manager holds exactly one instance and delegates every initial-condition
 * question to it.
 */
export interface InitialConditions {
    /** Which preset this object realises. */
    readonly preset: PresetName;
    /**
     * Effective total disk mass of the current realization. Non-zero only in the
     * self-gravitating preset, where it adds the disk's own contribution to the
     * circular velocity and sets the Toomre-Q velocity dispersion.
     */
    readonly diskMass: number;
    /**
     * Writes positions, velocities, masses and colours into `ctx.state`, and sets
     * `params.activeCount`, `params.useActivePassive`, `params.blackHoleMass`,
     * `params.blackHoleSoftening`, `params.softening` and `params.dt` for the preset.
     */
    initialise(ctx: IcContext): void;
    /**
     * Re-derives every disk velocity from the current positions. Used by the
     * gravity slider and engine switches, which change the field or dt without
     * resampling the disk.
     */
    resetVelocities(ctx: IcContext): void;
    /** Safe timestep for the preset: a pure read of this object's tables and `params`. */
    adaptiveTimestep(params: SimulationParams): number;
    /** Gravitational softening for the preset: a pure read of this object's tables and `params`. */
    effectiveSoftening(params: SimulationParams): number;
}

/**
 * Inward radial acceleration from the dark-matter halo (isothermal-cored)
 * at radius `r`: a_DM = dmStrength^2 * r / (r^2 + r_core^2). Shared by the
 * accretion preset's analytic rotation curve and the self-gravitating preset's
 * measured rotation curve.
 */
export function haloAcc(r: number, params: Pick<SimulationParams, 'dmStrength' | 'dmCoreRadius'>): number {
    const s = params.dmStrength;
    return (s * s * r) / (r * r + params.dmCoreRadius * params.dmCoreRadius);
}

/**
 * Draws a stellar mass from a Salpeter IMF over [0.1, 50] (exponent 1.35).
 * Used for particle colours in both presets and for the physical (test-
 * particle) masses in the accretion preset.
 */
export function sampleSalpeterMass(rng: () => number): number {
    const mMin = 0.1;
    const mMax = 50.0;
    const p = 1.35;
    const u = rng();
    const minP = Math.pow(mMin, -p);
    const maxP = Math.pow(mMax, -p);
    return Math.pow(u * (maxP - minP) + minP, -1 / p);
}

/**
 * Standard normal random sample (mean 0, variance 1) via Box-Muller.
 */
export function gaussianRandom(rng: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
