/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { massToColor } from '../../utils';
import { presetFor } from '../enginePresets';
import type { SimulationParams } from '../params';
import {
    MIN_DT_FRACTION,
    STEPS_PER_ORBIT,
    gaussianRandom,
    haloAcc,
    sampleSalpeterMass,
    type IcContext,
    type InitialConditions,
} from './common';

/**
 * Mass of the galaxy preset's fixed central black hole (the source mass folded
 * into the measured rotation curve via {@link GalaxyDisk.bhAcc}). The accretion
 * preset uses its own, far larger ACCRETION_BH_MASS.
 */
export const GALAXY_CENTRAL_BH_MASS = 2600;

/**
 * Exponential scale length R_d of the self-gravitating disk:
 * Sigma(R) = Sigma0 * exp(-R/R_d). The profile is finite at the centre (no sigma_R
 * cap needed) and tapers smoothly (no hard edge to seed instabilities), unlike a
 * uniform-in-radius Sigma ~ 1/R disk.
 */
export const DISK_SCALE_LENGTH = 150;

/**
 * Outer truncation of the exponential disk, in scale lengths. Particles are
 * seeded over R in [0, DISK_TRUNCATION * DISK_SCALE_LENGTH] via the truncated
 * exponential inverse-CDF.
 */
export const DISK_TRUNCATION = 4;

/**
 * Provisional seed mass for the self-gravitating galaxy preset. The *final* disk
 * mass is not this value: it is calibrated in {@link GalaxyDisk.initialise}
 * so the measured disk fraction at the rotation-curve peak hits {@link TARGET_F_DISK}
 * (see {@link DISK_FRACTION_RADIUS_FACTOR}). This constant only sets the mass at which
 * the disk's force *shape* is first measured; since the disk's radial force is linear
 * in total mass, its exact value cancels out of the calibration. Keep it a sane
 * positive number. Unused by the accretion preset, where the disk is just the raw
 * Salpeter masses (test particles).
 */
export const SELF_GRAV_DISK_MASS = 1e6;

/**
 * Target disk fraction f_disk = v_disk^2 / v_c^2 at the calibration radius, used to
 * choose the self-gravitating disk's total mass. Maximal, spiral-forming disks sit at
 * f_disk ~ 0.5-0.7; smaller values give a halo-dominated, featureless disk.
 */
export const TARGET_F_DISK = 0.6;

/**
 * Calibration radius (in disk scale lengths) at which {@link TARGET_F_DISK} is hit.
 * R ~ 2.2 R_d is the peak of an exponential disk's rotation-curve contribution.
 */
export const DISK_FRACTION_RADIUS_FACTOR = 2.2;

/**
 * Target Toomre Q for the self-gravitating preset. Q ~ 1.2-1.5 is the
 * spiral-forming "sweet spot": cool enough that density perturbations get
 * swing-amplified into transient arms, hot enough to avoid fragmenting into
 * clumps (Q < 1). Larger Q -> smoother/featureless disk.
 */
export const TOOMRE_Q = 1.3;

/**
 * Gravitational softening for the self-gravitating disk, expressed as a fraction
 * of the local inter-particle spacing at the half-mass radius (see
 * {@link GalaxyDisk.effectiveSoftening}). The engine presets use
 * softening = 1.0, which is correct for the central-mass-dominated accretion preset
 * but far smaller than the disk's particle spacing. With self-gravity ON that
 * makes the disk collisional: close encounters between the massive macro-particles
 * deliver huge velocity kicks that fling stars out within a crossing time.
 * Softening on the order of the spacing makes the disk behave as the smooth,
 * collisionless system the model assumes.
 */
export const SELF_GRAV_SOFTENING_FACTOR = 0.9;

/**
 * Safety factor on the close-encounter dt limit for the heavy macro-particles:
 * dt <= ENCOUNTER_SAFETY * sqrt(eps^3 / (G * m_particle)), the timestep that
 * resolves a near-softening-length two-body encounter. See
 * {@link GalaxyDisk.adaptiveTimestep}.
 */
export const ENCOUNTER_SAFETY = 0.05;

/**
 * Number of *active* (field-generating) macro-particles in the self-gravitating
 * preset. The first `SELF_GRAV_ACTIVE_COUNT` indices carry the entire disk mass
 * (m = Mdisk / N_active each) and source the gravitational field; the remaining
 * particles are *passive* tracers that feel the active field + halo but neither
 * exert gravity nor interact with each other. The engines distinguish the two
 * sets purely by index (`j < activeCount`), so passive particles still render
 * identically to active ones.
 *
 * This is a performance/fidelity knob, not a physical constant. Force cost is
 * O(N_active x N_total) instead of O(N_total^2), so raising the total particle
 * count past the all-active frame-rate ceiling stays affordable as long as
 * N_active is held here. The trade-off is physical: the self-gravitating disk's
 * spiral structure is a *collective* effect, so a sparse active backbone gives a
 * grainier field and faster two-body heating - the effective Toomre Q is set by
 * N_active, not N_total. Values in the high thousands keep recognisable spiral
 * arms; pushing it very low coarsens the field noticeably. When it meets or
 * exceeds the particle count the split is inert and every particle is active
 * (the original behaviour).
 */
export const SELF_GRAV_ACTIVE_COUNT = 3000;

