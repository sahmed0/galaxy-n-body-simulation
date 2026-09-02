/**
 * Copyright (c) 2026 Sajid Ahmed
 */
/**
 * Exact energy and momentum diagnostics for the *active subsystem*: the single
 * source of truth for the analytic potentials whose gradients are the force
 * kernels in {@link ./kernels}, plus {@link EnergyMonitor}, which evaluates them
 * over a snapshot without ever stalling a frame.
 *
 * The measured subsystem is the active one, not the whole system. The engines apply
 * a one-way active→passive coupling: bodies in `[start, activeCount)` generate the
 * field, every body feels it. A one-way coupling is not derivable from a Hamiltonian,
 * so the *total* system energy is non-conserved by construction and drifts for
 * reasons that say nothing about the integrator. The active subsystem moving in
 * static external potentials is the honest conserved quantity, so that - indices
 * `[start, activeCount)`, `start = blackHoleMass > 0 ? 1 : 0` (index 0 is the
 * pinned, source-only black hole the engines never integrate) - is what we measure:
 *   - KE  = ½ Σ mᵢ(vxᵢ² + vyᵢ²)
 *   - PE  = −G Σ_{i<j} mᵢmⱼ/√(dᵢⱼ² + ε²)  +  Σ mᵢ·(Φ_DM(rᵢ) + Φ_BH(rᵢ))
 *
 * The pairwise sum is O(N²) - millions of pairs - so it is chunked across frames to
 * keep any single frame's share bounded. A running simulation mutates the live
 * Float32 arrays between those frames, and the user can drag gravity or hit restart
 * mid-sum. {@link EnergyMonitor.beginCycle} therefore copies positions, velocities
 * and masses into float64 scratch and captures G and ε² *once*; every chunk reads
 * only that copy. One triangular sum can never straddle two configurations, and a
 * replaced `PhysicsState` cannot dangle.
 *
 * Clock-free by design: this module owns the math, the caller owns the schedule.
 * Not exported from the `index.ts` barrel (as with `kernels.ts`) - import by path.
 */
import type { PhysicsState } from './PhysicsState';

/** Core radius used when a caller leaves `dmCoreRadius` unset. */
export const DEFAULT_DM_CORE_RADIUS = 50.0;

/**
 * The parameter subset the energy math reads. `PhysicsParams` satisfies it
 * structurally, so callers pass their live params object directly.
 */
export interface EnergyParams {
    /** Gravitational constant `G`. */
    gravity: number;
    /** Plummer softening length `ε` for the pairwise term. */
    softening: number;
    /** Number of field-generating bodies: the active range is `[start, activeCount)`. */
    activeCount: number;
    /** Dark-matter halo velocity scale; the halo term is off when absent or ≤ 0. */
    dmStrength?: number;
    /** Dark-matter halo core radius; defaults to {@link DEFAULT_DM_CORE_RADIUS}. */
    dmCoreRadius?: number;
    /** Pinned central black-hole mass; the BH term is off (and `start = 0`) when absent or ≤ 0. */
    blackHoleMass?: number;
    /** Black-hole Plummer softening; defaults to `softening`. */
    blackHoleSoftening?: number;
}

/** One completed energy/momentum measurement of the active subsystem. */
export interface EnergySample {
    /** Accumulated simulated seconds at the instant the snapshot was taken. */
    simTime: number;
    /** Total energy `KE + PE`. */
    E: number;
    /** Kinetic energy. */
    KE: number;
    /** Potential energy: softened pairwise + Σ mᵢ·(Φ_DM + Φ_BH). */
    PE: number;
    /** Net x-momentum Σ mᵢ·vxᵢ. */
    px: number;
    /** Net y-momentum Σ mᵢ·vyᵢ. */
    py: number;
}

/**
 * Softened pairwise gravitational potential energy of one unordered pair:
 * `−G·mᵢ·mⱼ / √(d² + ε²)`. The potential whose gradient is {@link pairwiseAccel}.
 *
 * Takes the **unsoftened** squared separation and the squared softening separately
 * so no caller can soften twice.
 *
 * @param dSq - Unsoftened squared separation `dx² + dy²`.
 * @param softeningSq - Squared Plummer softening length (ε²).
 * @param gravity - Gravitational constant `G`.
 * @param mi - Mass of the first body.
 * @param mj - Mass of the second body.
 * @returns The pair's potential energy (negative).
 */
