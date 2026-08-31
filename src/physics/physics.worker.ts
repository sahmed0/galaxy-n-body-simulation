import { PhysicsState } from './PhysicsState';
/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsMemory } from './PhysicsMemory';
import { BarnesHutEngine } from './BarnesHutEngine';
import type { PhysicsParams } from './types';

// Global state in the worker
let memory: PhysicsMemory | null = null;
let state: PhysicsState | null = null;
let engine: BarnesHutEngine | null = null;

self.onmessage = (e: MessageEvent) => {
    const { type, payload } = e.data;

    if (type === 'INIT') {
        const { sab, n } = payload;

        // Wrap the raw buffer in the access structure.
        memory = new PhysicsMemory(n, sab);

        // Define state layout directly onto the shared buffer mapping arrays to prevent data desynchronisation.
        state = new PhysicsState(n, {
            positionX: memory.positionX,
            positionY: memory.positionY,
            velocityX: memory.velocityX,
            velocityY: memory.velocityY,
            mass: memory.mass,
            colors: memory.colors,
        });

        // Pre-configure the physics iteration kernel.
        engine = new BarnesHutEngine(state);

        // Enter the infinite wait/notify cycle, blocking efficiently instead of spinning.
        loop();
    }
    // No other message types exist: liveness and timing are reported through SAB
    // counters (FLAG_STEPS_DONE / FLAG_STEP_US), so the worker never needs to send
    // a message back. There is deliberately no message channel to keep alive.
};

/**
 * Services a single physics step from the shared buffer, if one is pending.
 *
 * Exported so tests can drive the exact worker-side protocol without spawning a
 * real thread. Reads the status flag; when the main thread has flipped it to
 * COMPUTING it builds params from the float slots, steps the engine, records the
 * step duration and completed-step count, then flips the status back to IDLE and
 * wakes any thread parked on the flag.
 *
 * @param memory - The shared physics memory both threads view.
 * @param engine - The Barnes-Hut engine bound to that memory's state.
 * @returns True if a step ran; false if the status was not COMPUTING.
 */
export function serviceOneStep(memory: PhysicsMemory, engine: { step(dt: number, params: PhysicsParams): void; getLastInteractionCount?(): number }): boolean {
    const flags = memory.flags;
    const floatParams = memory.floatParams;

    if (Atomics.load(flags, PhysicsMemory.FLAG_STATUS) !== PhysicsMemory.STATUS_COMPUTING) {
        return false;
    }

    // Read params from shared memory.
    // Float slots: 1=Gravity, 2=dt, 3=Softening, 4=Theta, 5=MassThreshold,
    // 6=dmStrength, 7=dmCoreRadius, 8=blackHoleMass, 9=blackHoleSoftening,
    // 12=activeCount, 13=useActivePassive.
    const params: PhysicsParams = {
        gravity: floatParams[1],
        dt: floatParams[2],
        softening: floatParams[3],
        theta: floatParams[4],
        massThreshold: floatParams[5],
        dmStrength: floatParams[6],
        dmCoreRadius: floatParams[7],
        blackHoleMass: floatParams[8],
        blackHoleSoftening: floatParams[9],
        activeCount: floatParams[PhysicsMemory.PARAM_ACTIVE_COUNT],
        useActivePassive: floatParams[PhysicsMemory.PARAM_USE_ACTIVE_PASSIVE] !== 0,
    };

    const t0 = performance.now();
    engine.step(params.dt, params);
    // Plain store: FLAG_STEP_US is a diagnostic read by the UI, not a synchronisation
    // point, so it needs no atomic ordering guarantee.
    flags[PhysicsMemory.FLAG_STEP_US] = Math.round((performance.now() - t0) * 1000);
    // Surface the engine's per-step interaction count to the main thread for telemetry
    // (float slot; a plain diagnostic write, like FLAG_STEP_US).
    floatParams[PhysicsMemory.PARAM_INTERACTIONS] = engine.getLastInteractionCount?.() ?? 0;
    Atomics.add(flags, PhysicsMemory.FLAG_STEPS_DONE, 1);

    // Unblock the main thread by restoring the flag, signalling that new array
    // values safely exist.
    Atomics.store(flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_IDLE);
    Atomics.notify(flags, PhysicsMemory.FLAG_STATUS);
    return true;
}

function loop() {
    if (!memory || !engine) return;

    const flags = memory.flags;

    // Block forever on the status flag. This is correct and intentional: no further
    // messages are ever sent to this worker (see onmessage), so there is no message
    // loop to starve. Teardown is WorkerBridge.dispose -> worker.terminate(), which
    // kills the thread even while it is parked here in Atomics.wait.
    while (true) {
        // Leverage Atomics to block this thread completely at a hardware level without
        // CPU burn until the main thread overrides the IDLE flag to COMPUTING.
        Atomics.wait(flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_IDLE);
        serviceOneStep(memory, engine);
    }
}