/**
 * Plummer softening for the fixed central black hole of the self-gravitating
 * preset, in world units. Unlike the disk's softening (~the inter-particle
 * spacing, tens of units), the BH is a single hard point mass, so its softening
 * is the knob that bounds how deep and fast the innermost orbits get: the
 * orbital-resolution dt limit (see {@link GalaxyDisk.adaptiveTimestep})
 * shrinks as the inner well steepens, so too small a value drives dt toward the
 * {@link MIN_DT_FRACTION} floor. Chosen on the order of the disk softening so the
 * BH dominates the centre without crushing the timestep. Only the self-gravitating
 * preset uses a fixed central BH; the accretion preset's SMBH is a live particle
 * (index 0) instead, with `params.blackHoleMass` left at 0.
 */
export const SELF_GRAV_BH_SOFTENING = 25;

/**
 * Self-gravitating ("galaxy") initial conditions: an exponential disk of
 * macro-particles embedded in the dark-matter halo, with a fixed central black
 * hole pinned at the origin (index 0; see {@link GalaxyDisk.bhStart}). Velocities
 * are set from the *measured* 2-D rotation curve - disk pairwise gravity + halo +
 * BH - so the disk starts in centrifugal balance with the engine's actual forces,
 * and warmed to a target Toomre Q, producing swing-amplified transient spiral arms.
 *
 * The BH (index 0) is an inert, source-only marker: it carries {@link GALAXY_CENTRAL_BH_MASS}
 * purely so the renderers draw the central glow, sits at the origin, and is
 * excluded from every force sum (its pull on the disk comes from the engines'
 * analytic SMBH term, with its own `blackHoleSoftening`). The disk occupies
 * `[bhStart, n)`.
 *
 * Active/passive split (see {@link SELF_GRAV_ACTIVE_COUNT}): the first `nActive`
 * *disk* particles (indices `[bhStart, bhStart + nActive)`) carry the entire disk
 * mass and source the field; the rest are passive tracers that feel the active
 * field + halo + BH but do not gravitate. Because the radii are sampled i.i.d.
 * from the same exponential profile, those indices are already a fair subsample -
 * no reordering needed. Every disk particle is given the same per-active-particle
 * mass so they render identically; the engines and the field-measurement helpers
 * (`buildRotationCurve`, `buildSurfaceDensity`, `applySelfGravHalfKick`) treat the
 * split purely by index, never by mass. When `nActive` covers the whole disk the
 * split is inert and the disk is fully self-gravitating.
 */
export class GalaxyDisk implements InitialConditions {
    readonly preset = 'galaxy' as const;

    /**
     * Effective total disk mass of the current realization, as calibrated in
     * {@link initialise}. Zero before it runs.
     */
    diskMass = 0;

    /**
     * Azimuthally-averaged radial-acceleration table (a vs radius) for the
     * self-gravitating disk, built from the *realized* particle distribution
     * plus the halo (see {@link buildRotationCurve}). Sampled on a uniform grid
     * [rotCurveRMin, rotCurveRMax] so the initial circular speed and epicyclic
     * frequency match the engine's actual 2-D forces.
     */
    private rotCurveAcc: Float64Array | null = null;
    private rotCurveRMin = 0;
    private rotCurveRMax = 0;

    /**
     * Azimuthally-averaged surface-density profile (Sigma vs radius) of the
     * self-gravitating disk, measured from the *realized* particle distribution
     * (see {@link buildSurfaceDensity}). Bin k is centred at
     * (k + 0.5) * surfDensDr. Used to set the Toomre-Q velocity dispersion from
     * the disk that actually exists rather than an assumed analytic Sigma.
     */
    private surfDensProfile: Float64Array | null = null;
    private surfDensDr = 0;

    /**
     * The measured rotation curve and the radius grid it is sampled on, or null
     * before {@link initialise} has run. Exposed so verification and telemetry can
     * read the table without reaching into private fields.
     */
    get rotationCurve(): { readonly acc: Float64Array; readonly rMin: number; readonly rMax: number } | null {
        if (!this.rotCurveAcc) return null;
        return { acc: this.rotCurveAcc, rMin: this.rotCurveRMin, rMax: this.rotCurveRMax };
    }

