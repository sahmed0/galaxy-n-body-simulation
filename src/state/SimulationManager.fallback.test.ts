/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for WebGPU failure handling and the fallback to the Barnes-Hut CPU
 * engine in {@link SimulationManager}. The WebGPU engine and renderer are mocked
 * so we can deterministically drive init failures and runtime device losses
 * without an actual GPU, and assert the bookkeeping + UI fallback callback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared, hoisted mock state so each test can steer how the mock WebGPU engine
// behaves (init succeeds vs. throws) and inspect the instances that were built.
const mockState = vi.hoisted(() => ({
    initBehavior: 'success' as 'success' | 'fail',
    instances: [] as any[],
    reset() {
        this.initBehavior = 'success';
        this.instances = [];
    },
}));

vi.mock('../physics', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../physics')>();

    // Stand-in for the real WebGPUEngine: no DOM/GPU work, just records calls
    // and honours mockState.initBehavior so a test can force init to reject with
    // the same typed error the real engine throws.
    class MockWebGPUEngine {
        onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null = null;
        init = vi.fn(async () => {
            if (mockState.initBehavior === 'fail') {
                throw new actual.WebGPUUnavailableError('mock: no usable WebGPU device');
            }
        });
        setParticles = vi.fn();
        setVisible = vi.fn();
        updateUniforms = vi.fn();
        step = vi.fn();
        render = vi.fn();
        getLastDispatchTime = () => 0;
        getMemoryUsageMB = () => 0;
        getPositions = () => new Float32Array(0);
        getVelocities = () => new Float32Array(0);
        dispose = vi.fn();
        constructor() {
            mockState.instances.push(this);
        }
    }

    class MockWorkerBridge {
        dispose = vi.fn();
        update = vi.fn();
        getPositions = () => new Float32Array(0);
        getVelocities = () => new Float32Array(0);
    }

    return { ...actual, WebGPUEngine: MockWebGPUEngine, WorkerBridge: MockWorkerBridge };
});

vi.mock('../rendering', () => {
    class MockCanvasRenderer {
        canvas = { style: { display: '' } } as unknown as HTMLCanvasElement;
        camera = { update: vi.fn(), zoom: 1, x: 0, y: 0, tilt: 0.6 };
        constructor() { /* no real canvas */ }
    }
    return { CanvasRenderer: MockCanvasRenderer, Camera: class { } };
});

import { SimulationManager } from './SimulationManager';
import { BarnesHutEngine } from '../physics';

/** Lets pending fire-and-forget promise chains (switchEngine().then(...)) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake device-loss payload matching the shape the recovery path reads. */
const lostInfo = (reason: string): GPUDeviceLostInfo =>
    ({ reason, message: 'mock loss' } as unknown as GPUDeviceLostInfo);

function makeSim() {
    const sim = new SimulationManager();
    // Keep galaxy generation cheap; the fallback logic is independent of count.
    sim.params.count = 20;
    return sim;
}

