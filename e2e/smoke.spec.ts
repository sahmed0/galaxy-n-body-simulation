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
    params: { engineType: string };
    workerBridge: { getCompletedSteps(): number } | null;
}

/** Reads `state.positionX[i]` from the live manager (null if not yet available). */
function samplePosition(page: Page, i: number): Promise<number | null> {
    return page.evaluate((idx) => {
        const sim = (window as unknown as { __sim?: SimHandle }).__sim;
        return sim ? sim.state.positionX[idx] : null;
    }, i);
}

/** Navigates to the sim and waits for it to boot (manager exposed + a live FPS reading). */
async function bootSim(page: Page): Promise<void> {
    await page.goto('/sim.html');
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