    /**
     * Builds the disk: pins the fixed central BH, samples the exponential disk,
     * measures its rotation curve and surface density, calibrates the total mass
     * to {@link TARGET_F_DISK}, derives dt and warms every star to {@link TOOMRE_Q}.
     */
    initialise(ctx: IcContext): void {
        const { params, state } = ctx;

        // The self-gravitating preset pins a fixed, source-only black hole at the
        // origin (index 0). Set this first: it gates which index range counts as
        // disk sources (see {@link bhStart}/{@link activeCount}), which both
        // effectiveSoftening and the disk build below read.
        params.blackHoleMass = GALAXY_CENTRAL_BH_MASS;
        params.blackHoleSoftening = SELF_GRAV_BH_SOFTENING;
        // Lock in the mode-appropriate softening *before* computing velocities:
        // the initial conditions (circular speed, epicyclic frequency, and the
        // measured rotation curve) all read params.softening, so they must use the
        // same softening the engine will run with, or the disk starts out of
        // centrifugal balance.
        params.softening = this.effectiveSoftening(params);

        const n = params.count;
        const start = this.bhStart(params);
        const nActive = this.activeCount(params);
        // The active set carries the whole disk mass, so each active particle is
        // heavier (Mdisk / nActive). Passive tracers are given the same value for
        // render parity; it never enters the force sums. The disk source range is
        // [start, start + nActive); set activeCount to its end now, before the field
        // helpers below read it - mirrors the accretion preset's "+1" for its index-0 SMBH.
        params.activeCount = start + nActive;
        // The split's correctness depends on the engine honouring activeCount:
        // passive tracers carry a (render-only) nonzero mass, so if the engine
        // summed over every particle instead the disk would be n/nActive times too
        // massive. Make the invariant explicit rather than relying on the default.
        params.useActivePassive = true;
        const Rd = DISK_SCALE_LENGTH;
        const Rmax = DISK_TRUNCATION * Rd;
        const seedMass = SELF_GRAV_DISK_MASS / nActive;
        this.diskMass = SELF_GRAV_DISK_MASS;

        // Pin the fixed central BH at the origin (inert, source-only marker). Its
        // GALAXY_CENTRAL_BH_MASS drives the renderers' BH glow; it is never summed as
        // a disk source and never integrated (the engines skip index 0 when blackHoleMass > 0).
        if (start === 1) {
            state.positionX[0] = 0;
            state.positionY[0] = 0;
            state.velocityX[0] = 0;
            state.velocityY[0] = 0;
            state.mass[0] = GALAXY_CENTRAL_BH_MASS;
            state.colors[0] = 1;
            state.colors[1] = 1;
            state.colors[2] = 0.85;
        }

        const radii = new Float64Array(n);
        for (let i = start; i < n; i++) {
            const angle = ctx.rng() * Math.PI * 2;
            // Sample R from the exponential-disk *radial* distribution
            // dN/dR = 2*pi*R*Sigma(R) ∝ R*exp(-R/Rd): a Gamma(k=2, scale=Rd)
            // deviate (the sum of two exponentials), truncated at Rmax by rejection.
            // The 2*pi*R area Jacobian is essential - sampling exp(-R/Rd) directly
            // realises Sigma ∝ exp(-R/Rd)/R, which is centrally divergent, not the
            // intended exponential disk.
            let R: number;
            do {
                R = -Rd * (Math.log(1 - ctx.rng()) + Math.log(1 - ctx.rng()));
            } while (R > Rmax);
            radii[i] = R;

            state.positionX[i] = Math.cos(angle) * R;
            state.positionY[i] = Math.sin(angle) * R;
            state.mass[i] = seedMass;

            // Colour still encodes a sampled stellar (Salpeter) mass for visual
            // consistency with the accretion preset; the physical mass is equal.
            const [r, g, b] = massToColor(sampleSalpeterMass(ctx.rng));
            state.colors[i * 3 + 0] = r;
            state.colors[i * 3 + 1] = g;
            state.colors[i * 3 + 2] = b;
        }

        // Recenter the disk's centre of mass on the origin. The dark-matter halo
        // is pinned to the origin (both haloAcc and the engine's DM term are
        // functions of distance from it), as are buildRotationCurve's test rings.
        // The random realisation leaves a Poisson COM offset (~Rd/sqrt(N)) that
        // would let the halo pull the disk asymmetrically (bulk sloshing) and bias
        // the measured rotation curve. Masses are equal, so this is a plain mean.
        // (Net *momentum* is handled later by removeNetMomentum; net angular
        // momentum is the intended ordered rotation and is left untouched.)
        // Average over the disk only ([start, n)); the pinned BH stays at the origin.
        const nDisk = n - start;
        let xMean = 0, yMean = 0;
        for (let i = start; i < n; i++) {
            xMean += state.positionX[i];
            yMean += state.positionY[i];
        }
        xMean /= nDisk;
        yMean /= nDisk;
        for (let i = start; i < n; i++) {
            state.positionX[i] -= xMean;
            state.positionY[i] -= yMean;
            // Recompute radii from the recentred positions so radius and direction
            // stay consistent for computeStarVelocity.
            radii[i] = Math.hypot(state.positionX[i], state.positionY[i]);
        }

        // Tabulate the azimuthally-averaged radial acceleration and surface density
        // from the realized particle distribution, then warm each star to the
        // target Q using those *measured* profiles - so Q is self-consistent with
        // the disk that actually exists, not an assumed analytic Sigma.
        this.buildRotationCurve(ctx);

        // Calibrate the total disk mass so the measured disk fraction at 2.2 R_d
        // hits TARGET_F_DISK. The disk's radial force is linear in total mass
        // (positions are mass-independent), while the *external* force (halo + fixed
        // BH) is independent of it; so measure both at the provisional mass M0 and
        // solve the single linear equation f = M*k / (M*k + vExt2) for the target
        // mass, where vExt2 is the squared circular speed from the halo and the BH.
        const Rstar = DISK_FRACTION_RADIUS_FACTOR * DISK_SCALE_LENGTH;
        const M0 = this.diskMass;
        const extAcc = haloAcc(Rstar, params) + this.bhAcc(Rstar, params);  // halo + fixed BH
        const diskAcc = this.aRadInterp(Rstar) - extAcc;            // disk-only inward accel
        const vDisk2_perMass = (diskAcc * Rstar) / M0;              // ∝, mass-independent
        const vExt2 = extAcc * Rstar;
        const f = Math.min(0.95, Math.max(0.05, TARGET_F_DISK));
        // If the external field is ~zero, f_disk is ~1 for any mass: skip and keep M0.
        if (vDisk2_perMass > 0 && vExt2 > 0) {
            let mTarget = ((f / (1 - f)) * vExt2) / vDisk2_perMass;
            // Clamp to a sane positive range relative to the seed mass.
            mTarget = Math.min(Math.max(mTarget, M0 * 1e-3), M0 * 1e6);
            // Split the calibrated total over the active set; passive tracers get
            // the same value for render parity (it is never summed as a source).
            // Index 0 (the BH) keeps GALAXY_CENTRAL_BH_MASS - only disk particles are reset.
            const m = mTarget / nActive;
            for (let i = start; i < n; i++) state.mass[i] = m;
            this.diskMass = mTarget;
            // Rebuild the rotation curve: the disk accel now scales to the
            // calibrated mass (the external term is unchanged).
            this.buildRotationCurve(ctx);
        }

        this.buildSurfaceDensity(ctx);
        // Derive a safe dt from the now-final disk mass and measured rotation
        // curve, BEFORE computeStarVelocity applies its leapfrog half-step (which
        // reads params.dt).
        params.dt = this.adaptiveTimestep(params);
        // Warm every particle - active and passive alike - to the same Q-derived
        // dispersions so the passive cloud shares the active disk's temperature and
        // traces the same spiral structure. (params.activeCount was fixed at the
        // top so the field helpers above already used the active set as sources.)
        // The pinned BH (index 0) is skipped: it keeps zero velocity.
        for (let i = start; i < n; i++) {
            this.computeStarVelocity(ctx, i, radii[i]);
        }

        // Stagger the (now synchronized) velocities half a step ahead using each
        // particle's *true* initial acceleration, so the leapfrog offset is exactly
        // consistent with the engine's first force evaluation (the per-star half-kick
        // in computeStarVelocity used only the azimuthally-averaged mean field). Must
        // run after the final dt is set above and after all velocities are assigned.
        this.applySelfGravHalfKick(ctx);

        this.removeNetMomentum(ctx);
    }

