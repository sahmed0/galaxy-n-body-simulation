/**
 * Copyright (c) 2026 Sajid Ahmed
 */

/**
 * Formats a large count with an SI-style magnitude suffix and 3 significant figures,
 * e.g. 1_240_000_000 -> "1.24 G", 840_000_000 -> "840 M", 12_300 -> "12.3 k".
 * Values below 1000 are shown as-is. Used for interaction totals and derived rates.
 * @param n - The value to format.
 * @returns The compact human-readable string (no unit).
 */
export function formatCount(n: number): string {
    if (!isFinite(n) || n <= 0) return '0';
    const units = [
        { value: 1e12, suffix: 'T' },
        { value: 1e9, suffix: 'G' },
        { value: 1e6, suffix: 'M' },
        { value: 1e3, suffix: 'k' },
    ];
    for (const { value, suffix } of units) {
        if (n >= value) {
            const scaled = n / value;
            // 3 significant figures: fewer decimals as the mantissa grows.
            const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
            return `${scaled.toFixed(decimals)} ${suffix}`;
        }
    }
    return `${Math.round(n)}`;
}

/**
 * Like {@link formatCount} but suffixed with "/s" for a per-second rate,
 * e.g. "1.24 G/s", "840 M/s", "12.3 k/s".
 * @param n - The rate to format (per second).
 * @returns The compact human-readable rate string.
 */
export function formatRate(n: number): string {
    return `${formatCount(n)}/s`;
}