export function pairPotential(
    dSq: number,
    softeningSq: number,
    gravity: number,
    mi: number,
    mj: number,
): number {
    return -(gravity * mi * mj) / Math.sqrt(dSq + softeningSq);
}

/**
 * Dark-matter halo potential **per unit mass** at squared radius `rSq`:
 * `½·s²·ln(r² + r_c²)`. The potential whose gradient is {@link darkMatterAccel}
 * (`−∇Φ = −s²·(x, y)/(r² + r_c²)`, the isothermal halo's inward pull). The caller
 * multiplies by `mᵢ`.
 *
 * @param rSq - Squared radius from the origin, `x² + y²`.
 * @param dmStrength - Halo velocity scale `s` (asymptotic circular speed).
 * @param dmCoreRadius - Core radius `r_c` softening the centre.
 * @returns Potential energy per unit mass.
 */
export function darkMatterPotential(rSq: number, dmStrength: number, dmCoreRadius: number): number {
    return 0.5 * dmStrength * dmStrength * Math.log(rSq + dmCoreRadius * dmCoreRadius);
}

/**
 * Softened central black-hole potential **per unit mass** at squared radius `rSq`:
 * `−G·M / √(r² + ε_bh²)`. The potential whose gradient is {@link smbhAccel}. The
 * caller multiplies by `mᵢ`.
 *
 * @param rSq - Squared radius from the origin, `x² + y²`.
 * @param bhSofteningSq - Squared black-hole Plummer softening (ε_bh²).
 * @param gravity - Gravitational constant `G`.
 * @param bhMass - Central black-hole mass `M`.
 * @returns Potential energy per unit mass (negative).
 */
export function blackHolePotential(
    rSq: number,
    bhSofteningSq: number,
    gravity: number,
    bhMass: number,
): number {
    return -(gravity * bhMass) / Math.sqrt(rSq + bhSofteningSq);
}

/**
 * First index of the active subsystem. A non-zero `blackHoleMass` means index 0 is
 * the pinned, source-only black-hole marker the engines never integrate, so it is
 * not part of the subsystem whose energy is conserved - its field enters through
 * {@link blackHolePotential} instead.
 *
 * @param params - The energy parameters.
 * @returns 1 when a pinned black hole is present, else 0.
 */
export function activeStart(params: EnergyParams): number {
    return (params.blackHoleMass ?? 0) > 0 ? 1 : 0;
}

/**
 * Computes exact active-subsystem energy and momentum from a snapshot, spreading
 * the O(N²) pairwise sum over as many chunks as the caller cares to grant.
 *
 * Lifecycle: {@link beginCycle} takes the snapshot and does the O(n) work (KE,
 * momentum, external potentials); {@link processChunk} grinds down the triangular
 * pairwise sum and returns `true` on the chunk that completes the cycle, at which
 * point a fresh {@link EnergySample} is available from {@link lastSample} and has
 * been pushed into the history ring.
 */
export class EnergyMonitor {
    /** Maximum samples retained by {@link history}; older samples are evicted. */
    static readonly RING_CAPACITY = 512;
    /** Default per-chunk pair budget. ~500k pairs ≈ 1–2 ms of float64 work. */
    static readonly DEFAULT_MAX_PAIRS = 500_000;

    private _lastSample: EnergySample | null = null;
    private _sampleCount = 0;
    private _revision = 0;

    /** Ring of completed samples, oldest-to-newest once unwrapped via `ringStart`. */
    private ring: EnergySample[] = [];
    private ringStart = 0;
    /** `E` of the first sample completed after the last reset. Survives ring eviction. */
    private baseline: number | null = null;

    // --- Snapshot: grow-only float64 scratch, plus the parameters captured with it. ---
    private sx = new Float64Array(0);
    private sy = new Float64Array(0);
    private svx = new Float64Array(0);
    private svy = new Float64Array(0);
    private sm = new Float64Array(0);
    private snapN = 0;
    private cycleG = 0;
    private cycleEpsSq = 0;
    private cycleSimTime = 0;
    private cycleKE = 0;
    private cycleExtPot = 0;
    private cyclePx = 0;
    private cyclePy = 0;

