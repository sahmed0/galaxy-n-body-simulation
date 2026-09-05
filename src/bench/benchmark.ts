/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager, ENGINE_MAX_COUNT } from '../state';
import { PhysicsState } from '../physics';
import { mulberry32 } from '../utils';
import type { EngineType, PhysicsParams } from '../physics';

/**
 * One benchmark configuration: an engine, an optional GPU kernel variant, and a body count.
 */
interface BenchConfig {
    engine: EngineType;
    kernel: 'naive' | 'tiled' | '-';
    n: number;
}

/**
 * A completed measurement for one {@link BenchConfig}.
 */
interface BenchResult {
    config: BenchConfig;
    stepsPerSecond: number;
    frameMs: number;
    gpuPassMs: number | null;
}

const WARMUP_MS = 2000;
const MEASURE_MS = 5000;

/**
 * Fixed seed for every swept config. restart() draws a fresh seed by default, which would
 * hand each config a different realization and make the timings incomparable - the whole
 * point of the sweep is that only the engine and N vary. Note an identical seed still
 * yields different initial conditions across different N (the count drives the number of
 * draws); it is engines *at the same N* that this makes comparable.
 */
const BENCH_SEED = 0x5eed1234;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Builds the sweep. Worker configs are dropped without cross-origin isolation (no
 * SharedArrayBuffer); the caller drops the GPU configs when no device is available.
 */
function buildConfigs(coi: boolean): BenchConfig[] {
    const configs: BenchConfig[] = [
        { engine: 'brute', kernel: '-', n: 5000 },
        { engine: 'brute', kernel: '-', n: 10000 },
        { engine: 'brute', kernel: '-', n: 20000 },
        { engine: 'barnes', kernel: '-', n: 10000 },
        { engine: 'barnes', kernel: '-', n: 20000 },
        { engine: 'barnes', kernel: '-', n: 50000 },
    ];
    if (coi) {
        configs.push(
            { engine: 'worker', kernel: '-', n: 10000 },
            { engine: 'worker', kernel: '-', n: 20000 },
            { engine: 'worker', kernel: '-', n: 50000 },
        );
    }
    for (const kernel of ['naive', 'tiled'] as const) {
        for (const n of [10000, 50000, 100000, 200000]) {
            configs.push({ engine: 'webgpu', kernel, n });
        }
    }
    return configs;
}

/**
 * Framework-free `?bench` overlay: sweeps engine/count configurations and emits a
 * copyable GitHub-markdown table, plus a naive-vs-tiled GPU kernel parity check.
 * The measured numbers are provisional local evidence only - never README figures.
 * @param sim - The running simulation manager to drive.
 */