    /**
     * Re-derives every disk velocity from the current positions. The measured
     * rotation curve and surface density are rebuilt first so the recomputed
     * circular speeds and Q stay consistent with the actual field, and dt is
     * re-derived before the loop re-applies the leapfrog half-step (which reads dt).
     */
    resetVelocities(ctx: IcContext): void {
        const { params, state } = ctx;
        this.buildRotationCurve(ctx);
        this.buildSurfaceDensity(ctx);
        params.dt = this.adaptiveTimestep(params);
        // Skip index 0: it is the pinned central black hole marker (bhStart() === 1)
        // and must keep its own velocity rather than be re-warmed as a disk star.
        for (let i = this.bhStart(params); i < params.count; i++) {
            const distSq = state.positionX[i] * state.positionX[i] + state.positionY[i] * state.positionY[i];
            this.computeStarVelocity(ctx, i, Math.sqrt(distSq));
        }
    }

    /**
     * Timestep to use for the self-gravitating disk, derived from the disk that
     * actually exists (measured rotation curve + heavy-macro-particle encounters)
     * so it can never silently under-resolve when the central mass (and hence
     * orbital speeds) is raised: dynamical times shrink as 1/sqrt(mass) while the
     * preset dt stays fixed.
     *
     * dt is the minimum of three limits, floored so a mis-scaling can't stall the
     * sim:
     *   1. the engine preset dt (never run faster, nor slower unless forced);
     *   2. an orbital-resolution limit, one period at the peak angular frequency
     *      Omega_max over the measured rotation-curve grid, divided by
     *      {@link STEPS_PER_ORBIT};
     *   3. a close-encounter limit for the heavy macro-particles,
     *      {@link ENCOUNTER_SAFETY} * sqrt(eps^3 / (G m)), eps the softening.
     * Reads the live {@link diskMass} and rotation-curve table (not the disk-mass
     * constant), so it stays correct if the mass is recalibrated and the curve
     * rebuilt before velocities are set. Requires the rotation curve to exist;
     * falls back to the preset dt otherwise. Mirrors {@link effectiveSoftening}.
     */
    adaptiveTimestep(params: SimulationParams): number {
        const presetDt = presetFor(params.engineType).timeStep;
        const acc = this.rotCurveAcc;
        if (!acc) return presetDt;

        let dt = presetDt; // limit 1: never faster than the preset.

        // limit 2: resolve the fastest orbit. Omega(r) = vCirc(r)/r, peaked over
        // the rotation-curve radius grid (skip r = 0).
        const Nr = acc.length;
        let omegaMax = 0;
        for (let k = 0; k < Nr; k++) {
            const rk = this.rotCurveRMin + ((this.rotCurveRMax - this.rotCurveRMin) * k) / (Nr - 1);
            if (rk <= 0) continue;
            const omega = this.vCircAt(rk) / rk;
            if (omega > omegaMax) omegaMax = omega;
        }
        if (omegaMax > 0) {
            dt = Math.min(dt, (2 * Math.PI / omegaMax) / STEPS_PER_ORBIT);
        }

        // limit 3: resolve a near-softening-length close encounter with a heavy
        // *active* macro-particle (mass = Mdisk / N_active). Passive tracers are
        // massless to the field but can still be flung by a close active pass, so
        // the active particle mass sets the encounter timescale.
        const eps = this.effectiveSoftening(params);
        const mParticle = this.diskMass / this.activeCount(params);
        const G = params.gravity;
        if (mParticle > 0 && G > 0) {
            dt = Math.min(dt, ENCOUNTER_SAFETY * Math.sqrt((eps * eps * eps) / (G * mParticle)));
        }

        // Floor so a pathological (mis-scaled) choice can't crawl the sim to a halt.
        return Math.max(dt, presetDt * MIN_DT_FRACTION);
    }

