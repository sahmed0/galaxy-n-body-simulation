/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Worker SAB protocol test. Drives the worker's per-step service directly - no real
 * Worker thread - so the exact handshake the off-thread engine relies on is verified
 * deterministically: the main thread writes params + flips the status flag to COMPUTING,
 * the worker computes into the shared arrays, records the completed-step count and step
 * duration, and flips the flag back to IDLE. Node has SharedArrayBuffer but no
 * `crossOriginIsolated`, so we hand PhysicsMemory an explicit SharedArrayBuffer.
 *
 * The manager-side debit accounting (advancePhysics) is covered here too, with a stub
 * bridge, to prove simulated time advances only by *completed* worker steps.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsMemory } from '../../src/physics/PhysicsMemory';
import { PhysicsState } from '../../src/physics/PhysicsState';
import { BarnesHutEngine } from '../../src/physics';
import { serviceOneStep } from '../../src/physics/physics.worker';
import { SimulationManager } from '../../src/state';
import type { PhysicsParams } from '../../src/physics/types';

const N = 64;

/** Allocates a shared-buffer-backed PhysicsMemory sized for N bodies. */
function makeSharedMemory(n: number): PhysicsMemory {
    const bytes = (8 * n + 256) * 4;
    return new PhysicsMemory(n, new SharedArrayBuffer(bytes));
}

/** Seeds two separated clusters so a single gravity step measurably moves everything. */
function seedTwoClusters(memory: PhysicsMemory, n: number): void {
    for (let i = 0; i < n; i++) {
        const left = i < n / 2;
        memory.positionX[i] = left ? -20 + (i % 8) : 20 + (i % 8);
        memory.positionY[i] = (i % 8) - 4;
        memory.velocityX[i] = 0;
        memory.velocityY[i] = 0;
        memory.mass[i] = 1;
    }
}

/** Default params a step is run with (mirrors the galaxy/accretion float slots). */
function defaultParams(): PhysicsParams {
    return {
        gravity: 1.0,
        dt: 0.016,
        softening: 0.5,
        theta: 1.0,
        massThreshold: 0,
        activeCount: N,
        useActivePassive: false,
        dmStrength: 0,
        dmCoreRadius: 0,
        blackHoleMass: 0,
        blackHoleSoftening: 0,
    };
}

/** Replicates WorkerBridge.step's shared-memory writes, then flips the flag to COMPUTING. */
function postStep(memory: PhysicsMemory, params: PhysicsParams): void {
    const f = memory.floatParams;
    f[1] = params.gravity;
    f[2] = params.dt;
    f[3] = params.softening;
    f[4] = params.theta;
    f[5] = params.massThreshold ?? 0;
    f[6] = params.dmStrength ?? 0;
    f[7] = params.dmCoreRadius ?? 0;
    f[8] = params.blackHoleMass ?? 0;
    f[9] = params.blackHoleSoftening ?? 0;
    f[PhysicsMemory.PARAM_ACTIVE_COUNT] = params.activeCount;
    f[PhysicsMemory.PARAM_USE_ACTIVE_PASSIVE] = params.useActivePassive ? 1 : 0;
    Atomics.store(memory.flags, PhysicsMemory.FLAG_STATUS, PhysicsMemory.STATUS_COMPUTING);
}

