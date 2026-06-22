/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // happy-dom gives us `document`/`window` so we can exercise the engine
        // fallback bookkeeping and the UI banner/notification code paths.
        environment: 'happy-dom',
        include: ['src/**/*.{test,spec}.ts'],
    },
});
