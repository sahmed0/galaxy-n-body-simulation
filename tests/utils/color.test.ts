import { describe, it, expect } from "vitest";
import { massToColor } from "../../src/utils/colorUtils";

// Stop table mirrored from src/utils/colorUtils.ts (HR-diagram anchors).
const STOPS: [number, [number, number, number]][] = [
    [0.1, [1.0, 0.2, 0.2]], // M: red
    [0.45, [1.0, 0.4, 0.1]], // K: orange-red
    [0.8, [1.0, 0.6, 0.1]], // G: yellow-orange
    [1.0, [1.0, 1.0, 0.2]], // G/F: yellow
    [2.0, [1.0, 1.0, 1.0]], // A: white
    [10.0, [0.7, 0.8, 1.0]], // B: blue-white
    [50.0, [0.3, 0.5, 1.0]], // O: blue
];

describe("massToColor", () => {
    it("returns each anchor stop's exact colour at its mass", () => {
        for (const [mass, rgb] of STOPS) {
            expect(massToColor(mass)).toEqual(rgb);
        }
    });

    it("maps anchor masses to the right colour family", () => {
        // Low mass (M) is red-dominant: R high, G & B low.
        const [rM, gM, bM] = massToColor(0.1);
        expect(rM).toBeGreaterThan(gM);
        expect(rM).toBeGreaterThan(bM);

        // Massive (O) is blue-dominant: B high, R low.
        const [rO, gO, bO] = massToColor(50);
        expect(bO).toBeGreaterThan(rO);
        expect(bO).toBeGreaterThan(gO);

        // Sun-like (~2 Msun, class A) is white: all channels near 1.
        expect(massToColor(2.0)).toEqual([1.0, 1.0, 1.0]);
    });

    it("keeps every component within [0,1] across the full range and beyond", () => {
        for (let m = 0.01; m <= 100; m += 0.05) {
            const c = massToColor(m);
            for (const ch of c) {
                expect(ch).toBeGreaterThanOrEqual(0);
                expect(ch).toBeLessThanOrEqual(1);
            }
        }
    });

    it("clamps masses outside [0.1, 50] to the endpoint colours", () => {
        expect(massToColor(1e-6)).toEqual(STOPS[0][1]);
        expect(massToColor(0.05)).toEqual(STOPS[0][1]);
        expect(massToColor(1000)).toEqual(STOPS[STOPS.length - 1][1]);
    });

    it("is continuous (no jumps) across the range", () => {
        let prev = massToColor(0.1);
        // Dense log sweep; adjacent samples must differ only slightly.
        for (let i = 1; i <= 2000; i++) {
            const m = 0.1 * Math.pow(500, i / 2000); // 0.1 -> 50
            const cur = massToColor(m);
            for (let k = 0; k < 3; k++) {
                expect(Math.abs(cur[k] - prev[k])).toBeLessThan(0.02);
            }
            prev = cur;
        }
    });

    it("trends bluer and less red toward higher mass", () => {
        // Blue channel non-decreasing from yellow (1.0) up to O (50).
        let prevB = -Infinity;
        // Red channel non-increasing from white (2.0) up to O (50).
        let prevR = Infinity;
        for (let i = 0; i <= 100; i++) {
            const mB = 1.0 * Math.pow(50, i / 100); // 1 -> 50
            const b = massToColor(mB)[2];
            expect(b).toBeGreaterThanOrEqual(prevB - 1e-9);
            prevB = b;

            const mR = 2.0 * Math.pow(25, i / 100); // 2 -> 50
            const r = massToColor(mR)[0];
            expect(r).toBeLessThanOrEqual(prevR + 1e-9);
            prevR = r;
        }
    });
});