describe('worker SAB protocol', () => {
    it('round-trips one step: computes, counts, and returns to IDLE', () => {
        const memory = makeSharedMemory(N);
        seedTwoClusters(memory, N);
        const state = new PhysicsState(N, memory);
        const engine = new BarnesHutEngine(state);

        const before = memory.positionX.slice();
        postStep(memory, defaultParams());

        const ran = serviceOneStep(memory, engine);

        expect(ran).toBe(true);
        // Positions moved (gravity pulled the two clusters together).
        let moved = false;
        for (let i = 0; i < N; i++) {
            if (memory.positionX[i] !== before[i]) { moved = true; break; }
        }
        expect(moved).toBe(true);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STEPS_DONE)).toBe(1);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STATUS)).toBe(PhysicsMemory.STATUS_IDLE);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STEP_US)).toBeGreaterThan(0);
    });

    it('does nothing while the status is IDLE (no double-count)', () => {
        const memory = makeSharedMemory(N);
        seedTwoClusters(memory, N);
        const state = new PhysicsState(N, memory);
        const engine = new BarnesHutEngine(state);

        // Nothing posted: status is IDLE.
        expect(serviceOneStep(memory, engine)).toBe(false);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STEPS_DONE)).toBe(0);

        // One real step, then a second call while IDLE must not re-run.
        postStep(memory, defaultParams());
        expect(serviceOneStep(memory, engine)).toBe(true);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STEPS_DONE)).toBe(1);
        expect(serviceOneStep(memory, engine)).toBe(false);
        expect(Atomics.load(memory.flags, PhysicsMemory.FLAG_STEPS_DONE)).toBe(1);
    });

    it('passes the float-slot params through to the engine step', () => {
        const memory = makeSharedMemory(N);
        const params: PhysicsParams = {
            gravity: 2.5,
            dt: 0.021,
            softening: 0.75,
            theta: 0.8,
            massThreshold: 3,
            activeCount: 42,
            useActivePassive: true,
            dmStrength: 4,
            dmCoreRadius: 5,
            blackHoleMass: 6,
            blackHoleSoftening: 7,
        };
        postStep(memory, params);

        let received: PhysicsParams | null = null;
        const stubEngine = {
            step(_dt: number, p: PhysicsParams) { received = { ...p }; },
        };

        expect(serviceOneStep(memory, stubEngine)).toBe(true);
        expect(received).not.toBeNull();
        const got = received as unknown as PhysicsParams;
        expect(got.gravity).toBeCloseTo(2.5, 4);
        expect(got.dt).toBeCloseTo(0.021, 4);
        expect(got.softening).toBeCloseTo(0.75, 4);
        expect(got.theta).toBeCloseTo(0.8, 4);
        expect(got.massThreshold).toBeCloseTo(3, 4);
        expect(got.dmStrength).toBeCloseTo(4, 4);
        expect(got.dmCoreRadius).toBeCloseTo(5, 4);
        expect(got.blackHoleMass).toBeCloseTo(6, 4);
        expect(got.blackHoleSoftening).toBeCloseTo(7, 4);
        expect(got.activeCount).toBe(42);
        expect(got.useActivePassive).toBe(true);
    });
});

describe('manager worker-step accounting (advancePhysics)', () => {
    // Reaches the private accumulator/workerStepsSeen (TS `private` is compile-time only).
    interface ManagerInternals {
        accumulator: number;
        workerStepsSeen: number;
        workerBridge: unknown;
        engine: unknown;
    }

    /** A stub bridge exposing just what advancePhysics reads. */
    function makeStubBridge() {
        return {
            kind: 'shared-state' as const,
            completed: 0,
            busy: false,
            stepCalls: 0,
            state: {} as PhysicsState,
            getCompletedSteps() { return this.completed; },
            isBusy() { return this.busy; },
            step() { this.stepCalls++; },
        };
    }

    function makeManagerOnBridge(bridge: ReturnType<typeof makeStubBridge>) {
        const sim = new SimulationManager();
        sim.params.dt = 0.016;
        const internals = sim as unknown as ManagerInternals;
        internals.workerBridge = bridge;
        internals.engine = bridge;
        return { sim, internals };
    }

    it('debits simulated time only for completed worker steps', () => {
        const bridge = makeStubBridge();
        const { sim, internals } = makeManagerOnBridge(bridge);
        const dt = sim.params.dt;

        // Frame 1: enough real time for a step; worker not busy -> one step kicked.
        sim.advancePhysics(0.05);
        expect(bridge.stepCalls).toBe(1);
        const accAfterKick = internals.accumulator;
        expect(accAfterKick).toBeGreaterThan(0);

        // Frame 2: worker busy, no step completed -> no debit, no new step.
        bridge.busy = true;
        sim.advancePhysics(0.05);
        expect(bridge.stepCalls).toBe(1);
        // Accumulator only grew (clamped to the backlog cap); nothing was debited.
        expect(internals.accumulator).toBeGreaterThanOrEqual(accAfterKick);

        // Frame 3: worker reports the step done -> exactly one dt is debited.
        bridge.busy = false;
        bridge.completed = 1;
        const accBefore = internals.accumulator;
        sim.advancePhysics(0);
        expect(internals.accumulator).toBeCloseTo(accBefore - dt, 6);
        expect(internals.workerStepsSeen).toBe(1);
    });

    it('never lets the accumulator go negative when nothing has completed', () => {
        const bridge = makeStubBridge();
        const { sim, internals } = makeManagerOnBridge(bridge);
        // No completed steps and no elapsed time: accumulator must stay at 0.
        sim.advancePhysics(0);
        expect(internals.accumulator).toBe(0);
        expect(bridge.stepCalls).toBe(0);
    });
});
