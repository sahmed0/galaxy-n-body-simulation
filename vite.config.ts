/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    base: './',
    build: {
        target: 'esnext', // Necessary for WebGPU and modern JS features
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                sim: resolve(__dirname, 'sim.html'),
            },
        },
    },
    plugins: [
        {
            name: 'configure-response-headers',
            configureServer: (server) => {
                server.middlewares.use((_req, res, next) => {
                    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
                    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
                    next();
                });
            },
        },
    ],
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        allowedHosts: [
            'knelt-reapply-capably.ngrok-free.dev', // ngrok url for mobile testing
        ],
    },
    preview: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    worker: {
        format: 'es',
    },
});
