import type { PhysicsEngine, PhysicsParams, InitialConditionType } from './types';
/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsMemory } from './PhysicsMemory';
import { PhysicsState } from './PhysicsState';

/**
 * Acts as an interfacial broker connecting a running Web Worker physics loop
 * asynchronously to the main application render cycle via SharedArrayBuffer.
 */
export class WorkerBridge implements PhysicsEngine {
    private worker: Worker;
    private memory: PhysicsMemory;
    private state: PhysicsState;
    private pingInterval: number | null = null;
    private lastPingTime = 0;
    private lastLatencyMs = 0;

    /**
     * Mounts the Worker instance and dispatches fundamental configurations.
     * @param memory - Structured wrapper for SharedArrayBuffer components interacting with the worker thread.
     */
    constructor(memory: PhysicsMemory) {
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
                sab: this.memory.sab,
                n: this.state.n
            }
        });

        this.worker.onmessage = (e: MessageEvent) => {
            if (e.data.type === 'PONG') {
                this.lastLatencyMs = performance.now() - this.lastPingTime;
            }
        };

        this.pingInterval = setInterval(() => {
            this.lastPingTime = performance.now();
            this.worker.postMessage({ type: 'PING' });
        }, 1000) as any;

        console.log('[WorkerBridge] Worker spawned and memory shared.');
    }

    /**
     * Closes network communication bridging local state cleanly with isolated logic contexts.
     */
    public destroy(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        this.worker.terminate();
    }

    /**
     * Retains ping tracker analysis of internal data synchronisation rates.
     * @returns Evaluation delay in milliseconds separating logical context bridges.
     */
    public getLastPingLatency(): number {
        return this.lastLatencyMs;
    }

    /**
     * Maps coordinate variables internally reflecting initial physical arrangements globally.
     * @param _n - Non-utilized counter inherited from the Interface syntax wrapper.
     * @param initialConditions - Coordinate structure populating baseline worker structures asynchronously.
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
     * Asynchronously offloads compute processing without blocking presentation threads using atomic status signaling.
     * @param dt - Loop frequency evaluation parameter.
     * @param params - Variables mapped dynamically and monitored locally inside workers using standard float arrays.
     */
    public update(dt: number, params: PhysicsParams): void {
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

            // Set Status to COMPUTING and Notify
            Atomics.store(this.memory.flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_COMPUTING);
            Atomics.notify(this.memory.flags, PhysicsMemory.FLAG_STATUS);
        }
    }

    /**
     * Inspects active synchronized internal tracking components evaluating local horizontal distances.
     * @returns A float collection reflecting element coordinates continuously updated by the separate worker thread.
     */
    public getPositions(): Float32Array {
        return this.state.positionX;
    }

    /**
     * Queries internal variables exposing mathematical drift calculated over recent worker iterations.
     * @returns A float collection reflecting positional inertia continuously updated by the separate worker thread.
     */
    public getVelocities(): Float32Array {
        return this.state.velocityX;
    }

    /**
     * Returns the full proxy wrapper holding continuous array structures bound via SharedArrayBuffer.
     * @returns Local PhysicsState view tracking continuous worker states lock-free.
     */
    public getState(): PhysicsState {
        return this.state;
    }
}
