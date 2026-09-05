/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager, presetDmDefault, ENGINE_MAX_COUNT } from '../state';
import { el, elOrNull, formatRate, encodePermalink } from '../utils';
import { EnergyPanel } from './EnergyPanel';
import { isEngineType } from '../physics';
import type { EngineType } from '../physics';

/** How long the "link copied" confirmation stays up. Long enough to read, short enough
 *  not to outlive the action it confirms. */
const SHARE_BANNER_MS = 4_000;

/** Readable engine names for clamp banners. */
const ENGINE_LABEL: Record<EngineType, string> = {
    brute: 'CPU Brute Force',
    barnes: 'CPU Barnes-Hut',
    worker: 'CPU Barnes-Hut (Worker)',
    webgpu: 'GPU WebGPU',
};

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
 * Disables the worker engine option when cross-origin isolation is absent (no
 * SharedArrayBuffer, so the worker's Atomics.wait cannot run), annotating why.
 * @param select - The engine <select> element.
 */
function disableWorkerOption(select: HTMLSelectElement) {
    const workerOption = select.querySelector('option[value="worker"]') as HTMLOptionElement | null;
    if (workerOption) {
        workerOption.disabled = true;
        workerOption.textContent += ' (needs cross-origin isolation)';
    }
}

/**
 * Pending auto-hide for the *current* banner. Tracked at module scope because the banner
 * element is reused by id: a timer left running from a previous message would dismiss
 * whatever replaced it, silently cutting short a notice that asked to persist.
 */
let bannerHideTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows a dismissable banner. Reuses a single banner element so repeated notices replace
 * rather than stack. Used for engine fallbacks, star-count clamps, and share links.
 * @param message - The text to display.
 * @param autoHideMs - Dismiss automatically after this long. Omit for anything the user
 *   must act on or read at their own pace (fallback warnings, clamp notices, and the
 *   clipboard-failure URL, which they have to select by hand).
 */
function showBanner(message: string, autoHideMs?: number) {
    if (bannerHideTimer !== undefined) {
        clearTimeout(bannerHideTimer);
        bannerHideTimer = undefined;
    }

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

    if (autoHideMs !== undefined) {
        bannerHideTimer = setTimeout(() => {
            bannerHideTimer = undefined;
            banner?.remove();
        }, autoHideMs);
    }
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

    // The ΔE panel is optional: `elOrNull` (never `el`, which would throw past the
    // try/catch above and kill *all* UI wiring on a page without the button). No button
    // means no panel - nothing else here touches it.
    const energyToggle = elOrNull<HTMLButtonElement>('ui-toggle-energy');
    const energyPanel = energyToggle ? new EnergyPanel(sim) : null;
    if (energyToggle && energyPanel) {
        energyToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            energyPanel.toggle();
        });
    }

    // Share is optional for the same reason as the ΔE panel above. Everything it reads
    // off `sim` is read inside the handler, never at setup time.
    const shareBtn = elOrNull<HTMLButtonElement>('ui-share');
    if (shareBtn) {
        shareBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const hash = encodePermalink({
                seed: sim.currentSeed,
                count: sim.params.count,
                engine: sim.params.engineType,
                preset: sim.params.preset,
                gravity: sim.params.gravity,
                dmStrength: sim.params.dmStrength,
            });
            // Write the URL before copying: location.href is what gets copied, so it has
            // to be carrying the hash by then.
            history.replaceState(null, '', hash);
            try {
                // navigator.clipboard is absent outside a secure context. Optional-chaining
                // it would resolve to undefined and report success on a copy that never
                // happened, so the absence has to be an explicit throw.
                if (!navigator.clipboard) throw new Error('clipboard unavailable');
                await navigator.clipboard.writeText(location.href);
                showBanner("Link copied - reproduces this run's initial conditions", SHARE_BANNER_MS);
            } catch {
                // No clipboard access. The URL is in the address bar regardless, so show it
                // and let the user copy by hand - which they cannot do against a timer.
                showBanner(`Copy this link: ${location.href}`);
            }
        });
    }

    // The quadtree overlay toggle is only meaningful for Barnes-Hut. Own its visibility
    // here (the state layer no longer touches the DOM to update it).
    const quadTreeGroup = elOrNull<HTMLElement>('ui-quadtree-group');
    const updateQuadTreeVisibility = (engineType: EngineType) => {
        if (quadTreeGroup) {
            quadTreeGroup.style.display = engineType === 'barnes' ? 'flex' : 'none';
        }
    };

    engineSelect.value = sim.params.engineType;
    if (presetSelect) presetSelect.value = sim.params.preset;

    // WebGPU may have been ruled out during init() (which runs before setupUI):
    // reflect that immediately, and stay in sync if the device is lost later.
    if (!sim.webGpuAvailable) {
        disableGpuOption(engineSelect);
        showBanner('WebGPU unavailable - running CPU Barnes-Hut');
    }

    // The worker engine needs SharedArrayBuffer, which requires cross-origin isolation.
    // Guard the global read with typeof so it doesn't throw under the test DOM.
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
        disableWorkerOption(engineSelect);
    }
    sim.onEngineFallback = (reason: string) => {
        disableGpuOption(engineSelect);
        engineSelect.value = sim.params.engineType;
        updateQuadTreeVisibility(sim.params.engineType);
        showBanner(reason);
    };
    starsInput.value = sim.params.count.toString();
    starsInput.max = ENGINE_MAX_COUNT[sim.params.engineType].toString();
    gravityInput.value = sim.params.gravity.toString();
    if (gravityVal) gravityVal.textContent = sim.params.gravity.toFixed(1);
    darkMatterInput.value = sim.params.dmStrength.toString();
    if (darkMatterVal) darkMatterVal.textContent = sim.params.dmStrength.toFixed(0);
    if (showGridCheckbox) showGridCheckbox.checked = sim.params.shouldShowQuadTree;

    updateQuadTreeVisibility(sim.params.engineType);

    engineSelect.addEventListener('change', async (e) => {
        const target = e.target as HTMLSelectElement;
        if (!isEngineType(target.value)) return;
        const newType = target.value;

        // Each engine has its own particle budget. Switching to a lower-capacity engine
        // clamps the current count and re-inits (a smaller N requires re-allocating buffers,
        // which switchEngine alone does not do - restart rebuilds them).
        const cap = ENGINE_MAX_COUNT[newType];
        starsInput.max = cap.toString();
        const clamped = sim.params.count > cap;
        if (clamped) {
            sim.params.count = cap;
            starsInput.value = cap.toString();
            showBanner(`Star count clamped to ${cap.toLocaleString()} (${ENGINE_LABEL[newType]} limit)`);
        }

        sim.params.engineType = newType;
        updateQuadTreeVisibility(newType);
        await sim.switchEngine(newType);
        if (clamped) await sim.restart();
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
        if (isNaN(val)) return;

        const cap = ENGINE_MAX_COUNT[sim.params.engineType];
        const clamped = Math.max(1_000, Math.min(val, cap));
        if (clamped !== val) {
            target.value = clamped.toString();
            if (val > cap) {
                showBanner(`Star count clamped to ${cap.toLocaleString()} (${ENGINE_LABEL[sim.params.engineType]} limit)`);
            }
        }
        sim.params.count = clamped;
        sim.resetEnergyBaseline();
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

    // The halo potential is part of the measured energy, so changing its strength
    // redefines E₀. Only on `change` (release), mirroring the gravity slider: resetting
    // mid-drag would clear the trace on every tick.
    darkMatterInput.addEventListener('change', () => {
        sim.resetEnergyBaseline();
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
        if (energyToggle?.contains(target)) {
            return;
        }

        if (telemetryPill && controlIsland) {
            if (!telemetryPill.contains(target) && !controlIsland.contains(target)) {
                telemetryPill.classList.remove('ui-active');
                controlIsland.classList.remove('ui-active');
            }
        }

        // Separate from the block above by design: that one is fail-closed (it needs both
        // elements to exist), and the panel's close must not depend on unrelated elements.
        if (energyPanel && !energyPanel.root.contains(target)) {
            energyPanel.close();
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
    const interactionsEl = document.getElementById('tel-interactions');
    const gflopsEl = document.getElementById('tel-gflops');
    const gpuDispatchEl = document.getElementById('tel-gpu-dispatch');
    const gpuMemEl = document.getElementById('tel-gpu-mem');

    if (!fpsEl || !interactionsEl) return;

    fpsEl.innerText = fps.toFixed(1);
    fpsEl.className = 'telemetry-value';
    if (fps >= 55) fpsEl.classList.add('tel-healthy');
    else if (fps >= 30) fpsEl.classList.add('tel-warning');
    else fpsEl.classList.add('tel-critical');

    // Honest interaction rate: exact per-step pairwise count × physics steps/s.
    const interactionsPerSecond = (sim.engine.getLastInteractionCount?.() ?? 0) * sim.stepsPerSecond;
    interactionsEl.innerText = formatRate(interactionsPerSecond);

    const isGpu = !!(sim.webGpuEngine && sim.engine === sim.webGpuEngine);
    const isBrute = sim.params.engineType === 'brute' && !isGpu;

    // EST. GFLOPS is a dense-kernel convention (20 FLOP per pair); it maps cleanly to
    // brute force and the GPU, but not to Barnes-Hut tree walks, so hide it there.
    const gflopsRows = document.querySelectorAll('.gflops-row');
    if (gflopsEl && (isBrute || isGpu)) {
        gflopsRows.forEach((el) => (el as HTMLElement).style.display = 'flex');
        const gflops = (interactionsPerSecond * 20) / 1e9;
        gflopsEl.innerText = `${gflops.toFixed(2)} (@20 FLOP/pair)`;
    } else {
        gflopsRows.forEach((el) => (el as HTMLElement).style.display = 'none');
    }

    const gpuRows = document.querySelectorAll('.gpu-row');

    if (isGpu && sim.webGpuEngine) {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'flex');

        if (gpuDispatchEl) {
            const pass = sim.webGpuEngine.getLastGpuPassMs();
            gpuDispatchEl.innerText = `${pass.ms.toFixed(2)} ms (${pass.source === 'timestamp' ? 'ts' : 'approx'})`;
        }
        if (gpuMemEl) gpuMemEl.innerText = sim.webGpuEngine.getMemoryUsageMB().toFixed(2) + ' MB';
    } else {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'none');
    }

    // Worker step time: shown only while the off-thread engine is active.
    const workerRows = document.querySelectorAll('.worker-row');
    if (sim.workerBridge && sim.engine === sim.workerBridge) {
        workerRows.forEach((el) => (el as HTMLElement).style.display = 'flex');
        const workerStepEl = document.getElementById('tel-worker-step');
        if (workerStepEl) workerStepEl.innerText = sim.workerBridge.getLastStepMs().toFixed(2) + ' ms';
    } else {
        workerRows.forEach((el) => (el as HTMLElement).style.display = 'none');
    }
}
