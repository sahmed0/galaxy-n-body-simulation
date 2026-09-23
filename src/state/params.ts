/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { EngineType, PhysicsParams } from '../physics';

/** The selectable sets of initial conditions. */
export type PresetName = 'accretion' | 'galaxy';

/**
 * Every runtime-adjustable simulation parameter. The manager owns one instance.
 * Extends the engine-facing {@link PhysicsParams} with the preset, engine and UI
 * state the engines never see, and makes the halo and black hole fields required:
 * the manager always sets them.
 */
export interface SimulationParams extends PhysicsParams {
    engineType: EngineType;
    /**
     * Simulation preset (initial conditions):
     *   'accretion' - SMBH/halo-dominated; disk is light (test-particle) -> rings
     *   'galaxy'    - massive self-gravitating disk tuned to Toomre Q -> spiral arms
     */
    preset: PresetName;
    count: number;
    /** Galaxy preset only: number of field-generating disk particles. See SELF_GRAV_ACTIVE_COUNT. */
    selfGravActiveCount: number;
    /** Accretion preset only: Salpeter mass at or above which a star is active; also the renderer's heavy/light point size cut. */
    massThreshold: number;
    isPaused: boolean;
    shouldShowQuadTree: boolean;
    /** The attractive strength of the dark matter halo. */
    dmStrength: number;
    /** The core radius of the dark matter halo. */
    dmCoreRadius: number;
    /** Mass of a central supermassive black hole. */
    blackHoleMass: number;
    /** Softening parameter specific to the central supermassive black hole. */
    blackHoleSoftening: number;
}
