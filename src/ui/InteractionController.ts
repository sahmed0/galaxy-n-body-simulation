/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager } from '../state';

/**
 * Sets up mouse and wheel interaction events for the simulation canvas panning and zooming.
 * @param sim - The SimulationManager instance.
 */
export function setupInteractions(sim: SimulationManager) {
    let isPanning = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    window.addEventListener('pointerdown', (e) => {
        console.log('Tough/Mouse Target:', e.target); // Check if this is a canvas
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        isPanning = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    });

    window.addEventListener('pointermove', (e) => {
        if (!isPanning) return;

        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;

        if (sim.renderer) {
            sim.renderer.camera.pan(dx, dy);
        }

        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    });

    window.addEventListener('pointerup', () => {
        isPanning = false;
    });

    window.addEventListener('wheel', (e) => {
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;

        // Some browsers require preventDefault for smooth zoom
        e.preventDefault();
        if (sim.renderer) {
            sim.renderer.camera.zoomAt(e.deltaY, e.clientX, e.clientY);
        }
    }, { passive: false });
}
