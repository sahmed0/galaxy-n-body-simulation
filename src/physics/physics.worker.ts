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

        console.log('[PhysicsWorker] Initialised');

        // Enter the infinite wait/notify cycle, blocking efficiently instead of spinning.
        loop();
    } else if (type === 'PING') {
        self.postMessage({ type: 'PONG' });
    }
};

function loop() {
    if (!memory || !state || !engine) return;

    const flags = memory.flags;
    const floatParams = memory.floatParams;

    // Enter infinite loop waiting for work
    while (true) {
        // Leverage Atomics to block this thread completely at a hardware level without CPU burn 
        // until the main thread manually wakes us up by overriding the IDLE flag to COMPUTING.
        Atomics.wait(flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_IDLE);

        // After waking up, double check we are in COMPUTING state
        if (Atomics.load(flags, PhysicsMemory.FLAG_STATUS) === PhysicsMemory.STATUS_COMPUTING) {

            // Read params from shared memory
            // Indices: 0=Status, 1=Gravity, 2=dt, 3=Softening, 4=Theta, 5=MassThreshold
            // 6=dmStrength, 7=dmCoreRadius, 8=blackHoleMass, 9=blackHoleSoftening
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
                activeCount: 1000,          // Deprecated in Worker context; Barnes-Hut intrinsically handles this
                useActivePassive: true,     // Handled internally by massThreshold
            };

            // Run Physics
            engine.update(params.dt, params);

            // Unblock the main thread sequence cleanly by restoring the flag, 
            // alerting presentation logic that new array values safely exist.
            Atomics.store(flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_IDLE);
            Atomics.notify(flags, PhysicsMemory.FLAG_STATUS);
        }
    }
}