    // --- Pairwise-sum cursor: `(cursorI, cursorJ)` is the next unvisited pair. ---
    private cursorI = 0;
    private cursorJ = 1;
    private peAccum = 0;
    private cycleActive = false;

    /** The most recently completed sample, or null if none since the last reset. */
    get lastSample(): EnergySample | null {
        return this._lastSample;
    }

    /** Number of samples completed since the last {@link resetBaseline}. */
    get sampleCount(): number {
        return this._sampleCount;
    }

    /** Monotonic revision, bumped on every completed sample and every reset. */
    get revision(): number {
        return this._revision;
    }

    /** True while a cycle is mid-sum (snapshot taken, pairwise sum unfinished). */
    get inFlight(): boolean {
        return this.cycleActive;
    }

    /**
     * Snapshots the active subsystem and computes everything O(n): KE, net momentum,
     * and the external (halo/BH) potentials. The remaining O(N²) pairwise sum is left
     * to {@link processChunk}. Any cycle already in flight is discarded.
     *
     * @param state - The live simulation state; read here and never retained.
     * @param params - Parameters to measure against; `gravity`/`softening` are captured for the whole cycle.
     * @param simTimeSeconds - Accumulated simulated seconds, stamped onto the resulting sample.
     */
    beginCycle(state: PhysicsState, params: EnergyParams, simTimeSeconds: number): void {
        const start = activeStart(params);
        const end = Math.min(params.activeCount, state.n);
        const snapN = Math.max(0, end - start);

        this.ensureScratch(snapN);
        this.snapN = snapN;

        const { positionX: px, positionY: py, velocityX: vx, velocityY: vy, mass } = state;
        for (let i = start; i < end; i++) {
            const k = i - start;
            this.sx[k] = px[i];
            this.sy[k] = py[i];
            this.svx[k] = vx[i];
            this.svy[k] = vy[i];
            this.sm[k] = mass[i];
        }

        // Capture the field parameters with the positions: a mid-cycle slider drag must
        // not change the law halfway through one sum.
        this.cycleG = params.gravity;
        this.cycleEpsSq = params.softening * params.softening;
        this.cycleSimTime = simTimeSeconds;

        const dmStrength = params.dmStrength ?? 0;
        const dmCoreRadius = params.dmCoreRadius ?? DEFAULT_DM_CORE_RADIUS;
        const bhMass = params.blackHoleMass ?? 0;
        const bhSofteningSq = (params.blackHoleSoftening ?? params.softening) ** 2;
        const hasDm = dmStrength > 0;
        const hasBh = bhMass > 0;

        // One float64 pass for every term that is not pairwise.
        let ke = 0;
        let momX = 0;
        let momY = 0;
        let extPot = 0;
        for (let k = 0; k < snapN; k++) {
            const m = this.sm[k];
            const vxk = this.svx[k];
            const vyk = this.svy[k];
            ke += 0.5 * m * (vxk * vxk + vyk * vyk);
            momX += m * vxk;
            momY += m * vyk;
            if (hasDm || hasBh) {
                const rSq = this.sx[k] * this.sx[k] + this.sy[k] * this.sy[k];
                if (hasDm) extPot += m * darkMatterPotential(rSq, dmStrength, dmCoreRadius);
                if (hasBh) extPot += m * blackHolePotential(rSq, bhSofteningSq, this.cycleG, bhMass);
            }
        }
        this.cycleKE = ke;
        this.cyclePx = momX;
        this.cyclePy = momY;
        this.cycleExtPot = extPot;

        this.peAccum = 0;
        this.cursorI = 0;
        this.cursorJ = 1;
        this.cycleActive = true;
    }

