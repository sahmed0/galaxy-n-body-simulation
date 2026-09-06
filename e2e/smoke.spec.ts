/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Real-browser smoke tests. These guard the seams a unit test cannot see: the page
 * boots without console errors, every CPU engine actually advances the shared state
 * over time, the GPU engine either runs or falls back gracefully, and the star-count
 * clamp fires in the live DOM. Run against `pnpm preview` (cross-origin isolated, so
 * the SharedArrayBuffer worker engine is available).
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/** Messages tolerated in the console-error check: a CI runner has no usable GPU. */
const GPU_ALLOWLIST = /webgpu|gpu|adapter|device|wgsl/i;

/** Minimal shape of the manager we expose on `window.__sim` for these tests. */
interface SimHandle {
    state: { positionX: Float32Array };
    params: { engineType: string; count: number; isPaused: boolean };
    workerBridge: { getCompletedSteps(): number } | null;
    currentSeed: number;
    initGalaxy(): void;
}

/** Reads `state.positionX[i]` from the live manager (null if not yet available). */
function samplePosition(page: Page, i: number): Promise<number | null> {
    return page.evaluate((idx) => {
        const sim = (window as unknown as { __sim?: SimHandle }).__sim;
        return sim ? sim.state.positionX[idx] : null;
    }, i);
}

/**
 * Navigates to the sim and waits for it to boot (manager exposed + a live FPS reading).
 * @param path - Where to boot; defaults to a bare sim. Pass a permalink to boot from one.
 */
async function bootSim(page: Page, path = '/sim.html'): Promise<void> {
    await page.goto(path);
    await page.waitForFunction(() => '__sim' in window, undefined, { timeout: 15_000 });
    // #tel-fps starts at "--" and becomes a positive number once the loop is running.
    await expect
        .poll(async () => page.locator('#tel-fps').textContent(), { timeout: 15_000 })
        .toMatch(/^[1-9][0-9]*$|^[0-9]+\.[0-9]+$/);
}

/** Selects an engine and waits for the switch (which restarts the sim) to settle. */
async function selectEngine(page: Page, engine: string): Promise<void> {
    await page.selectOption('#ui-engine', engine);
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __sim: SimHandle }).__sim.params.engineType))
        .not.toBe('');
    await page.waitForTimeout(600);
}

