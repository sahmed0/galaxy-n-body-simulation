/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager } from '../state';

/**
 * Sets up mouse and wheel interaction events for the simulation canvas panning and zooming.
 * @param sim - The SimulationManager instance.
 */
/* OLD INTERACTION CODE - Worked but didn't handle multi-touch (keeping for reference) */
/* export function setupInteractions(sim: SimulationManager) {
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
} */

/* NEW INTERACTION CODE - Handles multi-touch */
export function setupInteractions(sim: SimulationManager) {
    // Store active pointers: Map<pointerId, PointerEvent>
    const activePointers = new Map<number, PointerEvent>();
    let lastMidpointX = 0;
    let lastMidpointY = 0;
    let lastDistance = 0;

    const getMidpoint = (p1: PointerEvent, p2: PointerEvent) => ({
        x: (p1.clientX + p2.clientX) / 2,
        y: (p1.clientY + p2.clientY) / 2,
    });

    const getDistance = (p1: PointerEvent, p2: PointerEvent) => {
        const dx = p1.clientX - p2.clientX;
        const dy = p1.clientY - p2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    };

    window.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        
        activePointers.set(e.pointerId, e);

        // If 2 pointers, initialise distance and midpoint
        if (activePointers.size === 2) {
            const pointers = Array.from(activePointers.values());
            lastDistance = getDistance(pointers[0], pointers[1]);
            const mid = getMidpoint(pointers[0], pointers[1]);
            lastMidpointX = mid.x;
            lastMidpointY = mid.y;
        } else if (activePointers.size === 1) {
            lastMidpointX = e.clientX;
            lastMidpointY = e.clientY;
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!activePointers.has(e.pointerId)) return;
        
        // Update the stored pointer state
        activePointers.set(e.pointerId, e);

        if (sim.renderer) {
            const camera = sim.renderer.camera;

            // HANDLE TWO-FINGER PINCH & PAN
            if (activePointers.size === 2) {
                const pointers = Array.from(activePointers.values());
                
                // 1. Zoom Logic
                const currentDistance = getDistance(pointers[0], pointers[1]);
                const distanceDelta = lastDistance - currentDistance; // Positive = fingers moving together
                
                const mid = getMidpoint(pointers[0], pointers[1]);
                
                camera.zoomAt(distanceDelta * 2, mid.x, mid.y);
                
                // 2. Midpoint Pan Logic (allows panning while pinching)
                const dx = mid.x - lastMidpointX;
                const dy = mid.y - lastMidpointY;
                camera.pan(dx, dy);

                lastDistance = currentDistance;
                lastMidpointX = mid.x;
                lastMidpointY = mid.y;

            // HANDLE SINGLE-FINGER PAN
            } else if (activePointers.size === 1) {
                const dx = e.clientX - lastMidpointX;
                const dy = e.clientY - lastMidpointY;

                camera.pan(dx, dy);
                
                lastMidpointX = e.clientX;
                lastMidpointY = e.clientY;
            }
        }
    });

    const handlePointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    
    // If one finger is left, update its 'last' position 
    // to prevent the camera from "jumping" when the first finger moves again.
    if (activePointers.size === 1) {
        const remaining = activePointers.values().next().value!; 
        lastMidpointX = remaining.clientX;
        lastMidpointY = remaining.clientY;
    }
};

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp); // CRITICAL for mobile

    // Same as before: wheel logic
    window.addEventListener('wheel', (e) => {
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        e.preventDefault();
        if (sim.renderer) {
            sim.renderer.camera.zoomAt(e.deltaY, e.clientX, e.clientY);
        }
    }, { passive: false });
}
