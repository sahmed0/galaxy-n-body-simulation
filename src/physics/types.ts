import { PhysicsState } from './PhysicsState';

/**
 * Type alias representing the initial data state for the simulation.
 */
export type InitialConditionType = PhysicsState;

/**
 * The set of selectable physics backends. `worker` runs Barnes-Hut off the main
 * thread via {@link SharedStateEngine}; the rest run inline.
 */
export type EngineType = 'brute' | 'barnes' | 'webgpu' | 'worker';

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
 * The capability shared by every physics evaluation engine: it can be
 * initialised, stepped one time increment, and disposed. It deliberately says
 * nothing about *how* results are observed - that is the job of the two
 * capability sub-interfaces ({@link SharedStateEngine} and
 * {@link SelfRenderingEngine}), discriminated by their `kind` tag.
 */
export interface PhysicsEngine {
    /**
     * Initialises the physics engine with initial conditions.
     *
     * Failure contract: an implementation that cannot initialise MUST signal it
     * by throwing (synchronously) or rejecting (asynchronously) - it must never
     * resolve into a half-constructed, no-op engine. Callers are expected to
     * catch this and fall back to another engine. Implementations that depend on
     * optional platform features (e.g. {@link WebGPUEngine}, which requires
     * WebGPU) throw a typed {@link WebGPUUnavailableError} so the caller can
     * distinguish "this backend is unavailable, fall back" from a generic error.
     *
     * @param n - The total number of bodies in the simulation.
     * @param initialConditions - The structure containing the starting data state.
     * @throws {WebGPUUnavailableError} (WebGPUEngine) when no usable GPU device
     *   can be acquired. Other implementations may throw/reject with their own
     *   error types to indicate an unrecoverable initialisation failure.
     */
    init(n: number, initialConditions: InitialConditionType): void | Promise<void>;

    /**
     * Advances the simulation state by a given time step.
     * @param dt - The time step delta to advance the simulation.
     * @param params - The physical parameters governing the simulation forces.
     */
    step(dt: number, params: PhysicsParams): void;

    /**
     * Releases all engine resources (workers, GPU buffers/device, DOM nodes,
     * timers). Safe to call more than once; the engine is unusable afterwards.
     */
    dispose(): void;

    /**
     * Exact number of pairwise force interactions the most recent step evaluated,
     * for honest performance telemetry. Optional so engines that do not track it are
     * not forced to implement it; callers must treat a missing method as "unknown".
     * @returns Pairwise interactions evaluated in the last step.
     */
    getLastInteractionCount?(): number;
}

/**
 * A physics engine that steps a shared {@link PhysicsState} which a separate
 * renderer reads. The CPU engines ({@link BruteForceEngine},
 * {@link BarnesHutEngine}, {@link WorkerBridge}) are of this kind.
 */
export interface SharedStateEngine extends PhysicsEngine {
    readonly kind: 'shared-state';
    /**
     * The simulation state this engine steps. It is the same object the owning
     * caller holds and the renderer reads - the engine mutates it in place.
     */
    readonly state: PhysicsState;
}

/**
 * A physics engine that both steps *and* presents its own output, owning its
 * render surface ({@link WebGPUEngine}). Its data stays on-device, so there is
 * no shared {@link PhysicsState}; callers drive presentation via `render`.
 */
export interface SelfRenderingEngine extends PhysicsEngine {
    readonly kind: 'self-rendering';
    /**
     * Presents the engine's current state to its own surface.
     * @param params - The parameters governing presentation (e.g. camera).
     */
    render(params: PhysicsParams): void;
    /**
     * Shows or hides the engine's render surface.
     * @param visible - Target visibility of the surface.
     */
    setVisible(visible: boolean): void;
}

/**
 * The polymorphic engine reference: either capability, discriminated by `kind`.
 */
export type AnyEngine = SharedStateEngine | SelfRenderingEngine;
