/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Manages the viewport transformations for the HTML5 Canvas.
 * Handles panning and zooming with mouse anchoring.
 */
export class Camera {
    /** 
     * The world-space X position that the camera is focused on (Current Render State). 
     */
    public x: number = 0;

    /** 
     * The world-space Y position that the camera is focused on (Current Render State). 
     */
    public y: number = 0;

    /** The current zoom level (Current Render State). */
    public zoom: number = 1.0;

    /** The cinematic tilt of the camera (1.0 = top-down, 0.0 = edge-on). */
    public tilt: number = 0.6;

    /** Target state for smooth application. */
    private targetX: number = 0;
    private targetY: number = 0;
    private targetZoom: number = 1.0;

    /** The width of the viewport in pixels. */
    private viewportWidth: number = 0;
    /** The height of the viewport in pixels. */
    private viewportHeight: number = 0;

    /**
     * Initialises a new camera with the given viewport dimensions.
     * 
     * @param viewportWidth The width of the viewport in pixels.
     * @param viewportHeight The height of the viewport in pixels.
     */
    constructor(viewportWidth: number, viewportHeight: number) {
        this.updateViewport(viewportWidth, viewportHeight);
    }

    /**
     * Updates the viewport dimensions when the canvas resizes.
     * 
     * @param width The new width of the viewport.
     * @param height The new height of the viewport.
     * @returns {void}
     */
    public updateViewport(width: number, height: number): void {
        this.viewportWidth = width;
        this.viewportHeight = height;
    }

    /**
     * Converts screen pixel coordinates (e.g. mouse position) to world units.
     * Uses the CURRENT render state (this.x, this.y, this.zoom).
     * 
     * @param screenWidth The horizontal screen coordinate to convert.
     * @param screenHeight The vertical screen coordinate to convert.
     * @returns {{ x: number; y: number }} The corresponding world coordinates.
     */
    public screenToWorld(screenWidth: number, screenHeight: number): { x: number; y: number } {
        // Reverse the transformations applied in apply():
        // 1. Center offset
        // 2. Scale (including tilt on Y axis)
        // 3. Translation
        return {
            x: (screenWidth - this.viewportWidth / 2) / this.zoom + this.x,
            y: (screenHeight - this.viewportHeight / 2) / (this.zoom * this.tilt) + this.y,
        };
    }

    /**
     * Applies the camera transformations to the given 2D context.
     * Use context.restore() afterwards to undo.
     * 
     * @param ctx The Canvas 2D context to apply the camera state to.
     * @returns {void}
     */
    public apply(ctx: CanvasRenderingContext2D): void {
        ctx.save();
        // Shift origin to screen center before scaling to keep zooming centered
        ctx.translate(this.viewportWidth / 2, this.viewportHeight / 2);
        // Apply scale and tilt
        ctx.scale(this.zoom, this.zoom * this.tilt);
        // 3. Translate to the camera's focus point (negated)
        ctx.translate(-this.x, -this.y);
    }

    /**
     * Resets the camera to the origin with default zoom.
     */
    public reset(): void {
        this.targetX = 0;
        this.targetY = 0;
        this.targetZoom = 1.0;
        // Snap immediately
        this.x = 0;
        this.y = 0;
        this.zoom = 1.0;
    }

    /**
     * Pans the camera based on screen pixel deltas.
     * Calculates independent world deltas for current and target states to ensure 1:1 tracking.
     * 
     * @param screenDx The change in horizontal screen pixels.
     * @param screenDy The change in vertical screen pixels.
     * @returns {void}
     */
    public pan(screenDx: number, screenDy: number): void {
        // Move current view to match cursor movement 1:1 (immediate response)
        // We subtract because moving the camera right shifts the world left
        // Divide dy by tilt so panning feels consistent vertically
        this.x -= screenDx / this.zoom;
        this.y -= screenDy / (this.zoom * this.tilt);

        // Move target view to match cursor movement 1:1 (at target scale)
        // This ensures that when the zoom settles, the world has moved the same screen distance
        this.targetX -= screenDx / this.targetZoom;
        this.targetY -= screenDy / (this.targetZoom * this.tilt);
    }

    /**
     * Progresses the camera's current state towards its target state using a smoothing factor.
     * Should be called every frame to continuously transition the view.
     */
    public update(): void {
        const t = 0.1; // Smoothing factor (0.1 = smooth, 1.0 = instant)

        // Interpolate current values toward target to provide ease-out behavior
        this.x += (this.targetX - this.x) * t;
        this.y += (this.targetY - this.y) * t;
        this.zoom += (this.targetZoom - this.zoom) * t;

        // Snap if close enough to save calculations? 
        // Not strictly necessary for this sim, but good practice.
    }

    /**
     * Handles zooming anchored to a specific screen position.
     * @param delta The scroll delta (positive = zoom out, negative = zoom in).
     * @param anchorX Screen x coordinate to zoom towards.
     * @param anchorY Screen y coordinate to zoom towards.
     */
    public zoomAt(delta: number, anchorX: number, anchorY: number): void {
        // Input Normalisation
        // Mouse wheels often give ~100. Touchpads give ~2-5.
        // We dampen large deltas to prevent "jumping".
        let effectiveDelta = delta;
        if (Math.abs(delta) > 50) {
            effectiveDelta = Math.sign(delta) * 40;
        }

        const zoomSpeed = 0.075;
        const factor = Math.pow(1.1, -effectiveDelta * zoomSpeed);

        // 1. Calculate the world position of the anchor using current TARGET state.
        // We use TARGET state to ensure multiple fast scrolls accumulate correctly.
        const wx = (anchorX - this.viewportWidth / 2) / this.targetZoom + this.targetX;
        const wy = (anchorY - this.viewportHeight / 2) / (this.targetZoom * this.tilt) + this.targetY;

        // 2. Update Target Zoom
        this.targetZoom *= factor;
        this.targetZoom = Math.max(0.2, Math.min(this.targetZoom, 10));

        // 3. Update Target Position to maintain anchor
        // targetPos = worldPos - (screenOffset) / newTargetZoom
        this.targetX = wx - (anchorX - this.viewportWidth / 2) / this.targetZoom;
        this.targetY = wy - (anchorY - this.viewportHeight / 2) / (this.targetZoom * this.tilt);
    }
}