    /**
     * Softening to use given the current engine. The engine preset's softening is
     * overridden with ~the disk's local inter-particle spacing so the disk is
     * collisionless rather than exploding (see {@link SELF_GRAV_SOFTENING_FACTOR}).
     * Auto-scales with star count. The base is taken from the engine preset (not the
     * current params.softening) so a stale self-gravitating value can't leak back
     * into the accretion preset when toggling modes on an engine that doesn't reset it.
     *
     * The exponential disk is centrally concentrated, so the *mean*-area spacing
     * would under-soften the dense centre. We instead use the local spacing at the
     * half-mass radius (R_1/2 ~ 1.68 R_d), where most of the mass and the relevant
     * dynamics live: spacing = 1/sqrt(n_surf), n_surf = Sigma(R_1/2) / m_particle.
     */
    effectiveSoftening(params: SimulationParams): number {
        const base = presetFor(params.engineType).softening;
        // Collisionality is set by the heavy *active* macro-particles (each carries
        // Mdisk / N_active and sources the field), so the relevant mass and spacing
        // are the active ones, not the full-count ones.
        const nActive = this.activeCount(params);
        const mParticle = SELF_GRAV_DISK_MASS / nActive;
        const rHalf = 1.68 * DISK_SCALE_LENGTH;
        const sigma0 = SELF_GRAV_DISK_MASS / (2 * Math.PI * DISK_SCALE_LENGTH * DISK_SCALE_LENGTH);
        const sigmaHalf = sigma0 * Math.exp(-rHalf / DISK_SCALE_LENGTH);
        const spacing = Math.sqrt(mParticle / Math.max(sigmaHalf, 1e-30));
        return Math.max(base, SELF_GRAV_SOFTENING_FACTOR * spacing);
    }

    /**
     * Number of *active* (field-generating) macro-particles in the
     * self-gravitating disk: the first `selfGravActiveCount` indices, clamped to
     * the particle count (and at least 1). When it equals the count the
     * active/passive split is inert and every particle is active. Derived from the
     * parameter rather than `params.activeCount` so it is correct regardless of
     * call order (e.g. {@link effectiveSoftening} runs before {@link initialise}
     * sets `params.activeCount`). See {@link SELF_GRAV_ACTIVE_COUNT}.
     */
    activeCount(params: SimulationParams): number {
        // Index 0 is reserved for the pinned BH marker when present, so the disk
        // (and its active source range) starts at bhStart(). Clamp the active count
        // to the slots actually available to the disk.
        const avail = Math.max(params.count - this.bhStart(params), 1);
        return Math.max(1, Math.min(params.selfGravActiveCount, avail));
    }

    /**
     * First particle index that belongs to the disk. The self-gravitating preset
     * reserves index 0 for the fixed central black hole (an inert, source-only
     * marker pinned at the origin), so the disk - and every disk source loop and
     * the engines' pairwise/integration loops - starts at 1 when
     * `params.blackHoleMass` is on.
     */
    bhStart(params: SimulationParams): number {
        return params.blackHoleMass > 0 ? 1 : 0;
    }

    /** Circular speed from the measured rotation curve. */
    vCircAt(r: number): number {
        return Math.sqrt(Math.max(this.aRadInterp(r) * r, 0));
    }

    /**
     * Epicyclic frequency kappa = sqrt(2 (v/R)(v/R + dv/dR)) from the measured
     * rotation curve via central finite difference.
     */
    kappaAt(r: number): number {
        // Differentiate over >=2 rotation-curve grid cells, not a single linear
        // interpolation segment, so the central difference averages out the
        // per-cell staircase / Poisson noise of the table instead of reading the
        // slope of one segment.
        const acc = this.rotCurveAcc;
        const hGrid = acc && acc.length > 1
            ? (this.rotCurveRMax - this.rotCurveRMin) / (acc.length - 1)
            : 1e-3;
        const dr = Math.max(2 * hGrid, r * 0.05);
        const rMinus = Math.max(r - dr, 1e-6);
        const vP = this.vCircAt(r + dr);
        const vM = this.vCircAt(rMinus);
        const dvdr = (vP - vM) / (r + dr - rMinus);
        const omega = this.vCircAt(r) / Math.max(r, 1e-6);
        return Math.sqrt(Math.max(2 * omega * (omega + dvdr), 1e-6));
    }

    /**
     * Radial velocity dispersion for the target Toomre Q at radius `r`:
     * Q = sigma_R * kappa / (3.36 * G * Sigma) => sigma_R = Q * 3.36 * G * Sigma / kappa,
     * corrected for the engine's Plummer softening.
     *
     * The running engine softens gravity with a Plummer kernel (eps = params.softening,
     * on the order of the inter-particle spacing - not negligible). For a razor-thin disk
     * this reduces the in-plane self-gravity of a surface-density perturbation at wavenumber
     * k by exactly exp(-k*eps): the 2-D Hankel transform of 1/sqrt(r^2+eps^2) is
     * (2*pi/k)*exp(-k*eps). Evaluating at the Toomre most-unstable wavenumber
     * k_crit = kappa^2 / (2*pi*G*Sigma) and folding exp(-k_crit*eps) into the effective
     * surface density makes the *physical* (unsoftened) swing-amplification Q equal TOOMRE_Q,
     * instead of the softened disk being silently over-stabilised (~10% near R_d, up to ~25%
     * in the inner disk).
     */
    sigmaRAt(r: number, params: SimulationParams): number {
        const Sigma = this.diskSurfaceDensity(r); // already floored > 0
        const kappa = this.kappaAt(r);
        const eps = params.softening;
        const kCrit = (kappa * kappa) / (2 * Math.PI * params.gravity * Sigma);
        const soften = Math.exp(-kCrit * eps);
        return (TOOMRE_Q * 3.36 * params.gravity * Sigma * soften) / kappa;
    }

