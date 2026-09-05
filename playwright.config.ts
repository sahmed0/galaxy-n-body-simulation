/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke-test configuration. The specs run against `pnpm preview`, which
 * serves the production build with COOP/COEP headers (see vite.config.ts), so the
 * page is cross-origin isolated and the SharedArrayBuffer worker engine is available.
 * Chromium only: CPU engines are asserted directly; WebGPU is only checked for its
 * graceful CPU fallback (CI runners have no GPU).
 */
export default defineConfig({
    testDir: './e2e',
    // Boot can involve a service-worker reload and physics warm-up; keep steps patient.
    timeout: 60_000,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
    use: {
        baseURL: 'http://localhost:4173',
        trace: 'on-first-retry',
        // The Share button writes to the clipboard. localhost is already a secure context
        // so navigator.clipboard exists; this grants the permission it would otherwise be
        // denied, which would silently push the button onto its manual-copy fallback.
        permissions: ['clipboard-read', 'clipboard-write'],
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'pnpm build && pnpm preview --port 4173',
        port: 4173,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
