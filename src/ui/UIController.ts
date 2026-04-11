/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager } from '../state';

/**
 * Initialises and binds HTML UI elements to simulation parameters.
 * @param sim - The SimulationManager instance.
 */
export function setupUI(sim: SimulationManager) {
    const engineSelect = document.getElementById('ui-engine') as HTMLSelectElement;
    const starsInput = document.getElementById('ui-stars') as HTMLInputElement;
    const gravityInput = document.getElementById('ui-gravity') as HTMLInputElement;
    const gravityVal = document.getElementById('ui-gravity-value') as HTMLElement;
    const darkMatterInput = document.getElementById('ui-dark-matter') as HTMLInputElement;
    const darkMatterVal = document.getElementById('ui-dark-matter-value') as HTMLElement;
    const restartBtn = document.getElementById('ui-restart') as HTMLButtonElement;
    const pauseBtn = document.getElementById('ui-pause') as HTMLButtonElement;
    const showGridCheckbox = document.getElementById('ui-show-grid') as HTMLInputElement;

    if (!engineSelect || !starsInput || !gravityInput || !darkMatterInput || !restartBtn || !pauseBtn) {
        console.error("UI elements not found!");
        return;
    }

    engineSelect.value = sim.params.engineType;
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
        sim.params.engineType = target.value;
        await sim.switchEngine(sim.params.engineType);
    });

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

    // Mobile Toggles logic
    const toggleTelemetryBtn = document.getElementById('ui-toggle-telemetry');
    const toggleControlsBtn = document.getElementById('ui-toggle-controls');
    const telemetryPill = document.getElementById('telemetry-pill');
    const controlIsland = document.getElementById('control-island');

    if (toggleTelemetryBtn && telemetryPill && controlIsland) {
        toggleTelemetryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            telemetryPill.classList.toggle('mobile-active');
            // Close controls if opening telemetry
            controlIsland.classList.remove('mobile-active');
        });
    }

    if (toggleControlsBtn && controlIsland && telemetryPill) {
        toggleControlsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            controlIsland.classList.toggle('mobile-active');
            // Close telemetry if opening controls
            telemetryPill.classList.remove('mobile-active');
        });
    }

    // Close overlays when clicking outside
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (telemetryPill && controlIsland) {
            if (!telemetryPill.contains(target) && !controlIsland.contains(target)) {
                telemetryPill.classList.remove('mobile-active');
                controlIsland.classList.remove('mobile-active');
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

    if (sim.activeEngineStr === 'gpu' && sim.webGpuEngine) {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'flex');

        if (gpuDispatchEl) gpuDispatchEl.innerText = sim.webGpuEngine.getLastDispatchTime().toFixed(2) + ' ms';
        if (gpuMemEl) gpuMemEl.innerText = sim.webGpuEngine.getMemoryUsageMB().toFixed(2) + ' MB';
    } else {
        gpuRows.forEach((el) => (el as HTMLElement).style.display = 'none');
    }
}