    /**
     * Disk fraction f_disk = v_disk^2 / v_c^2 at radius `r` from the current
     * rotation curve, i.e. the share of the circular speed provided by the disk's
     * own gravity. Both the dark-matter halo and the fixed central black hole are
     * *external* fields (independent of the disk mass), so both are subtracted -
     * matching the mass calibration in {@link initialise}, which targets exactly
     * this ratio. Exposed for verification/telemetry without reaching into
     * private fields.
     */
    diskFractionAt(r: number, params: SimulationParams): number {
        const total = this.aRadInterp(r) * r;
        const disk = (this.aRadInterp(r) - haloAcc(r, params) - this.bhAcc(r, params)) * r;
        return disk / Math.max(total, 1e-30);
    }

    /**
     * Surface density at radius `r`, linearly interpolated from the measured
     * profile {@link surfDensProfile} (bin centres at (k + 0.5) * dr). Falls back
     * to the smooth analytic exponential before the profile is built and beyond
     * the measured (truncated) range, and floors at a tiny positive value so the
     * asymmetric-drift log-derivative stays finite.
     */
    diskSurfaceDensity(r: number): number {
        const prof = this.surfDensProfile;
        const dr = this.surfDensDr;
        if (!prof || dr <= 0) return this.analyticSurfaceDensity(r);
        const Nr = prof.length;
        const t = r / dr - 0.5; // continuous bin-centre coordinate
        if (t <= 0) return Math.max(prof[0], 1e-30);
        if (t >= Nr - 1) return this.analyticSurfaceDensity(r);
        const k = Math.floor(t);
        const frac = t - k;
        return Math.max(prof[k] * (1 - frac) + prof[k + 1] * frac, 1e-30);
    }

    /**
     * Inward radial acceleration from the fixed central black hole at radius `r`:
     * a_BH = G * M_BH * r / (r^2 + eps_BH^2)^1.5, the magnitude the engines'
     * analytic SMBH term produces (distSq = r^2 + eps_BH^2). Zero when the BH is
     * off, so it is a no-op there. Folded into the measured rotation curve, the
     * mass calibration, and the leapfrog half-kick so the disk starts in
     * centrifugal balance with the BH the engine actually applies.
     */
    private bhAcc(r: number, params: SimulationParams): number {
        const M = params.blackHoleMass;
        if (M <= 0) return 0;
        const epsSq = params.blackHoleSoftening * params.blackHoleSoftening;
        const d = r * r + epsSq;
        return (params.gravity * M * r) / (d * Math.sqrt(d));
    }

    /**
     * Analytic exponential surface density Sigma(R) = Sigma0 * exp(-R/R_d),
     * Sigma0 = Mdisk / (2*pi*R_d^2). Smooth fallback for {@link diskSurfaceDensity}
     * before the measured profile is built and beyond its (truncated) range.
     */
    private analyticSurfaceDensity(r: number): number {
        const Rd = DISK_SCALE_LENGTH;
        const sigma0 = this.diskMass / (2 * Math.PI * Rd * Rd);
        return sigma0 * Math.exp(-r / Rd);
    }

    /**
     * Builds {@link surfDensProfile}: the azimuthally-averaged surface density of
     * the *realized* disk, from a mass-weighted histogram of particle radii
     * (Sigma_k = M_k / area of shell k), lightly boxcar-smoothed to suppress
     * Poisson noise. Measuring Sigma - rather than assuming the analytic
     * exponential - keeps the Toomre-Q calibration consistent with the disk that
     * actually exists, independent of the position sampling.
     */
    private buildSurfaceDensity(ctx: IcContext) {
        const { params, state } = ctx;
        const Nr = 100;
        // Sum only the disk active set: it carries the full disk mass and sources the
        // field, so its surface density is the one the Toomre-Q warming must use.
        // Passive tracers share the active particles' render mass but must not be
        // double-counted into the field's Sigma; the pinned BH (index 0) carries
        // GALAXY_CENTRAL_BH_MASS and is excluded entirely (not part of the disk's Sigma).
        const start = this.bhStart(params);
        const srcEnd = start + this.activeCount(params);
        const rMax = DISK_TRUNCATION * DISK_SCALE_LENGTH;
        const dr = rMax / Nr;
        const px = state.positionX;
        const py = state.positionY;
        const mass = state.mass;

        // Mass per radial shell, converted to a surface density by shell area
        // pi*((k+1)^2 - k^2)*dr^2 = pi*(2k+1)*dr^2.
        const raw = new Float64Array(Nr);
        for (let i = start; i < srcEnd; i++) {
            const r = Math.sqrt(px[i] * px[i] + py[i] * py[i]);
            const k = Math.floor(r / dr);
            if (k >= 0 && k < Nr) raw[k] += mass[i];
        }
        for (let k = 0; k < Nr; k++) {
            raw[k] /= Math.PI * (2 * k + 1) * dr * dr;
        }

        // Boxcar smoothing (half-width 2 bins) to tame shot noise, especially in
        // the sparsely-populated inner and outer shells.
        const sigma = new Float64Array(Nr);
        const h = 2;
        for (let k = 0; k < Nr; k++) {
            let sum = 0, cnt = 0;
            for (let j = Math.max(0, k - h); j <= Math.min(Nr - 1, k + h); j++) {
                sum += raw[j];
                cnt++;
            }
            sigma[k] = sum / cnt;
        }

        this.surfDensProfile = sigma;
        this.surfDensDr = dr;
    }