test('boots without console errors and reports a live FPS', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error' && !GPU_ALLOWLIST.test(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
        if (!GPU_ALLOWLIST.test(err.message)) errors.push(err.message);
    });

    await bootSim(page);

    expect(errors, `unexpected console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

for (const engine of ['brute', 'barnes', 'worker'] as const) {
    test(`${engine} engine advances the shared state over time`, async ({ page }) => {
        await bootSim(page);
        await selectEngine(page, engine);

        const first = await samplePosition(page, 7);
        await page.waitForTimeout(700);
        const second = await samplePosition(page, 7);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        // The state must genuinely change - a live step counter alone previously masked a
        // frozen-canvas bug, so assert the observable positions actually move.
        expect(second).not.toBe(first);

        if (engine === 'worker') {
            const steps = await page.evaluate(
                () => (window as unknown as { __sim: SimHandle }).__sim.workerBridge?.getCompletedSteps() ?? 0,
            );
            expect(steps).toBeGreaterThan(0);
        }
    });
}

test('WebGPU either runs or falls back to Barnes-Hut gracefully', async ({ page }) => {
    await bootSim(page);

    // When no usable GPU device exists (typical CI / headless), boot disables the
    // WebGPU <option> and the default webgpu engine has already fallen back to a CPU
    // engine. Otherwise the option is selectable and the engine runs on the GPU.
    const gpuDisabled = await page.locator('#ui-engine option[value="webgpu"]').isDisabled();

    if (gpuDisabled) {
        const engineType = await page.evaluate(
            () => (window as unknown as { __sim: SimHandle }).__sim.params.engineType,
        );
        expect(engineType).not.toBe('webgpu'); // gracefully fell back to a CPU engine
        // ...and the CPU sim is still animating.
        const a = await samplePosition(page, 7);
        await page.waitForTimeout(700);
        const b = await samplePosition(page, 7);
        expect(b).not.toBe(a);
        return;
    }

    await page.selectOption('#ui-engine', 'webgpu');
    // The WebGPU init is async; the engine either stays 'webgpu' or falls back to
    // 'barnes'. Wait for it to settle, then assert the matching outcome.
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __sim: SimHandle }).__sim.params.engineType), {
            timeout: 15_000,
        })
        .toMatch(/^(webgpu|barnes)$/);

    const engineType = await page.evaluate(
        () => (window as unknown as { __sim: SimHandle }).__sim.params.engineType,
    );

    if (engineType === 'webgpu') {
        await expect(page.locator('#webgpu-canvas')).toBeVisible();
    } else {
        // Graceful fallback: a banner explains it, the select reflects barnes, and the
        // CPU sim keeps animating.
        await expect(page.locator('#engine-banner')).toBeVisible();
        await expect(page.locator('#ui-engine')).toHaveValue('barnes');
        const a = await samplePosition(page, 7);
        await page.waitForTimeout(700);
        const b = await samplePosition(page, 7);
        expect(b).not.toBe(a);
    }
});

// Every CPU engine, not just barnes: the worker is the one that can silently stop
// sampling if the energy service ever drifts after advancePhysics (arming the worker
// flips it to COMPUTING, so the quiescence gate would then reject every frame). That
// failure is invisible to a unit test and shows up here as a readout stuck on '-'.
for (const engine of ['brute', 'barnes', 'worker'] as const) {
    test(`energy panel reports a live ΔE/E₀ reading on ${engine}`, async ({ page }) => {
        await bootSim(page);
        await selectEngine(page, engine);

        await page.click('#ui-toggle-energy');
        await expect(page.locator('#energy-panel')).toBeVisible();
        await expect(page.locator('#energy-panel')).toContainText('ΔE/E₀');

        // The readout starts as the placeholder and only becomes a number once a cycle
        // completes, so matching a finite scientific literal doubles as "a sample
        // landed" - i.e. the whole snapshot/chunk/baseline path ran end to end. The
        // cadence is 1 s and the galaxy default needs ~9 chunks, so 6 s is generous.
        await expect
            .poll(() => page.locator('#energy-delta').textContent(), { timeout: 6_000 })
            .toMatch(/^-?\d+\.\d+e[+-]\d+$/);
    });
}

test('energy panel shows the N/A state on the GPU engine', async ({ page }) => {
    await bootSim(page);

    // Headless Chromium has no usable GPU device, so the option is disabled and
    // selectOption would time out. Never select webgpu unconditionally.
    const gpuDisabled = await page.locator('#ui-engine option[value="webgpu"]').isDisabled();
    test.skip(gpuDisabled, 'no usable GPU device - the webgpu option is disabled');

    await selectEngine(page, 'webgpu');
    await page.click('#ui-toggle-energy');
    await expect(page.locator('#energy-panel')).toBeVisible();
    // Particle state never leaves the device: the plot is replaced by the N/A notice
    // rather than showing a stale or invented number.
    await expect(page.locator('#energy-na')).toBeVisible();
    await expect(page.locator('#energy-delta')).toHaveText('-');
});

test('bench overlay appears with ?bench', async ({ page }) => {
    // The bench harness is a separate async chunk loaded only when ?bench is present.
    // Assert the overlay mounts; do NOT run the sweep in CI (it is long and manual).
    await page.goto('/sim.html?bench');
    await page.waitForFunction(() => '__sim' in window, undefined, { timeout: 15_000 });
    await expect(page.locator('#bench-overlay')).toBeVisible();
    await expect(page.locator('#bench-run')).toBeVisible();
});

test('star-count input clamps to the brute-force cap', async ({ page }) => {
    await bootSim(page);
    await selectEngine(page, 'brute');

    const stars = page.locator('#ui-stars');
    await stars.fill('999999');
    await stars.dispatchEvent('change');

    await expect(stars).toHaveValue('20000');
});

// A CPU engine keeps these cases off the GPU path, which headless CI cannot run.
const PERMALINK = '/sim.html#s=12345&n=5000&e=barnes&p=galaxy&g=1&dm=250';

test('a permalink applies its seed, count and engine at boot', async ({ page }) => {
    await bootSim(page, PERMALINK);

    expect(await page.evaluate(() => (window as unknown as { __sim: SimHandle }).__sim.currentSeed)).toBe(12345);
    expect(await page.evaluate(() => (window as unknown as { __sim: SimHandle }).__sim.params.count)).toBe(5000);
    await expect(page.locator('#ui-engine')).toHaveValue('barnes');
});

/**
 * Reads a particle's *initial* position for the seed the page booted with.
 *
 * The live position cannot be sampled directly: by the time boot is observable the loop
 * has been stepping for an arbitrary number of frames, so two loads would be compared at
 * two different simulated times and would differ however correct the seeding is. Pausing
 * and re-initialising inside a single evaluate is synchronous, so no frame can interleave
 * and the result is the t=0 realization of `currentSeed` - which is exactly what a
 * permalink promises to reproduce.
 */
function sampleInitialPosition(page: Page, i: number): Promise<number> {
    return page.evaluate((idx) => {
        const sim = (window as unknown as { __sim: SimHandle }).__sim;
        sim.params.isPaused = true;
        sim.initGalaxy();
        return sim.state.positionX[idx];
    }, i);
}

test('the same permalink reproduces the same initial conditions across loads', async ({ page }) => {
    // The one thing no unit test can reach: the whole chain, twice, in a real
    // browser - URL hash parsed, seed applied pre-init, realization reproduced.
    await bootSim(page, PERMALINK);
    const first = await sampleInitialPosition(page, 42);

    await bootSim(page, PERMALINK);

    expect(await sampleInitialPosition(page, 42)).toBe(first);
});

test('Share copies a link carrying the running seed', async ({ page }) => {
    await bootSim(page, PERMALINK);

    await page.click('#ui-share');

    await expect(page.locator('#engine-banner')).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toContain('s=12345');
});

test('Restart draws a fresh realization', async ({ page }) => {
    await bootSim(page, PERMALINK);
    const linked = await sampleInitialPosition(page, 42);
    await page.evaluate(() => {
        (window as unknown as { __sim: SimHandle }).__sim.params.isPaused = false;
    });

    await page.click('#ui-restart');
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __sim: SimHandle }).__sim.currentSeed))
        .not.toBe(12345);

    // Compare initial conditions, not live positions: those drift with time and would
    // differ even if restart had reloaded the very same seed.
    expect(await sampleInitialPosition(page, 42)).not.toBe(linked);
});