export function initBench(sim: SimulationManager): void {
    const coi = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

    const overlay = document.createElement('div');
    overlay.id = 'bench-overlay';
    overlay.className = 'tactical-glass bench-overlay ui-active';
    overlay.innerHTML = `
        <h2 class="bench-title">Benchmark</h2>
        <div class="bench-controls">
            <button id="bench-run" class="tactical-button">Run benchmark</button>
            <button id="bench-parity" class="tactical-button">Kernel parity check</button>
            <button id="bench-copy" class="tactical-button">Copy markdown</button>
            <button id="bench-close" class="tactical-button">Close</button>
        </div>
        <div id="bench-progress" class="bench-progress">Idle.</div>
        <textarea id="bench-output" class="tactical-input bench-output" readonly
            placeholder="Results appear here as a GitHub-markdown table."></textarea>
    `;
    document.body.appendChild(overlay);

    const runBtn = overlay.querySelector<HTMLButtonElement>('#bench-run')!;
    const parityBtn = overlay.querySelector<HTMLButtonElement>('#bench-parity')!;
    const copyBtn = overlay.querySelector<HTMLButtonElement>('#bench-copy')!;
    const closeBtn = overlay.querySelector<HTMLButtonElement>('#bench-close')!;
    const progressEl = overlay.querySelector<HTMLDivElement>('#bench-progress')!;
    const outputEl = overlay.querySelector<HTMLTextAreaElement>('#bench-output')!;

    const setBusy = (busy: boolean) => {
        runBtn.disabled = busy;
        parityBtn.disabled = busy;
    };

    /** Runs the sim for `ms`, averaging steps/s (+ GPU pass ms) and measuring frame ms. */
    function measure(ms: number, isGpu: boolean): Promise<{ steps: number; frameMs: number; gpu: number | null }> {
        return new Promise((resolve) => {
            let frames = 0;
            const stepSamples: number[] = [];
            const gpuSamples: number[] = [];
            const start = performance.now();
            let lastSample = start;
            const tick = () => {
                frames++;
                const now = performance.now();
                if (now - lastSample >= 250) {
                    stepSamples.push(sim.stepsPerSecond);
                    if (isGpu && sim.webGpuEngine) gpuSamples.push(sim.webGpuEngine.getLastGpuPassMs().ms);
                    lastSample = now;
                }
                if (now - start >= ms) {
                    const fps = frames / ((now - start) / 1000);
                    resolve({
                        steps: mean(stepSamples),
                        frameMs: fps > 0 ? 1000 / fps : 0,
                        gpu: isGpu ? mean(gpuSamples) : null,
                    });
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    }

    async function runSweep(): Promise<void> {
        setBusy(true);
        outputEl.value = '';
        const configs = buildConfigs(coi);
        const results: BenchResult[] = [];
        let gpuUnavailable = false;

        for (let i = 0; i < configs.length; i++) {
            const cfg = configs[i];
            if (cfg.engine === 'webgpu' && gpuUnavailable) continue;

            progressEl.textContent = `(${i + 1}/${configs.length}) ${cfg.engine}` +
                `${cfg.kernel !== '-' ? ` (${cfg.kernel})` : ''} @ ${cfg.n.toLocaleString()} …`;

            sim.params.engineType = cfg.engine;
            sim.params.count = Math.min(cfg.n, ENGINE_MAX_COUNT[cfg.engine]);
            await sim.restart(BENCH_SEED);

            // The GPU engine falls back to a CPU engine when no device exists.
            if (cfg.engine === 'webgpu' && (!sim.webGpuEngine || sim.engine !== sim.webGpuEngine)) {
                gpuUnavailable = true;
                progressEl.textContent = 'WebGPU unavailable - skipping GPU configs.';
                continue;
            }
            if (cfg.engine === 'webgpu' && sim.webGpuEngine && cfg.kernel !== '-') {
                sim.webGpuEngine.kernelMode = cfg.kernel;
            }

            await sleep(WARMUP_MS);
            const m = await measure(MEASURE_MS, cfg.engine === 'webgpu');
            results.push({ config: cfg, stepsPerSecond: m.steps, frameMs: m.frameMs, gpuPassMs: m.gpu });
        }

        outputEl.value = renderMarkdown(results);
        progressEl.textContent = `Done - ${results.length} configs measured.`;
        setBusy(false);
    }

    async function runParity(): Promise<void> {
        setBusy(true);
        progressEl.textContent = 'Parity check: preparing GPU engine …';

        // Ensure the GPU engine is live (bench parity is GPU-only).
        if (!sim.webGpuEngine || sim.engine !== sim.webGpuEngine) {
            sim.params.engineType = 'webgpu';
            sim.params.count = 4096;
            await sim.restart(BENCH_SEED);
        }
        const gpu = sim.webGpuEngine;
        if (!gpu || sim.engine !== gpu) {
            progressEl.textContent = 'WebGPU unavailable - parity check skipped.';
            setBusy(false);
            return;
        }

        // Pause the manager so its render loop does not step the engine underneath us.
        const wasPaused = sim.params.isPaused;
        sim.params.isPaused = true;

        const n = 4096;
        const ics = buildParityICs(n);
        const params: PhysicsParams = {
            gravity: 1, dt: 0.016, softening: 1, activeCount: n, useActivePassive: false,
            theta: 1, dmStrength: 0, dmCoreRadius: 50, blackHoleMass: 0, blackHoleSoftening: 1,
            cameraX: 0, cameraY: 0, cameraZoom: 1, cameraTilt: 0.6,
        };

        gpu.kernelMode = 'naive';
        gpu.setParticles(n, ics, n);
        gpu.step(params.dt, params);
        const naive = await gpu.readParticles();

        gpu.kernelMode = 'tiled';
        gpu.setParticles(n, ics, n);
        gpu.step(params.dt, params);
        const tiled = await gpu.readParticles();

        gpu.kernelMode = 'tiled'; // restore default
        sim.params.isPaused = wasPaused;

        if (!naive || !tiled) {
            progressEl.textContent = 'Parity check failed to read GPU buffers back.';
            setBusy(false);
            return;
        }

        // RMS position delta (each particle is packed as [x, y, vx, vy]).
        let sumSq = 0;
        for (let i = 0; i < n; i++) {
            const dx = naive[i * 4 + 0] - tiled[i * 4 + 0];
            const dy = naive[i * 4 + 1] - tiled[i * 4 + 1];
            sumSq += dx * dx + dy * dy;
        }
        const rms = Math.sqrt(sumSq / n);
        const pass = rms < 1e-3;
        const line = `Kernel parity (N=${n}): RMS Δpos = ${rms.toExponential(3)} - ${pass ? 'PASS' : 'FAIL'} (< 1e-3)`;
        progressEl.textContent = line;
        outputEl.value = `${line}\n\n${outputEl.value}`;
        setBusy(false);
    }

    runBtn.addEventListener('click', () => { void runSweep(); });
    parityBtn.addEventListener('click', () => { void runParity(); });
    copyBtn.addEventListener('click', () => { void navigator.clipboard?.writeText(outputEl.value); });
    closeBtn.addEventListener('click', () => { overlay.remove(); });
}

/** Deterministic 2-D cluster used only by the kernel parity check. */
function buildParityICs(n: number): PhysicsState {
    const state = new PhysicsState(n);
    const rand = mulberry32(0x9e3779b9);
    for (let i = 0; i < n; i++) {
        const r = 50 + rand() * 200;
        const theta = rand() * Math.PI * 2;
        state.positionX[i] = Math.cos(theta) * r;
        state.positionY[i] = Math.sin(theta) * r;
        state.velocityX[i] = (rand() - 0.5) * 0.2;
        state.velocityY[i] = (rand() - 0.5) * 0.2;
        state.mass[i] = 1;
        state.colors[i * 3 + 0] = 1;
        state.colors[i * 3 + 1] = 1;
        state.colors[i * 3 + 2] = 1;
    }
    return state;
}

/** Renders the results as a GitHub-markdown table with a provenance header and JSON detail. */
function renderMarkdown(results: BenchResult[]): string {
    const header = `<!-- ${navigator.userAgent} - ${new Date().toISOString()} -->`;
    const rows = results.map((r) => {
        const gpu = r.gpuPassMs === null ? '-' : r.gpuPassMs.toFixed(3);
        return `| ${r.config.engine} | ${r.config.kernel} | ${r.config.n} | ` +
            `${r.stepsPerSecond.toFixed(1)} | ${r.frameMs.toFixed(2)} | ${gpu} |`;
    });
    const table = [
        '| engine | kernel | N | steps/s | frame ms | GPU pass ms |',
        '|---|---|---|---|---|---|',
        ...rows,
    ].join('\n');
    const json = JSON.stringify(results, null, 2);
    return `${header}\n\n${table}\n\n<details>\n<summary>JSON</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>\n`;
}
