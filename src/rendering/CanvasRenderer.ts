/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from '../physics';
import type { QuadTree } from '../physics';
import { Camera } from './Camera';

/**
 * Renders the N-body simulation using the HTML5 Canvas API.
 * Visual Style: High contrast, additive blending for glowing effects.
 */
export class CanvasRenderer {
    /** The HTML canvas element used for rendering. */
    public canvas: HTMLCanvasElement;

    /** The 2D rendering context obtained from the canvas. */
    private ctx: CanvasRenderingContext2D;

    /** The physics state of the simulation. */
    public state: PhysicsState;

    /** The camera defining the viewport and transformations. */
    public camera: Camera;

    /** Current width of the canvas. */
    private width: number;

    /** Current height of the canvas. */
    private height: number;

    /** The mass threshold determining when to render a particle as larger. */
    public massThreshold: number = 0;

    /** Whether to render the quad tree structure for debugging. */
    public showQuadTree: boolean = false;

    /** The quad tree spatial partition representing the current frame. */
    public quadTree: QuadTree | null = null;

    /**
     * Initialises the canvas renderer with a given canvas ID and physics state.
     * 
     * @param canvasId The DOM ID of the target canvas element.
     * @param state The initial physics state containing positions and masses.
     */
    constructor(canvasId: string, state: PhysicsState) {
        const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
        if (!canvas) {
            throw new Error(`Canvas with id "${canvasId}" not found.`);
        }
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d')!;
        this.state = state;
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        this.camera = new Camera(this.width, this.height);

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    /**
     * Resizes the canvas context and camera viewport to match the active window dimensions.
     */
    private resize(): void {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.camera.updateViewport(this.width, this.height);
    }

    /**
     * Recursively computes and strokes the spatial partition boundaries of the QuadTree for debugging.
     * @param node The node describing the spatial parameters to be rendered.
     */
    private drawQuadTree(node: QuadTree | null): void {
        if (!node) return;

        const ctx = this.ctx;
        const b = node.boundary;

        ctx.strokeStyle = 'rgba(0, 255, 0, 0.3)';
        ctx.lineWidth = 1 / this.camera.zoom;
        ctx.strokeRect(
            b.x - b.width / 2,
            b.y - b.height / 2,
            b.width,
            b.height
        );

        if (node.divided) {
            this.drawQuadTree(node.northwest);
            this.drawQuadTree(node.northeast);
            this.drawQuadTree(node.southwest);
            this.drawQuadTree(node.southeast);
        }
    }

    /**
     * Renders the current frame by clearing the canvas and painting all particles and optional debug data.
     */
    public render(): void {
        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        // Prepare context for fresh frame rendering
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, w, h);

        // 2. Apply Camera Transformations
        this.camera.apply(ctx);

        // 3. Draw QuadTree
        if (this.showQuadTree && this.quadTree) {
            // Reset composite operation for clear lines
            ctx.globalCompositeOperation = 'source-over';
            this.drawQuadTree(this.quadTree);
        }

        // 5. Draw Particles
        // Additive blending for glow
        ctx.globalCompositeOperation = 'lighter';

        for (let i = 0; i < n; i++) {
            const x = px[i];
            const y = py[i];

            if (i === 0) {
                // --- SUPERMASSIVE BLACK HOLE RENDER ---
                // Keep the high-quality render for the main attractor
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';

                // 1. Accretion Disk / Light Bending (Glow around)
                const grad = ctx.createRadialGradient(x, y, 2, x, y, 30);
                grad.addColorStop(0, 'rgba(255, 251, 221, 1)'); // Event Horizon
                grad.addColorStop(0.3, 'rgba(255, 251, 221, 1)'); // Inner hot disk
                grad.addColorStop(0.5, 'rgba(255, 251, 221, 1)'); // Outer glow
                grad.addColorStop(1, 'rgba(255, 251, 221, 0)');

                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(x, y, 50, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        // --- PER-PARTICLE RENDERER START ---
        for (let i = 1; i < n; i++) {
            const r = Math.floor(this.state.colors[i * 3 + 0] * 255);
            const g = Math.floor(this.state.colors[i * 3 + 1] * 255);
            const b = Math.floor(this.state.colors[i * 3 + 2] * 255);

            ctx.fillStyle = `rgb(${r},${g},${b})`;

            if (this.state.mass[i] >= this.massThreshold) {
                // Draw 2x2 rect for heavy stars centered at x,y
                ctx.fillRect(px[i] - 1, py[i] - 1, 2, 2);
            } else {
                // Draw 1x1 rect for light stars at x,y
                ctx.fillRect(px[i], py[i], 1.7, 1.7);
            }
        }
        // --- PER-PARTICLE RENDERER END ---

        // 6. Restore screen space context
        ctx.restore();
    }
}

