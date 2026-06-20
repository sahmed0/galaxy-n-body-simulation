/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Tests for the UI-side surfacing of a WebGPU fallback: disabling the GPU option
 * in the engine dropdown and showing a dismissable banner, both when WebGPU is
 * already ruled out at setup and when a runtime fallback fires later via
 * {@link SimulationManager.onEngineFallback}.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupUI } from './UIController';
import type { SimulationManager } from '../state';

/**
 * Builds the minimal DOM the UIController queries so setupUI runs fully instead
 * of bailing out at its "elements not found" guard.
 */
function mountUI() {
    document.body.innerHTML = `
        <select id="ui-engine">
            <option value="brute">CPU: Brute Force</option>
            <option value="barnes">CPU: Barnes-Hut</option>
            <option value="webgpu">GPU: WebGPU</option>
        </select>
        <select id="ui-galaxy-mode">
            <option value="core">core</option>
            <option value="selfgrav">selfgrav</option>
        </select>
        <input id="ui-stars" />
        <input id="ui-gravity" />
        <span id="ui-gravity-value"></span>
        <input id="ui-dark-matter" />
        <span id="ui-dark-matter-value"></span>
        <button id="ui-restart"></button>
        <button id="ui-pause"></button>
        <input id="ui-show-grid" type="checkbox" />
        <div id="ui-quadtree-group"></div>
    `;
}

/**
 * A lightweight SimulationManager stand-in exposing only what setupUI reads and
 * writes, so we can test the UI wiring without constructing the real manager.
 */
function makeSimStub(overrides: Partial<SimulationManager> = {}) {
    return {
        params: {
            engineType: 'webgpu',
            galaxyMode: 'core',
            count: 10000,
            gravity: 1,
            dmStrength: 400,
            shouldShowQuadTree: false,
        },
        webGpuAvailable: true,
        onEngineFallback: () => { },
        switchEngine: vi.fn(async () => { }),
        restart: vi.fn(async () => { }),
        ...overrides,
    } as unknown as SimulationManager;
}

const engineSelect = () => document.getElementById('ui-engine') as HTMLSelectElement;
const gpuOption = () =>
    engineSelect().querySelector('option[value="webgpu"]') as HTMLOptionElement;
const banner = () => document.getElementById('engine-banner');

beforeEach(() => {
    mountUI();
    vi.spyOn(console, 'error').mockImplementation(() => { });
});

describe('setupUI - WebGPU already unavailable at startup', () => {
    it('disables the GPU option and shows a fallback banner', () => {
        const sim = makeSimStub({ webGpuAvailable: false } as Partial<SimulationManager>);
        setupUI(sim);

        expect(gpuOption().disabled).toBe(true);
        expect(gpuOption().textContent).toContain('unavailable');

        const b = banner();
        expect(b).not.toBeNull();
        expect(b!.textContent).toContain('WebGPU unavailable');
        expect(b!.getAttribute('role')).toBe('alert');
    });

    it('does not disable the GPU option or show a banner when WebGPU is available', () => {
        const sim = makeSimStub();
        setupUI(sim);

        expect(gpuOption().disabled).toBe(false);
        expect(banner()).toBeNull();
    });
});

describe('setupUI - runtime fallback via onEngineFallback', () => {
    it('wires onEngineFallback to disable the GPU option, sync the select, and show the reason', () => {
        const sim = makeSimStub();
        setupUI(sim);
        expect(banner()).toBeNull();

        // Simulate the manager forcing a fallback at runtime.
        sim.params.engineType = 'barnes';
        sim.onEngineFallback('WebGPU device lost (unknown) - running CPU Barnes-Hut');

        expect(gpuOption().disabled).toBe(true);
        expect(engineSelect().value).toBe('barnes');

        const b = banner();
        expect(b).not.toBeNull();
        expect(b!.textContent).toContain('WebGPU device lost');
    });

    it('reuses a single banner element instead of stacking on repeated fallbacks', () => {
        const sim = makeSimStub();
        setupUI(sim);

        sim.onEngineFallback('first notice');
        sim.onEngineFallback('second notice');

        expect(document.querySelectorAll('#engine-banner').length).toBe(1);
        expect(banner()!.textContent).toContain('second notice');
    });

    it('removes the banner when its dismiss button is clicked', () => {
        const sim = makeSimStub();
        setupUI(sim);
        sim.onEngineFallback('dismiss me');

        const closeBtn = banner()!.querySelector('.engine-banner-close') as HTMLButtonElement;
        expect(closeBtn).not.toBeNull();
        closeBtn.click();

        expect(banner()).toBeNull();
    });
});
