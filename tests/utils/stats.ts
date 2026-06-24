/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Analytic statistics helpers for goodness-of-fit testing. Pure functions, no
 * deps. Used by the Salpeter KS test to compare a seeded sample against the
 * closed-form IMF CDF.
 */

/**
 * CDF of the Salpeter initial mass function over [mMin, mMax] with exponent p.
 *
 * The production sampler draws via the inverse transform
 *   m = (u·(mMax^-p − mMin^-p) + mMin^-p)^(−1/p),  u ~ U(0,1)
 * which is exactly the inverse of
 *   F(m) = (m^-p − mMin^-p) / (mMax^-p − mMin^-p)
 * i.e. a power-law number density dN/dm ∝ m^(−p−1) (standard Salpeter slope
 * −2.35 at p = 1.35). F(mMin) = 0, F(mMax) = 1.
 */
export function salpeterCDF(m: number, mMin: number, mMax: number, p: number): number {
    return (Math.pow(m, -p) - Math.pow(mMin, -p)) / (Math.pow(mMax, -p) - Math.pow(mMin, -p));
}

/**
 * One-sample Kolmogorov–Smirnov statistic D = sup_x |F_n(x) − F(x)| between an
 * empirical sample and a reference CDF. Samples are sorted ascending; for the
 * i-th order statistic (1-based) the empirical CDF jumps from (i−1)/N to i/N, so
 * the per-point deviation is max(i/N − F(x_i), F(x_i) − (i−1)/N).
 */
export function ksStatistic(samples: number[], cdf: (x: number) => number): number {
    const sorted = [...samples].sort((a, b) => a - b);
    const N = sorted.length;
    let D = 0;
    for (let i = 0; i < N; i++) {
        const f = cdf(sorted[i]);
        const dPlus = (i + 1) / N - f;   // i/N (1-based) − F(x_i)
        const dMinus = f - i / N;        // F(x_i) − (i−1)/N (1-based)
        if (dPlus > D) D = dPlus;
        if (dMinus > D) D = dMinus;
    }
    return D;
}

/**
 * Asymptotic two-sided KS critical value D_crit = c(α)/√N, with
 * c(α) = √(−½·ln(α/2)). For α = 0.01, c ≈ 1.628. A sample passes the
 * goodness-of-fit test at significance α when its KS statistic is below this.
 */
export function ksCriticalValue(N: number, alpha: number): number {
    return Math.sqrt(-0.5 * Math.log(alpha / 2)) / Math.sqrt(N);
}
