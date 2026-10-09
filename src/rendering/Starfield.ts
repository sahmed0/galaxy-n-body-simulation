/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Parallax starfield backdrop. A seeded, seamless star tile is filled across the
 * viewport as a repeating pattern, offset and scaled by the camera each frame, so the
 * backdrop covers the screen at every pan and zoom with a fixed star density per area.
 */
import { mulberry32 } from '../utils/rng';
import type { Camera } from './Camera';

/** Side of the repeating star tile, in CSS pixels. */
export const TILE_SIZE = 1024;
/** Stars per CSS pixel squared (~585 per million). */
export const STAR_DENSITY = 585e-6;
/** Fraction of the galaxy's on-screen pan motion the stars follow. */
export const PAN_PARALLAX = 0.05;
/** Exponent mapping camera zoom to star scale, lower values result in less parallax. */
export const ZOOM_PARALLAX = 0.15;
/** Fixed seed so the backdrop is identical on every visit. */
const STAR_SEED = 0x5747a2;
/** Device pixel ratio cap, matching the simulation canvases. */
const MAX_DPR = 2;
/** Screen-space world motion (CSS px) below which a frame is not redrawn. */
const REDRAW_EPSILON = 0.1;

/** The camera state the starfield follows. */
export type CameraView = Pick<Camera, 'x' | 'y' | 'zoom' | 'tilt'>;

/** One star in tile space (CSS pixels). */
export interface Star {
    x: number;
    y: number;
    size: number;
    alpha: number;
}

/**
 * Maps camera zoom to the starfield's scale.
 * @param zoom The camera zoom.
 * @returns The star scale; 1 at zoom 1.
 */
export function starScale(zoom: number): number {
    return zoom ** ZOOM_PARALLAX;
}

/**
 * Screen displacement, in CSS pixels, of the world point that sat at the viewport
 * centre under the previous camera.
 * @param prev The previous camera state.
 * @param next The current camera state.
 * @returns The on-screen shift of that point.
 */
export function centreShift(prev: Pick<CameraView, 'x' | 'y'>, next: CameraView): { x: number; y: number } {
    return {
        x: next.zoom * (prev.x - next.x),
        y: next.zoom * next.tilt * (prev.y - next.y),
    };
}

/**
 * Wraps a value into [0, period).
 * @param v The value to wrap.
 * @param period The wrap period.
 * @returns The wrapped value.
 */
export function wrap(v: number, period: number): number {
    const r = v % period;
    return r < 0 ? r + period : r;
}

/**
 * Generates a deterministic set of stars for one tile.
 * @param seed The PRNG seed.
 * @param tileSize The tile side in CSS pixels.
 * @param density Stars per CSS pixel squared.
 * @returns The stars, positioned in [0, tileSize).
 */
export function generateStars(seed: number, tileSize: number, density: number): Star[] {
    const rng = mulberry32(seed);
    const count = Math.round(tileSize * tileSize * density);
    const stars: Star[] = [];
    for (let i = 0; i < count; i++) {
        stars.push({
            x: rng() * tileSize,
            y: rng() * tileSize,
            size: rng() > 0.95 ? 2 : 1,
            alpha: 0.05 + rng() * 0.35,
        });
    }
    return stars;
}

/**
 * Draws the parallax starfield onto a full-viewport canvas.
 */
export class Starfield {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly stars = generateStars(STAR_SEED, TILE_SIZE, STAR_DENSITY);
    private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    private pattern!: CanvasPattern;
    private dpr = 0;
    private width = 0;
    private height = 0;
    /** Pattern-space offset, kept wrapped within one tile. */
    private qx = 0;
    private qy = 0;
    private scale = 1;
    /** Camera state at the last redraw; null until the first update. */
    private prev: Pick<CameraView, 'x' | 'y' | 'zoom'> | null = null;

    /**
     * Builds the star tile and draws the initial frame.
     * @param canvas The full-viewport backdrop canvas.
     */
    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Starfield: 2D context unavailable');
        this.ctx = ctx;

        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.reducedMotion.addEventListener('change', () => {
            this.qx = 0;
            this.qy = 0;
            this.scale = 1;
            this.prev = null;
            this.draw();
        });
    }

    /**
     * Follows the camera: scales the stars with zoom and shifts them by a fraction of
     * the world's on-screen motion. Skips the redraw when the camera has not moved.
     * @param camera The current camera state.
     */
    public update(camera: CameraView): void {
        if (this.reducedMotion.matches) return;

        const scale = starScale(camera.zoom);
        if (this.prev) {
            const shift = centreShift(this.prev, camera);
            const still = Math.abs(shift.x) < REDRAW_EPSILON && Math.abs(shift.y) < REDRAW_EPSILON;
            if (still && Math.abs(scale - this.scale) < 1e-5) return;
            this.qx = wrap(this.qx + (PAN_PARALLAX * shift.x) / scale, TILE_SIZE);
            this.qy = wrap(this.qy + (PAN_PARALLAX * shift.y) / scale, TILE_SIZE);
        }
        this.scale = scale;
        this.prev = { x: camera.x, y: camera.y, zoom: camera.zoom };
        this.draw();
    }

    /**
     * Matches the canvas to the viewport, rebuilding the tile if the pixel ratio changed.
     */
    private resize(): void {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = Math.round(this.width * dpr);
        this.canvas.height = Math.round(this.height * dpr);
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        if (dpr !== this.dpr) {
            this.dpr = dpr;
            this.pattern = this.buildPattern();
        }
        this.draw();
    }

    /**
     * Rasterises the stars into a seamless tile at the current pixel ratio. Stars that
     * cross the right or bottom edge are also drawn wrapped onto the opposite edge.
     * @returns A repeating pattern whose user space is CSS pixels.
     */
    private buildPattern(): CanvasPattern {
        const tile = document.createElement('canvas');
        tile.width = tile.height = Math.round(TILE_SIZE * this.dpr);
        const tctx = tile.getContext('2d', { alpha: false });
        if (!tctx) throw new Error('Starfield: 2D context unavailable');

        tctx.scale(this.dpr, this.dpr);
        tctx.fillStyle = '#000';
        tctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
        for (const s of this.stars) {
            tctx.fillStyle = `rgba(255, 255, 255, ${s.alpha})`;
            const xs = s.x + s.size > TILE_SIZE ? [s.x, s.x - TILE_SIZE] : [s.x];
            const ys = s.y + s.size > TILE_SIZE ? [s.y, s.y - TILE_SIZE] : [s.y];
            for (const x of xs) for (const y of ys) tctx.fillRect(x, y, s.size, s.size);
        }

        const pattern = this.ctx.createPattern(tile, 'repeat');
        if (!pattern) throw new Error('Starfield: pattern unavailable');
        pattern.setTransform(new DOMMatrix().scale(1 / this.dpr));
        return pattern;
    }

    /**
     * Fills the viewport with the pattern, mapping pattern point u to screen
     * centre + scale * (u + q).
     */
    private draw(): void {
        const { ctx, dpr, width: w, height: h, scale: s, qx, qy } = this;
        ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (w / 2 + s * qx), dpr * (h / 2 + s * qy));
        ctx.fillStyle = this.pattern;
        // One pattern-space pixel of slack on each side covers backing-store rounding.
        ctx.fillRect(-w / (2 * s) - qx - 1, -h / (2 * s) - qy - 1, w / s + 2, h / s + 2);
    }
}