beforeEach(() => {
    mockState.reset();
    document.body.innerHTML = '';
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

describe('SimulationManager - WebGPU init success', () => {
    it('runs on the GPU engine when WebGPU initialises', async () => {
        const sim = makeSim();
        await sim.init('canvas');

        expect(sim.webGpuAvailable).toBe(true);
        expect(sim.activeEngineStr).toBe('gpu');
        expect(sim.webGpuEngine).not.toBeNull();
        expect(sim.engine).toBe(sim.webGpuEngine);
        expect(sim.params.engineType).toBe('webgpu');
    });
});

describe('SimulationManager - WebGPU init failure', () => {
    it('falls back to the Barnes-Hut CPU engine and marks WebGPU unavailable', async () => {
        mockState.initBehavior = 'fail';
        const sim = makeSim();
        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;

        await sim.init('canvas');

        expect(sim.webGpuAvailable).toBe(false);
        expect(sim.activeEngineStr).toBe('cpu');
        expect(sim.webGpuEngine).toBeNull();
        expect(sim.params.engineType).toBe('barnes');
        expect(sim.engine).toBeInstanceOf(BarnesHutEngine);
    });

    it('logs the originating error for diagnostics', async () => {
        const errSpy = vi.spyOn(console, 'error');
        mockState.initBehavior = 'fail';
        const sim = makeSim();

        await sim.init('canvas');

        expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining('WebGPU unavailable, falling back to CPU physics'),
            expect.anything(),
        );
    });
});

describe('SimulationManager.switchEngine - selecting WebGPU', () => {
    it('does not retry WebGPU once it has been ruled out, and notifies the UI', async () => {
        mockState.initBehavior = 'fail';
        const sim = makeSim();
        await sim.init('canvas'); // GPU ruled out here.

        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;
        const instancesBefore = mockState.instances.length;

        sim.params.engineType = 'webgpu';
        await sim.switchEngine('webgpu');

        // No new WebGPU engine should have been constructed.
        expect(mockState.instances.length).toBe(instancesBefore);
        expect(sim.activeEngineStr).toBe('cpu');
        expect(sim.engine).toBeInstanceOf(BarnesHutEngine);
        expect(sim.params.engineType).toBe('barnes');
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.stringContaining('WebGPU unavailable'),
        );
    });

    it('falls back and notifies the UI when a fresh WebGPU init throws', async () => {
        // Start on a CPU engine so WebGPU is still considered available.
        const sim = makeSim();
        sim.params.engineType = 'barnes';
        await sim.init('canvas');
        expect(sim.webGpuAvailable).toBe(true);

        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;

        // Now selecting WebGPU triggers an init that fails.
        mockState.initBehavior = 'fail';
        sim.params.engineType = 'webgpu';
        await sim.switchEngine('webgpu');

        expect(sim.webGpuAvailable).toBe(false);
        expect(sim.activeEngineStr).toBe('cpu');
        expect(sim.engine).toBeInstanceOf(BarnesHutEngine);
        expect(sim.params.engineType).toBe('barnes');
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.stringContaining('WebGPU failed to initialise'),
        );
    });
});

describe('SimulationManager - runtime WebGPU device loss', () => {
    it('recovers on the first loss by re-creating the device and stays on the GPU', async () => {
        const sim = makeSim();
        await sim.init('canvas');
        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;
        const gpuEngine = sim.webGpuEngine;

        // Simulate a device loss; recovery init succeeds (default behaviour).
        await (sim as any).onWebGpuDeviceLost(lostInfo('unknown'));
        await flush();

        expect(sim.webGpuAvailable).toBe(true);
        expect(sim.activeEngineStr).toBe('gpu');
        expect(sim.webGpuEngine).toBe(gpuEngine);
        expect(gpuEngine!.init).toHaveBeenCalledTimes(2); // initial + recovery
        expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('falls back to CPU when the one-time recovery re-creation also fails', async () => {
        const sim = makeSim();
        await sim.init('canvas');
        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;

        // Recovery attempt fails -> permanent fallback.
        mockState.initBehavior = 'fail';
        await (sim as any).onWebGpuDeviceLost(lostInfo('unknown'));
        await flush();

        expect(sim.webGpuAvailable).toBe(false);
        expect(sim.activeEngineStr).toBe('cpu');
        expect(sim.webGpuEngine).toBeNull();
        expect(sim.params.engineType).toBe('barnes');
        expect(sim.engine).toBeInstanceOf(BarnesHutEngine);
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.stringContaining('could not be re-created'),
        );
    });

    it('falls back to CPU on a second loss after the one-time retry is spent', async () => {
        const sim = makeSim();
        await sim.init('canvas');
        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;

        // First loss: recovers successfully, spending the one-time retry.
        await (sim as any).onWebGpuDeviceLost(lostInfo('unknown'));
        await flush();
        expect(sim.webGpuAvailable).toBe(true);
        expect(fallbackSpy).not.toHaveBeenCalled();

        // Second loss: no retry budget left -> permanent CPU fallback.
        await (sim as any).onWebGpuDeviceLost(lostInfo('destroyed'));
        await flush();

        expect(sim.webGpuAvailable).toBe(false);
        expect(sim.activeEngineStr).toBe('cpu');
        expect(sim.engine).toBeInstanceOf(BarnesHutEngine);
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.stringContaining('WebGPU device lost'),
        );
    });

    it('ignores a device-loss callback once WebGPU is already unavailable', async () => {
        mockState.initBehavior = 'fail';
        const sim = makeSim();
        await sim.init('canvas'); // Already on CPU, webGpuAvailable === false.

        const fallbackSpy = vi.fn();
        sim.onEngineFallback = fallbackSpy;

        await (sim as any).onWebGpuDeviceLost(lostInfo('unknown'));
        await flush();

        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(sim.webGpuAvailable).toBe(false);
    });
});
