/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager, presetDmDefault } from '../state';
import { el, elOrNull } from '../utils';
import type { EngineType } from '../physics';

/** Narrows a raw `<select>` value to a valid {@link EngineType}. */
function isEngineType(v: string): v is EngineType {
    return v === 'brute' || v === 'barnes' || v === 'webgpu' || v === 'worker';
}

/**
 * Disables the "GPU: WebGPU" option in the engine dropdown so it can no longer
 * be selected once WebGPU has been ruled out.
 * @param select - The engine <select> element.
 */
function disableGpuOption(select: HTMLSelectElement) {
    const gpuOption = select.querySelector('option[value="webgpu"]') as HTMLOptionElement | null;
    if (gpuOption) {
        gpuOption.disabled = true;
        gpuOption.textContent = 'GPU: WebGPU (unavailable)';
    }
}

/**
 * Shows a transient, dismissable banner notifying the user of an engine change
 * (e.g. a forced fallback from WebGPU to a CPU engine). Reuses a single banner
 * element so repeated notices replace rather than stack.
 * @param message - The text to display.
 */
function showEngineBanner(message: string) {
    let banner = document.getElementById('engine-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'engine-banner';
        banner.className = 'engine-banner tactical-glass';
        banner.setAttribute('role', 'alert');
        document.body.appendChild(banner);
    }
    banner.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'engine-banner-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => banner?.remove());
    banner.appendChild(closeBtn);
}

/**
 * Initialises and binds HTML UI elements to simulation parameters.
 * @param sim - The SimulationManager instance.
 */
