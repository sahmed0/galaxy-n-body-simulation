/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { describe, it, expect } from 'vitest';
import { Camera } from './Camera';
import {
    starScale, centreShift, wrap, generateStars,
    TILE_SIZE, STAR_DENSITY, PAN_PARALLAX,
} from './Starfield';

describe('starScale', () => {
    it('is 1 at zoom 1', () => {
        expect(starScale(1)).toBe(1);
    });

    it('spans ~0.79x to ~1.41x across the camera zoom range', () => {
        expect(starScale(0.2)).toBeCloseTo(0.786, 3);
        expect(starScale(10)).toBeCloseTo(1.413, 3);
    });
});

describe('centreShift', () => {
    for (const zoom of [0.2, 1, 10]) {
        it(`follows a drag in direction and screen distance at zoom ${zoom}`, () => {
            const camera = new Camera(800, 600);
            camera.zoom = zoom;
            const prev = { x: camera.x, y: camera.y };

            camera.pan(100, -40);
            const shift = centreShift(prev, camera);

            expect(shift.x).toBeCloseTo(100, 9);
            expect(shift.y).toBeCloseTo(-40, 9);
            expect(PAN_PARALLAX * shift.x).toBeCloseTo(5, 9);
        });
    }
});

describe('wrap', () => {
    it('keeps values within one period', () => {
        for (const v of [-1, -TILE_SIZE, -1e9 - 3.5, 0, TILE_SIZE, 1e9 + 5.25]) {
            const r = wrap(v, TILE_SIZE);
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThan(TILE_SIZE);
        }
        expect(wrap(-1, TILE_SIZE)).toBe(TILE_SIZE - 1);
    });
});

describe('generateStars', () => {
    it('is deterministic for a seed', () => {
        expect(generateStars(7, TILE_SIZE, STAR_DENSITY)).toEqual(generateStars(7, TILE_SIZE, STAR_DENSITY));
    });

    it('places a fixed number of stars per unit area', () => {
        const stars = generateStars(7, TILE_SIZE, STAR_DENSITY);
        expect(stars).toHaveLength(Math.round(TILE_SIZE * TILE_SIZE * STAR_DENSITY));
        expect(generateStars(7, TILE_SIZE / 2, STAR_DENSITY).length).toBeCloseTo(stars.length / 4, 0);
    });

    it('keeps stars inside the tile within the opacity range', () => {
        for (const s of generateStars(7, TILE_SIZE, STAR_DENSITY)) {
            expect(s.x).toBeGreaterThanOrEqual(0);
            expect(s.x).toBeLessThan(TILE_SIZE);
            expect(s.y).toBeGreaterThanOrEqual(0);
            expect(s.y).toBeLessThan(TILE_SIZE);
            expect(s.alpha).toBeGreaterThanOrEqual(0.05);
            expect(s.alpha).toBeLessThanOrEqual(0.4);
        }
    });
});