    /**
     * Advances the in-flight triangular pairwise sum by at most `maxPairs` pairs,
     * resuming from the saved row cursor. Reads only the snapshot, so it is safe to
     * call while the engine steps the live state.
     *
     * @param maxPairs - Pair budget for this chunk; values below 1 are treated as 1 so a cycle can never stall.
     * @returns True if this chunk completed the cycle (a new sample is now available).
     */
    processChunk(maxPairs = EnergyMonitor.DEFAULT_MAX_PAIRS): boolean {
        if (!this.cycleActive) return false;
        let budget = Math.max(1, Math.floor(maxPairs));
        const n = this.snapN;
        let i = this.cursorI;
        let j = this.cursorJ;
        let pe = this.peAccum;

        // Row i spans j ∈ [i+1, n); row n-2 holds the last pair, so i = n-1 is terminal.
        while (i < n - 1) {
            const take = Math.min(budget, n - j); // pairs still owed by row i
            const jEnd = j + take;
            const xi = this.sx[i];
            const yi = this.sy[i];
            const mi = this.sm[i];
            for (; j < jEnd; j++) {
                const dx = this.sx[j] - xi;
                const dy = this.sy[j] - yi;
                pe += pairPotential(dx * dx + dy * dy, this.cycleEpsSq, this.cycleG, mi, this.sm[j]);
            }
            budget -= take;
            if (j >= n) {
                i++;
                j = i + 1; // row exhausted → next row's first pair
            }
            // Break *after* the row advance: the resume point may be a row's first pair,
            // which the loop above handles unchanged.
            if (budget <= 0) break;
        }

        this.cursorI = i;
        this.cursorJ = j;
        this.peAccum = pe;
        if (i < n - 1) return false; // budget exhausted mid-triangle
        this.complete();
        return true;
    }

    /**
     * Fractional energy drift against the baseline: `(E_latest − E₀)/|E₀|`.
     * @returns The drift, or null when there is no baseline, no sample, or `E₀ = 0`
     *   (which would make the ratio meaningless rather than merely large).
     */
    deltaE0(): number | null {
        const baseline = this.baseline;
        const last = this._lastSample;
        if (baseline === null || last === null || baseline === 0) return null;
        return (last.E - baseline) / Math.abs(baseline);
    }

    /**
     * The reference energy `E₀`: `E` of the first sample completed after the last
     * reset. Retained independently of {@link history}, which evicts it once the
     * ring wraps.
     * @returns The baseline energy, or null if no sample has completed since the last reset.
     */
    baselineEnergy(): number | null {
        return this.baseline;
    }

    /**
     * The retained samples, oldest first.
     * @returns Up to {@link RING_CAPACITY} samples in chronological order.
     */
    history(): readonly EnergySample[] {
        const out: EnergySample[] = [];
        for (let k = 0; k < this.ring.length; k++) {
            out.push(this.ring[(this.ringStart + k) % this.ring.length]);
        }
        return out;
    }

    /**
     * Drops the baseline, the history, and any in-flight cycle. Call when an edit has
     * made the old `E₀` meaningless (new initial conditions, changed gravity, ...).
     */
    resetBaseline(): void {
        this.ring = [];
        this.ringStart = 0;
        this.baseline = null;
        this._lastSample = null;
        this._sampleCount = 0;
        this.cycleActive = false;
        this._revision++;
    }

    /**
     * Discards an in-flight cycle while keeping the baseline and history. Used when the
     * consumer stops caring mid-sum (the panel closing), so a stale snapshot cannot
     * surface minutes later stamped with a long-past `simTime`.
     */
    cancelCycle(): void {
        this.cycleActive = false;
    }

    /** Grows the snapshot scratch to hold at least `n` bodies. Grow-only: never shrinks. */
    private ensureScratch(n: number): void {
        if (this.sx.length >= n) return;
        this.sx = new Float64Array(n);
        this.sy = new Float64Array(n);
        this.svx = new Float64Array(n);
        this.svy = new Float64Array(n);
        this.sm = new Float64Array(n);
    }

    /** Finalises the in-flight cycle into a sample and publishes it. */
    private complete(): void {
        const PE = this.peAccum + this.cycleExtPot;
        const sample: EnergySample = {
            simTime: this.cycleSimTime,
            E: this.cycleKE + PE,
            KE: this.cycleKE,
            PE,
            px: this.cyclePx,
            py: this.cyclePy,
        };
        this.push(sample);
        if (this.baseline === null) this.baseline = sample.E;
        this._lastSample = sample;
        this._sampleCount++;
        this._revision++;
        this.cycleActive = false;
    }

    /** Appends a sample to the ring, evicting the oldest once at capacity. */
    private push(sample: EnergySample): void {
        if (this.ring.length < EnergyMonitor.RING_CAPACITY) {
            this.ring.push(sample);
            return;
        }
        this.ring[this.ringStart] = sample;
        this.ringStart = (this.ringStart + 1) % this.ring.length;
    }
}