    /**
     * Builds {@link rotCurveAcc}: the azimuthally-averaged inward radial
     * acceleration of the *realized* disk (summed pairwise from every disk source,
     * using the engine's softening) plus the analytic halo and the fixed central
     * black hole, sampled on a uniform radius grid. Setting circular speeds from
     * this - rather than a spherical enclosed-mass monopole, which is wrong for a
     * 2-D 1/r^2 disk - is what makes the disk start in centrifugal balance with the
     * forces the engine computes.
     */
    private buildRotationCurve(ctx: IcContext) {
        const { params, state } = ctx;
        const Nr = 128;
        const Naz = 32;
        // Only the disk active set sources the pairwise field (mirrors the engine,
        // which sums over [bhStart, activeCount)); passive tracers carry a render
        // mass but do not gravitate, and the pinned BH (index 0) is excluded here -
        // its contribution is the analytic bhAcc term added below. The active disk
        // particles are an i.i.d. subsample of the same exponential profile, so they
        // reproduce the field shape (with sqrt(N) more shot noise) at the full disk
        // mass they collectively carry.
        const start = this.bhStart(params);
        const srcEnd = start + this.activeCount(params);
        const G = params.gravity;
        const epsSq = params.softening * params.softening;
        const px = state.positionX;
        const py = state.positionY;
        const mass = state.mass;

        const rMin = 0;
        const rMax = 1.1 * DISK_TRUNCATION * DISK_SCALE_LENGTH;
        const acc = new Float64Array(Nr);

        // Precompute azimuth unit vectors of the test points.
        const cos = new Float64Array(Naz);
        const sin = new Float64Array(Naz);
        for (let a = 0; a < Naz; a++) {
            const theta = (2 * Math.PI * a) / Naz;
            cos[a] = Math.cos(theta);
            sin[a] = Math.sin(theta);
        }

        for (let k = 0; k < Nr; k++) {
            const rk = rMin + ((rMax - rMin) * k) / (Nr - 1);
            if (rk === 0) {
                acc[k] = 0;
                continue;
            }
            let aRadSum = 0;
            for (let a = 0; a < Naz; a++) {
                const tx = cos[a] * rk;
                const ty = sin[a] * rk;
                let axTot = 0;
                let ayTot = 0;
                for (let j = start; j < srcEnd; j++) {
                    const dx = px[j] - tx;
                    const dy = py[j] - ty;
                    const distSq = dx * dx + dy * dy + epsSq;
                    const invD = 1 / Math.sqrt(distSq);
                    const f = (G * mass[j] * invD) / distSq; // G m / (r^2+eps^2)^1.5
                    axTot += f * dx;
                    ayTot += f * dy;
                }
                // Inward radial component along the test-point radial direction.
                aRadSum += -(axTot * cos[a] + ayTot * sin[a]);
            }
            // Disk pairwise field + dark-matter halo + fixed central BH.
            acc[k] = aRadSum / Naz + haloAcc(rk, params) + this.bhAcc(rk, params);
        }

        // Light boxcar smoothing (half-width 1 bin) to suppress residual Poisson
        // noise in the table without flattening the steep inner rise of v_c.
        // Mirrors buildSurfaceDensity; acc[0] (the r=0 zero) is left untouched.
        const smoothed = new Float64Array(Nr);
        smoothed[0] = acc[0];
        const hAcc = 1;
        for (let k = 1; k < Nr; k++) {
            let sum = 0, cnt = 0;
            for (let j = Math.max(1, k - hAcc); j <= Math.min(Nr - 1, k + hAcc); j++) {
                sum += acc[j];
                cnt++;
            }
            smoothed[k] = sum / cnt;
        }

        this.rotCurveAcc = smoothed;
        this.rotCurveRMin = rMin;
        this.rotCurveRMax = rMax;
    }

    /** Linearly-interpolated inward radial acceleration from {@link rotCurveAcc}. */
    private aRadInterp(r: number): number {
        const acc = this.rotCurveAcc;
        if (!acc) return 0;
        const Nr = acc.length;
        const r0 = this.rotCurveRMin;
        const r1 = this.rotCurveRMax;
        if (r <= r0) return acc[0];
        if (r >= r1) return acc[Nr - 1] * ((r1 * r1) / (r * r)); // ~1/r^2 tail
        const t = ((r - r0) / (r1 - r0)) * (Nr - 1);
        const k = Math.floor(t);
        const frac = t - k;
        return acc[k] * (1 - frac) + acc[k + 1] * frac;
    }

