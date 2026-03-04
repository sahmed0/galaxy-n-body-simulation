import { PhysicsState } from './PhysicsState';

/**
 * Type alias representing the initial data state for the simulation.
 */
export type InitialConditionType = PhysicsState;

/**
 * Configuration parameters for the physics simulation step.
 */
export interface PhysicsParams {
    /** The universal gravitational constant for the step. */
    gravity: number;
    /** The delta time step to advance the simulation by. */
    dt: number;
    /** A small offset to prevent infinite acceleration during close encounters. */
    softening: number;
    /** The number of active bodies in the simulation. */
    activeCount: number;
    /** Flag to enable active/passive logic for performance optimization. */
    useActivePassive: boolean;
    /** The threshold parameter for Barnes-Hut cell inclusion. */
    theta: number;
    /** The attractive strength of the dark matter halo, if any. */
    dmStrength?: number;
    /** The core radius of the dark matter halo. */
    dmCoreRadius?: number;
    /** Minimum mass required for an object to be considered "active" (e.g., in a QuadTree). */
    massThreshold?: number;
    /** Mass of a central supermassive black hole. */
    blackHoleMass?: number;
    /** Softening parameter specific to the central supermassive black hole. */
    blackHoleSoftening?: number;
    /** Camera Zoom level, utilized primarily within WebGPU simulation rendering. */
    cameraZoom?: number;
    /** Camera X-axis offset. */
    cameraX?: number;
    /** Camera Y-axis offset. */
    cameraY?: number;
    /** Camera 3D tilt factor. */
    cameraTilt?: number;
}

/**
 * A standard interface representing a physics evaluation engine.
 */
export interface PhysicsEngine {
    /**
     * Initialises the physics engine with initial conditions.
     * @param n - The total number of bodies in the simulation.
     * @param initialConditions - The structure containing the starting data state.
     */
    init(n: number, initialConditions: InitialConditionType): void | Promise<void>;

    /**
     * Updates the simulation state by a given time step.
     * @param dt - The time step delta to advance the simulation.
     * @param params - The physical parameters governing the simulation forces.
     */
    update(dt: number, params: PhysicsParams): void;

    /**
     * Retrieves the current positions of the bodies in the simulation.
     * @returns A Float32Array containing interleaved position data, or X-axis positions (implementation specific).
     */
    getPositions(): Float32Array;

    /**
     * Retrieves the current velocities of the bodies in the simulation.
     * @returns A Float32Array containing interleaved velocity data, or X-axis velocities (implementation specific).
     */
    getVelocities(): Float32Array;

    /**
     * Explicitly sets all particle data in the engine (optional method).
     * @param n - The total number of bodies in the simulation.
     * @param initialConditions - The structure containing the full data state.
     * @param activeCount - An optional limit denoting the number of bodies that actively apply forces.
     */
    setParticles?(n: number, initialConditions: InitialConditionType, activeCount?: number): void;
}