export function setupUI(sim: SimulationManager) {
    // Required controls: if any is missing the template is broken, so `el` throws
    // and we bail out (preserving the old fail-soft behaviour of logging + return).
    let engineSelect: HTMLSelectElement;
    let starsInput: HTMLInputElement;
    let gravityInput: HTMLInputElement;
    let darkMatterInput: HTMLInputElement;
    let restartBtn: HTMLButtonElement;
    let pauseBtn: HTMLButtonElement;
    try {
        engineSelect = el<HTMLSelectElement>('ui-engine');
        starsInput = el<HTMLInputElement>('ui-stars');
        gravityInput = el<HTMLInputElement>('ui-gravity');
        darkMatterInput = el<HTMLInputElement>('ui-dark-matter');
        restartBtn = el<HTMLButtonElement>('ui-restart');
        pauseBtn = el<HTMLButtonElement>('ui-pause');
    } catch (err) {
        console.error('UI elements not found!', err);
        return;
    }

    // Optional controls: absent is acceptable, so each call site null-guards them.
    const presetSelect = elOrNull<HTMLSelectElement>('ui-preset');
    const gravityVal = elOrNull<HTMLElement>('ui-gravity-value');
    const darkMatterVal = elOrNull<HTMLElement>('ui-dark-matter-value');
    const showGridCheckbox = elOrNull<HTMLInputElement>('ui-show-grid');

    engineSelect.value = sim.params.engineType;
    if (presetSelect) presetSelect.value = sim.params.preset;

    // WebGPU may have been ruled out during init() (which runs before setupUI):
    // reflect that immediately, and stay in sync if the device is lost later.
    if (!sim.webGpuAvailable) {
        disableGpuOption(engineSelect);
        showEngineBanner('WebGPU unavailable - running CPU Barnes-Hut');
    }
    sim.onEngineFallback = (reason: string) => {
        disableGpuOption(engineSelect);
        engineSelect.value = sim.params.engineType;
        showEngineBanner(reason);
    };
    starsInput.value = sim.params.count.toString();
    gravityInput.value = sim.params.gravity.toString();
    if (gravityVal) gravityVal.textContent = sim.params.gravity.toFixed(1);
    darkMatterInput.value = sim.params.dmStrength.toString();
    if (darkMatterVal) darkMatterVal.textContent = sim.params.dmStrength.toFixed(0);
    if (showGridCheckbox) showGridCheckbox.checked = sim.params.shouldShowQuadTree;

    const quadTreeGroup = document.getElementById('ui-quadtree-group');
    if (quadTreeGroup) {
        quadTreeGroup.style.display = sim.params.engineType === 'barnes' ? 'flex' : 'none';
    }

    engineSelect.addEventListener('change', async (e) => {
        const target = e.target as HTMLSelectElement;
        if (!isEngineType(target.value)) return;
        sim.params.engineType = target.value;
        await sim.switchEngine(sim.params.engineType);
    });

    if (presetSelect) {
        presetSelect.addEventListener('change', async (e) => {
            const target = e.target as HTMLSelectElement;
            sim.params.preset = target.value as 'accretion' | 'galaxy';
            // Reset *only* DM to the new preset's default (galaxy keeps its halo,
            // accretion turns it off), preserving Stars & Gravity. This DM reset
            // lives here only - the plain Restart button preserves all user state.
            sim.params.dmStrength = presetDmDefault(sim.params.preset);
            darkMatterInput.value = sim.params.dmStrength.toString();
            if (darkMatterVal) darkMatterVal.textContent = sim.params.dmStrength.toFixed(0);
            // Changing the preset rebuilds the initial conditions.
            await sim.restart();
        });
    }

    starsInput.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const val = parseInt(target.value, 10);
        if (!isNaN(val) && val > 0) {
            sim.params.count = val;
        }
    });

    gravityInput.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        sim.params.gravity = parseFloat(target.value);
        if (gravityVal) gravityVal.textContent = sim.params.gravity.toFixed(1);
    });

    // The leapfrog half-step stagger and adaptive dt both depend on G, so once the
    // user releases the slider re-stagger velocities to reconcile them (doing this
    // on every `input` tick mid-drag would jolt the sim repeatedly).
    gravityInput.addEventListener('change', () => {
        sim.softResetVelocities();
    });

    darkMatterInput.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        sim.params.dmStrength = parseFloat(target.value);
        if (darkMatterVal) darkMatterVal.textContent = sim.params.dmStrength.toFixed(0);
    });

    if (showGridCheckbox) {
        showGridCheckbox.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            sim.params.shouldShowQuadTree = target.checked;
        });
    }

    pauseBtn.addEventListener('click', () => {
        sim.params.isPaused = !sim.params.isPaused;
        pauseBtn.textContent = sim.params.isPaused ? 'Resume' : 'Pause';
        if (sim.params.isPaused) {
            pauseBtn.style.color = '#ff5722';
            pauseBtn.style.borderColor = '#ff5722';
        } else {
            pauseBtn.style.color = '';
            pauseBtn.style.borderColor = '';
        }
    });

    restartBtn.addEventListener('click', async () => {
        await sim.restart();
    });

    // Universal Toggles Logic
    const toggleTelemetryBtn = document.getElementById('ui-toggle-telemetry');
    const toggleControlsBtn = document.getElementById('ui-toggle-controls');
    const telemetryPill = document.getElementById('telemetry-pill');
    const controlIsland = document.getElementById('control-island');
    const togglePinBtn = document.getElementById('ui-toggle-pin');
    
    let isPinned = window.innerWidth > 768;

    const applyPinState = () => {
        if (togglePinBtn) {
            if (isPinned) {
                togglePinBtn.classList.add('pinned');
            } else {
                togglePinBtn.classList.remove('pinned');
            }
        }
    };

    applyPinState();

    if (isPinned && controlIsland) {
        // By default on large displays, show controls
        controlIsland.classList.add('ui-active');
    }

    if (isPinned && telemetryPill) {
        telemetryPill.classList.add('ui-active');
    }

    if (togglePinBtn) {
        togglePinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isPinned = !isPinned;
            applyPinState();
        });
    }

    if (toggleTelemetryBtn && telemetryPill && controlIsland) {
        toggleTelemetryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            telemetryPill.classList.toggle('ui-active');
        });
    }

    if (toggleControlsBtn && controlIsland && telemetryPill) {
        toggleControlsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            controlIsland.classList.toggle('ui-active');
        });
    }

    // Close overlays when clicking canvas or outside
    document.addEventListener('click', (e) => {
        if (isPinned) return;

        const target = e.target as HTMLElement;
        if (toggleTelemetryBtn?.contains(target) || toggleControlsBtn?.contains(target)) {
            return;
        }

        if (telemetryPill && controlIsland) {
            if (!telemetryPill.contains(target) && !controlIsland.contains(target)) {
                telemetryPill.classList.remove('ui-active');
                controlIsland.classList.remove('ui-active');
            }
        }
    });
}

/**
 * Updates telemetry UI elements with the latest performance metrics.
 * @param fps - The current frames per second.
 * @param sim - The SimulationManager instance.
 */
export function updateTelemetry(fps: number, sim: SimulationManager) {
    const fpsEl = document.getElementById('tel-fps');
    const gflopsEl = document.getElementById('tel-gflops');
    const gpuDispatchEl = document.getElementById('tel-gpu-dispatch');
    const gpuMemEl = document.getElementById('tel-gpu-mem');

    if (!fpsEl || !gflopsEl) return;

    fpsEl.innerText = fps.toFixed(1);
    fpsEl.className = 'telemetry-value';
    if (fps >= 55) fpsEl.classList.add('tel-healthy');
    else if (fps >= 30) fpsEl.classList.add('tel-warning');
    else fpsEl.classList.add('tel-critical');

    const gflops = (sim.params.activeCount * sim.params.count * 2 * fps) / 1e9;
    gflopsEl.innerText = gflops.toFixed(2) + ' GFLOPs';

    const gpuRows = document.querySelectorAll('.gpu-row');

    if (sim.webGpuEngine && sim.engine === sim.webGpuEngine) {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'flex');

        if (gpuDispatchEl) gpuDispatchEl.innerText = sim.webGpuEngine.getLastDispatchTime().toFixed(2) + ' ms';
        if (gpuMemEl) gpuMemEl.innerText = sim.webGpuEngine.getMemoryUsageMB().toFixed(2) + ' MB';
    } else {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'none');
    }
}