    /**
     * Sets the synchronized velocity for star `i` at radius `dist`: the measured
     * circular speed, warmed with radial + tangential dispersions for a target
     * Toomre Q, with the mean azimuthal speed lowered by the asymmetric drift so
     * the warm disk stays in radial equilibrium.
     */
    private computeStarVelocity(ctx: IcContext, i: number, dist: number) {
        const { params, state } = ctx;
        const px = state.positionX[i];
        const py = state.positionY[i];
        const r = Math.max(dist, 1e-3);

        // Radial (outward) and tangential (counter-clockwise) unit vectors.
        const ux = px / r;
        const uy = py / r;
        const tx = -uy;
        const ty = ux;

        const vCirc = this.vCircAt(r);
        const omega = vCirc / r;
        const kappa = this.kappaAt(r);

        const sigmaR = this.sigmaRAt(r, params);
        const sigmaPhi = sigmaR * (kappa / (2 * omega));

        // Asymmetric drift (Binney & Tremaine 2008, eq. 4.228, approx):
        // v_c - v_phi ~ sigma_R^2 / (2 v_c) * [sigma_phi^2/sigma_R^2 - 1 -
        //   d ln(Sigma sigma_R^2)/d ln R]. Lowers the mean azimuthal speed so
        // the pressure-supported disk is not over-supported and flung outward.
        let vBarPhi = vCirc;
        if (vCirc > 1e-6) {
            const dr = Math.max(r * 0.01, 1e-3);
            const rMinus = Math.max(r - dr, 1e-3);
            const fPlus = this.diskSurfaceDensity(r + dr) * this.sigmaRAt(r + dr, params) ** 2;
            const fMinus = this.diskSurfaceDensity(rMinus) * this.sigmaRAt(rMinus, params) ** 2;
            const dlnf = (Math.log(fPlus) - Math.log(fMinus)) / (Math.log(r + dr) - Math.log(rMinus));
            const ratioSq = (sigmaPhi * sigmaPhi) / (sigmaR * sigmaR);
            const va = ((sigmaR * sigmaR) / (2 * vCirc)) * (ratioSq - 1 - dlnf);
            vBarPhi = Math.min(Math.max(vCirc - va, 0), vCirc);
        }

        // Safety: a pressure-supported disk has sigma < v_circ everywhere, so
        // cap the dispersion kicks at the local circular speed. This is inert
        // for the calibrated disk and only tames the r -> 0 limit, where
        // v_circ -> 0 but Sigma stays finite (otherwise that lone central
        // particle would get an ejecting kick).
        const dvR = gaussianRandom(ctx.rng) * Math.min(sigmaR, vCirc);
        const dvPhi = gaussianRandom(ctx.rng) * Math.min(sigmaPhi, vCirc);

        // Assign the *synchronized* velocity only. The leapfrog half-step
        // offset is applied later in initialise by applySelfGravHalfKick,
        // which uses each particle's true (Poisson) acceleration rather than the
        // azimuthally-averaged mean field, so the stagger matches the engine.
        state.velocityX[i] = tx * vBarPhi + ux * dvR + tx * dvPhi;
        state.velocityY[i] = ty * vBarPhi + uy * dvR + ty * dvPhi;
    }

    /**
     * Applies the leapfrog half-kick (v += a*dt/2) to the self-gravitating disk
     * using each particle's *true* initial acceleration, mirroring the
     * BruteForceEngine kernel exactly so the staggered velocities match the
     * integrator's first force evaluation: a_i = sum_j G*m_j*d/(d^2+eps^2)^1.5 plus
     * the origin-pinned dark-matter halo and the fixed central black hole. This is a
     * one-time O(N^2) pass at init (~1e8 ops at N=1e4, same order as
     * buildRotationCurve), acceptable for initial conditions. Must run after the
     * final dt is set and after synchronized velocities are assigned.
     */
    private applySelfGravHalfKick(ctx: IcContext) {
        const { params, state } = ctx;
        const n = params.count;
        const start = this.bhStart(params);
        // Force sources are the active set only, exactly as the engine does it: an
        // active particle feels the other active particles, a passive particle
        // feels the active particles, and neither feels the passive set. Restricting
        // the inner loop to the disk active range is both the correct mirror and what
        // turns this one-time pass from O(N^2) into O(N * N_active) so a large passive
        // cloud does not stall init. The pinned BH (index 0) is not a pairwise source
        // - its pull is the analytic bhAcc term below - and is itself skipped.
        const srcEnd = start + this.activeCount(params);
        const px = state.positionX;
        const py = state.positionY;
        const mass = state.mass;
        const G = params.gravity;
        const softeningSq = params.softening * params.softening;
        const halfDt = params.dt / 2;

        for (let i = start; i < n; i++) {
            const pix = px[i];
            const piy = py[i];
            let ax = 0;
            let ay = 0;

            // Pairwise self-gravity (mirrors BruteForceEngine: distSq includes eps^2).
            for (let j = start; j < srcEnd; j++) {
                if (j === i) continue;
                const dx = px[j] - pix;
                const dy = py[j] - piy;
                const distSq = dx * dx + dy * dy + softeningSq;
                const dist = Math.sqrt(distSq);
                const aBase = (G * mass[j]) / (distSq * dist);
                ax += aBase * dx;
                ay += aBase * dy;
            }

            // External central forces along the inward radial direction: the
            // dark-matter halo and the fixed BH. haloAcc(r)/r and bhAcc(r)/r equal
            // the engine's aDM_base and aSMBH, so this matches the engine's terms.
            const r = Math.hypot(pix, piy);
            if (r > 0) {
                const aExt = haloAcc(r, params) + this.bhAcc(r, params);
                ax -= (pix / r) * aExt;
                ay -= (piy / r) * aExt;
            }

            state.velocityX[i] += ax * halfDt;
            state.velocityY[i] += ay * halfDt;
        }
    }

    /**
     * Subtracts the mass-weighted mean velocity from every disk body so the disk
     * carries zero net linear momentum. Without this, Poisson asymmetry in the
     * disk's random realisation gives the whole galaxy a small bulk drift across
     * the view. Operates over the disk range [bhStart, n) only: the fixed central
     * BH (index 0) stays pinned at zero velocity and must not absorb the drift.
     */
    private removeNetMomentum(ctx: IcContext) {
        const { params, state } = ctx;
        const n = params.count;
        const start = this.bhStart(params);
        let pxSum = 0, pySum = 0, mSum = 0;
        for (let i = start; i < n; i++) {
            const m = state.mass[i];
            pxSum += m * state.velocityX[i];
            pySum += m * state.velocityY[i];
            mSum += m;
        }
        if (mSum <= 0) return;
        const vxMean = pxSum / mSum;
        const vyMean = pySum / mSum;
        for (let i = start; i < n; i++) {
            state.velocityX[i] -= vxMean;
            state.velocityY[i] -= vyMean;
        }
    }
}
