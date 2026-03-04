/**
 * Copyright (c) 2026 Sajid Ahmed
 */
/**
 * Maps a stellar mass to an RGB colour based on the Hertzsprung-Russell diagram.
 * Uses logarithmic interpolation between defined colour stops.
 *
 * @param mass Mass of the star in solar masses
 * @returns [r, g, b] array with values between 0.0 and 1.0
 */
export function massToColor(mass: number): [number, number, number] {
    // Define color stops: [mass limit, [R, G, B]]
    const stops: [number, [number, number, number]][] = [
        [0.1, [1.0, 0.2, 0.2]], // Class M: Red
        [0.45, [1.0, 0.4, 0.1]], // Class K: Orange-Red
        [0.8, [1.0, 0.6, 0.1]], // Class G: Yellow-Orange
        [1.0, [1.0, 1.0, 0.2]], // Class G/F: Yellow
        [2.0, [1.0, 1.0, 1.0]], // Class A: White
        [10.0, [0.7, 0.8, 1.0]], // Class B: Blue-White
        [50.0, [0.3, 0.5, 1.0]], // Class O: Blue
    ];

    // Restrict mass to defined range for interpolation
    const m = Math.max(stops[0][0], Math.min(mass, stops[stops.length - 1][0]));

    // Find the exact or surrounding stops
    let lower = stops[0];
    let upper = stops[stops.length - 1];

    for (let i = 0; i < stops.length - 1; i++) {
        if (m >= stops[i][0] && m <= stops[i + 1][0]) {
            lower = stops[i];
            upper = stops[i + 1];
            break;
        }
    }

    // If exact match on a stop
    if (lower[0] === upper[0]) {
        return [...lower[1]] as [number, number, number];
    }

    // Logarithmic interpolation for smoother transitions across magnitudes
    const logLower = Math.log10(lower[0]);
    const logUpper = Math.log10(upper[0]);
    const logM = Math.log10(m);
    const t = (logM - logLower) / (logUpper - logLower);

    const r = lower[1][0] + (upper[1][0] - lower[1][0]) * t;
    const g = lower[1][1] + (upper[1][1] - lower[1][1]) * t;
    const b = lower[1][2] + (upper[1][2] - lower[1][2]) * t;

    return [r, g, b];
}
