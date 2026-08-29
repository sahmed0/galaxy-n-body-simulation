import type { SharedStateEngine, PhysicsParams, InitialConditionType } from './types';
/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsMemory } from './PhysicsMemory';
import { PhysicsState } from './PhysicsState';

/**
 * Main-thread handle to the physics Web Worker. It shares a single
 * {@link PhysicsMemory} SharedArrayBuffer with the worker: `step()` posts work by
 * flipping the status flag, the worker computes into the same buffer, and the
 * renderer reads the result with no copying.
 */
export class WorkerBridge implements SharedStateEngine {
    public readonly kind = 'shared-state' as const;
    private worker: Worker;
    private memory: PhysicsMemory;
    public readonly state: PhysicsState;

    /**
     * Spawns the worker and hands it the shared buffer via an INIT message so both
     * sides view the same particle arrays.
     * @param memory - The shared physics memory both threads read and write. Must be
     *   backed by a SharedArrayBuffer; the worker parks in `Atomics.wait`, which a
     *   plain ArrayBuffer cannot support.
     */
    constructor(memory: PhysicsMemory) {
        if (!memory.isShared) {
            throw new Error('WorkerBridge requires cross-origin isolation (SharedArrayBuffer)');
        }
        this.memory = memory;

        // Create local view of state for compatibility
        // Since PhysicsMemory has the typed arrays, we can pass them.
        this.state = new PhysicsState(memory.positionX.length, {
            positionX: this.memory.positionX,
            positionY: this.memory.positionY,
            velocityX: this.memory.velocityX,
            velocityY: this.memory.velocityY,
            mass: this.memory.mass,
            colors: this.memory.colors,
        });

        // Spawn Worker
        this.worker = new Worker(
            new URL('./physics.worker.ts', import.meta.url),
            { type: 'module' }
        );

        // Send INIT message
        this.worker.postMessage({
            type: 'INIT',
            payload: {
                sab: this.memory.buffer,
                n: this.state.n
            }
        });
    }

    /**
     * Terminates the worker, which kills it even while it is parked in
     * `Atomics.wait`. Idempotent - re-terminating an already-dead worker is a no-op.
     */
    public dispose(): void {
        this.worker.terminate();
    }

    /**
     * Total number of physics steps the worker has completed since it started, read
     * from the shared step counter. Monotonic; the manager debits simulated time only
     * by the delta of this value so dropped (busy) requests never advance the clock.
     * @returns The completed-step count.
     */
    public getCompletedSteps(): number {
        return Atomics.load(this.memory.flags, PhysicsMemory.FLAG_STEPS_DONE);
    }

    /**
     * Wall-clock duration of the worker's most recent step, in milliseconds.
     * @returns The last step duration (microseconds counter converted to ms).
     */
    public getLastStepMs(): number {
        return Atomics.load(this.memory.flags, PhysicsMemory.FLAG_STEP_US) / 1000;
    }

    /**
     * Whether the worker is mid-step. The renderer skips painting while true (the
     * shared arrays are being mutated) and `step()` drops new requests until it clears.
     * @returns True when the status flag is COMPUTING.
     */
    public isBusy(): boolean {
        return Atomics.load(this.memory.flags, PhysicsMemory.FLAG_STATUS) === PhysicsMemory.STATUS_COMPUTING;
    }

    /**
     * Seeds the shared buffer with the given initial conditions. A no-op when the
     * conditions already are the shared state (the common case), since the worker
     * reads that buffer directly.
     * @param _n - Total body count (unused; the shared arrays are already sized).
     * @param initialConditions - Source arrays to copy into shared memory.
     */
    public init(_n: number, initialConditions: InitialConditionType): void {
        // Copy initial conditions into Shared Memory if needed
        if (initialConditions !== this.state) {
            this.state.positionX.set(initialConditions.positionX);
            this.state.positionY.set(initialConditions.positionY);
            this.state.velocityX.set(initialConditions.velocityX);
            this.state.velocityY.set(initialConditions.velocityY);
            this.state.mass.set(initialConditions.mass);
            this.state.colors.set(initialConditions.colors);
        }
    }

    /**
     * Requests one physics step from the worker: writes the current params into the
     * shared float slots and flips the status flag to COMPUTING. Drops the request
     * (does nothing) if the worker is still busy with the previous step.
     * @param dt - Time step to advance.
     * @param params - Physical parameters written to the shared param slots.
     */
    public step(dt: number, params: PhysicsParams): void {
        const status = Atomics.load(this.memory.flags, PhysicsMemory.FLAG_STATUS);

        if (status === PhysicsMemory.STATUS_IDLE) {
            // Write Params to Shared Memory
            this.memory.floatParams[1] = params.gravity;
            this.memory.floatParams[2] = dt;
            this.memory.floatParams[3] = params.softening;
            this.memory.floatParams[4] = params.theta;
            this.memory.floatParams[5] = params.massThreshold || 0;
            this.memory.floatParams[6] = params.dmStrength || 0;
            this.memory.floatParams[7] = params.dmCoreRadius || 0;
            this.memory.floatParams[8] = params.blackHoleMass || 0;
            this.memory.floatParams[9] = params.blackHoleSoftening || 0;
            this.memory.floatParams[PhysicsMemory.PARAM_ACTIVE_COUNT] = params.activeCount;
            this.memory.floatParams[PhysicsMemory.PARAM_USE_ACTIVE_PASSIVE] = params.useActivePassive ? 1 : 0;

            // Set Status to COMPUTING and Notify
            Atomics.store(this.memory.flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_COMPUTING);
            Atomics.notify(this.memory.flags, PhysicsMemory.FLAG_STATUS);
        }
    }
}
