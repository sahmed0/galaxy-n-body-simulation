/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // happy-dom gives us `document`/`window` so we can exercise the engine
        // fallback bookkeeping and the UI banner/notification code paths.
        environment: 'happy-dom',
        include: ['src/**/*.{test,spec}.ts', 'tests/**/*.test.ts'],
        // The self-gravitating stepping tests are CPU-heavy and run noticeably
        // slower under v8 coverage instrumentation in CI, so give them headroom
        // beyond Vitest's 5s default to avoid spurious timeouts.
        testTimeout: 30000,
    },
});
