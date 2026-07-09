/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import {
    PhysicsState,
    PhysicsMemory,
    WebGPUEngine,
    WebGPUUnavailableError,
    BruteForceEngine,
    BarnesHutEngine,
    WorkerBridge,
} from '../physics';
import type { AnyEngine } from '../physics';
import { CanvasRenderer } from '../rendering';
import { massToColor } from '../utils';

/**
 * Preset configuration values for different physics engines.
 */
export const ENGINE_PRESETS = {
    brute: { theta: 0.0, softening: 1.0, timeStep: 0.016 },
    barnes: { theta: 1.0, softening: 1.0, timeStep: 0.016 },
    webgpu: { theta: 0.0, softening: 1.0, timeStep: 0.016 }
};

/**
 * Base radius for galaxy particle distribution generation. Used by the accretion
 * preset, which seeds the disk in the annulus
 * [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. The self-gravitating
 * preset instead uses an exponential profile (see {@link DISK_SCALE_LENGTH}).
 */
export const GALAXY_RADIUS = 500;

/**
 * Inner radius of the accretion-preset annulus (see {@link GALAXY_RADIUS}).
 */
export const DISK_INNER_RADIUS = 10;

/**
 * Mass of the galaxy preset's fixed central black hole (the source mass folded
 * into the measured rotation curve via {@link SimulationManager.bhAcc}). The
 * value is unchanged from the old shared central-mass constant. The accretion
 * preset uses its own, far larger {@link ACCRETION_BH_MASS}.
 */
export const GALAXY_CENTRAL_BH_MASS = 2600;

/**
 * Mass of the accretion preset's central SMBH (the live particle at index 0 and
 * the source of {@link SimulationManager.radialAcc}'s analytic Keplerian field).
 *
 * Over the test-particle annulus R in [DISK_INNER_RADIUS, DISK_INNER_RADIUS +
 * GALAXY_RADIUS] = [10, 510] at gravity = 1, this gives inner circular speed
 * v_c(10) = sqrt(1e6/10) ~ 316 and outer v_c(510) ~ 44 - clearly Keplerian
 * (v_c proportional to 1/sqrt(r)), with dramatic inner shear, and dwarfing the
 * total mass of the thousands of Salpeter test particles (0.1-50 each) so they
 * behave as a collisionless disk orbiting a dominant point mass. The adaptive
 * timestep ({@link SimulationManager.computeAdaptiveTimestep}) shrinks dt to keep
 * the fast inner orbits resolved.
 */
export const ACCRETION_BH_MASS = 1.001e6;

/**
 * Default dark-matter halo strength for each preset. The galaxy wants a halo
 * (a flat outer rotation curve); the accretion preset is a clean Keplerian
 * test-particle disk about a dominant SMBH, so DM is off by default. This is the
 * single source for both the initial {@link SimulationManager.params}.dmStrength
 * and the DM-only reset performed when the user switches presets in the UI.
 * @param preset - The simulation preset.
 * @returns The default dmStrength for that preset (0 for accretion, 250 for galaxy).
 */
export function presetDmDefault(preset: 'accretion' | 'galaxy'): number {
    return preset === 'accretion' ? 0 : 250;
}

/**
 * Exponential scale length R_d of the self-gravitating disk:
 * Sigma(R) = Sigma0 * exp(-R/R_d). Unlike the old uniform-in-radius (Sigma ~ 1/R)
 * profile, this is finite at the centre (no sigma_R cap needed) and tapers
 * smoothly (no hard edge to seed instabilities).
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
 * mass is not this value: it is calibrated in {@link SimulationManager.initSelfGravDisk}
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
 * {@link SimulationManager.effectiveSoftening}). The engine presets use
 * softening = 1.0, which is correct for the central-mass-dominated accretion preset
 * but far smaller than the disk's particle spacing. With self-gravity ON that
 * makes the disk collisional: close encounters between the massive macro-particles
 * deliver huge velocity kicks that fling stars out within a crossing time.
 * Softening on the order of the spacing makes the disk behave as the smooth,
 * collisionless system the model assumes.
 */
export const SELF_GRAV_SOFTENING_FACTOR = 0.9;

/**
 * Minimum number of leapfrog steps used to resolve the fastest (innermost) orbit
 * of the self-gravitating disk: the orbital-resolution dt limit is one orbital
 * period at the peak angular frequency divided by this. See
 * {@link SimulationManager.computeAdaptiveTimestep}.
 */
export const STEPS_PER_ORBIT = 50;

/**
 * Safety factor on the close-encounter dt limit for the heavy macro-particles:
 * dt <= ENCOUNTER_SAFETY * sqrt(eps^3 / (G * m_particle)), the timestep that
 * resolves a near-softening-length two-body encounter. See
 * {@link SimulationManager.computeAdaptiveTimestep}.
 */
export const ENCOUNTER_SAFETY = 0.05;

/**
 * Floor on the adaptive timestep, as a fraction of the engine preset dt, so a
 * pathological choice can't make the simulation crawl to a halt. Hitting this
 * floor signals the disk mass / halo are mis-scaled (but is not treated as an
 * error). See {@link SimulationManager.computeAdaptiveTimestep}.
 */
export const MIN_DT_FRACTION = 1 / 64;

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
 * orbital-resolution dt limit (see {@link SimulationManager.computeAdaptiveTimestep})
 * shrinks as the inner well steepens, so too small a value drives dt toward the
 * {@link MIN_DT_FRACTION} floor. Chosen on the order of the disk softening so the
 * BH dominates the centre without crushing the timestep. Only the self-gravitating
 * preset uses a fixed central BH; the accretion preset's SMBH is a live particle
 * (index 0) instead, with {@link blackHoleMass} left at 0.
 */
export const SELF_GRAV_BH_SOFTENING = 25;

/**
 * Manages the state, memory, and lifecycle of the N-Body physics simulation.
 */
export class SimulationManager {
    memory!: PhysicsMemory;
    state!: PhysicsState;
    engine!: AnyEngine;
    webGpuEngine: WebGPUEngine | null = null;
    workerBridge: WorkerBridge | null = null;
    renderer!: CanvasRenderer;

    /**
     * False once WebGPU has been determined unusable (unavailable at startup or
     * the device was lost at runtime). Callers should not attempt to (re)select
     * the GPU engine while this is false.
     */
    webGpuAvailable = true;

    /**
     * Whether the one-time GPU re-creation has already been spent. On the first
     * post-init device loss we attempt to rebuild the device once; a subsequent
     * loss (or a failed rebuild) falls back to the CPU engine for good.
     */
    private webGpuRecoveryAttempted = false;

    /**
     * Invoked when the simulation is forced off WebGPU onto a CPU engine, either
     * because init failed or the device was lost. Lets the UI disable the GPU
     * option and surface a visible notice. `reason` is a short human-readable
     * explanation suitable for display.
     */
    onEngineFallback: (reason: string) => void = () => { };

    animationFrameId: number = 0;
    frames = 0;
    lastTelemetryUpdate = 0;

    /**
     * Effective total disk mass of the current initialisation. Non-zero only in
     * the self-gravitating preset; used to add the disk's own contribution to
     * the circular velocity and to compute the Toomre-Q velocity dispersion.
     */
    diskMass = 0;

    /**
     * Azimuthally-averaged radial-acceleration table (a vs radius) for the
     * self-gravitating disk, built from the *realized* particle distribution
     * plus the halo (see {@link SimulationManager.buildRotationCurve}). Sampled
     * on a uniform grid [rotCurveRMin, rotCurveRMax] so the initial circular
     * speed and epicyclic frequency match the engine's actual 2-D forces.
     */
    private rotCurveAcc: Float64Array | null = null;
    private rotCurveRMin = 0;
    private rotCurveRMax = 0;

    /**
     * Source of randomness for all initial-condition sampling (Salpeter masses,
     * disk positions/velocities). Defaults to Math.random so production behaviour
     * is unchanged; tests inject a seeded mulberry32 for deterministic draws.
     */
    private rng: () => number = Math.random;

    /**
     * Azimuthally-averaged surface-density profile (Sigma vs radius) of the
     * self-gravitating disk, measured from the *realized* particle distribution
     * (see {@link SimulationManager.buildSurfaceDensity}). Bin k is centred at
     * (k + 0.5) * surfDensDr. Used to set the Toomre-Q velocity dispersion from
     * the disk that actually exists rather than an assumed analytic Sigma.
     */
    private surfDensProfile: Float64Array | null = null;
    private surfDensDr = 0;

    // Fixed-timestep accumulator: decouples simulation speed from display refresh
    // rate so the physics advances at the same wall-clock rate on 60/120/144 Hz.
    private lastFrameTime = 0;
    private accumulator = 0;
    private static readonly MAX_SUBSTEPS = 5;

    /**
     * Callback triggered periodically to report simulation performance metrics.
     * @param fps - The calculated frames per second over the last telemetry interval.
     * @param sim - Reference to the current SimulationManager instance.
     */
    onTelemetry: (fps: number, sim: SimulationManager) => void = () => { };

    /**
     * Core configuration parameters governing physical forces, memory allocation, and UI visual states.
     * Adjusted dynamically by runtime interactions in the UI.
     */
    params = {
        engineType: 'webgpu',
        // Simulation preset (initial conditions):
        //   'accretion' - SMBH/halo-dominated; disk is light (test-particle) -> rings
        //   'galaxy'    - massive self-gravitating disk tuned to Toomre Q -> spiral arms
        preset: 'galaxy' as 'accretion' | 'galaxy',
        gravity: 1,
        dt: 0.016,
        softening: 1.0,
        count: 10000,
        useActivePassive: true,
        activeCount: 0,
        // Self-gravitating preset only: number of field-generating macro-particles
        // (the first `selfGravActiveCount` indices). The rest are passive tracers.
        // See {@link SELF_GRAV_ACTIVE_COUNT}. Inert when >= count (all active).
        selfGravActiveCount: SELF_GRAV_ACTIVE_COUNT,
        theta: 1.0,
        massThreshold: 1.0,
        // Fixed central black hole. Non-zero only in the self-gravitating preset,
        // where it pins an inert, source-only point mass at the origin (index 0).
        // The accretion preset leaves this 0 and uses a live SMBH particle instead.
        blackHoleMass: 0,
        blackHoleSoftening: SELF_GRAV_BH_SOFTENING,
        isPaused: false,
        cameraZoom: 1.0,
        cameraX: 0.0,
        cameraY: 0.0,
        cameraTilt: 0.6,
        // Tied to the default preset (galaxy) via presetDmDefault so the two
        // can't drift apart. The UI resets this to presetDmDefault(preset) on switch.
        dmStrength: presetDmDefault('galaxy'),
        dmCoreRadius: 1200.0,
        shouldShowQuadTree: false,
    };

    /**
     * Initializes the simulation manager, galaxy data, and renders to the canvas.
     * @param canvasId - The ID of the HTML canvas element.
     */
    async init(canvasId: string) {
        this.initGalaxy();

        this.renderer = new CanvasRenderer(canvasId, this.state);

        if (this.params.engineType === 'webgpu') {
            try {
                this.webGpuEngine = new WebGPUEngine();
                await this.webGpuEngine.init(this.params.count, this.state, this.params.activeCount);
                this.registerWebGpuLossHandler();
                this.engine = this.webGpuEngine;
                this.webGpuEngine.setVisible(true);
                this.renderer.canvas.style.display = 'none';

                const preset = ENGINE_PRESETS['webgpu'];
                if (preset) {
                    this.params.theta = preset.theta;
                    this.params.softening = preset.softening;
                    this.params.dt = preset.timeStep;
                }
                // The preset resets softening to the accretion-preset value; restore
                // the larger self-gravitating softening so the disk stays stable.
                this.params.softening = this.effectiveSoftening();
                // Likewise restore the disk's derived dt (no-op for the accretion
                // preset) so a preset switch can't leave a stale preset dt on the
                // self-gravitating disk.
                this.params.dt = this.computeAdaptiveTimestep();
            } catch (err) {
                this.markWebGpuUnavailable(err);
                this.params.engineType = 'barnes';
                await this.switchEngine('barnes');
            }
        } else {
            await this.switchEngine(this.params.engineType);
        }
    }

    /**
     * Records that WebGPU is unusable and tears down any half-initialised engine.
     * Centralises the bookkeeping shared by a failed init and a runtime device
     * loss. Does not itself switch engines - the caller decides how to recover.
     * @param err - The originating error, logged for diagnostics.
     */
    private markWebGpuUnavailable(err: unknown) {
        this.webGpuAvailable = false;
        const reason = err instanceof WebGPUUnavailableError ? err.message
            : err instanceof Error ? err.message
                : String(err);
        console.error(`WebGPU unavailable, falling back to CPU physics: ${reason}`, err);
        if (this.webGpuEngine) {
            // Release the device, GPU buffers, and the appended canvas - not just
            // hide it - so a lost/failed GPU engine leaves nothing behind.
            this.webGpuEngine.dispose();
            this.webGpuEngine = null;
        }
    }

    /**
     * Handles a WebGPU failure detected *after* a successful start (a runtime
     * device loss): marks GPU unavailable, switches to the Barnes-Hut CPU engine,
     * and notifies the UI so it can disable the option and show a notice.
     * @param notice - Human-readable message shown to the user.
     */
    private handleWebGpuFailure(notice: string) {
        if (!this.webGpuAvailable) return; // Already handled.
        this.markWebGpuUnavailable(new WebGPUUnavailableError(notice));
        this.params.engineType = 'barnes';
        // switchEngine is async; we are in a fire-and-forget callback context.
        void this.switchEngine('barnes').then(() => this.onEngineFallback(notice));
    }

    /**
     * Points the active GPU engine's device-loss callback at {@link onWebGpuDeviceLost}.
     * Shared by every place that (re)creates the WebGPU engine so the recovery
     * path is wired consistently.
     */
    private registerWebGpuLossHandler() {
        if (!this.webGpuEngine) return;
        this.webGpuEngine.onDeviceLost = (info) => { void this.onWebGpuDeviceLost(info); };
    }

    /**
     * Reacts to a runtime WebGPU device loss with a bounded, one-time recovery:
     * attempt to re-create the device on the existing engine once; if that
     * succeeds we stay on the GPU, otherwise (or on any later loss) we fall back
     * to the Barnes-Hut CPU engine for good.
     * @param info - The device-loss details reported by WebGPU.
     */
    private async onWebGpuDeviceLost(info: GPUDeviceLostInfo) {
        if (!this.webGpuAvailable || !this.webGpuEngine) return;
        const reasonStr = info.reason || 'unknown';

        if (this.webGpuRecoveryAttempted) {
            // One-time retry already spent - give up on the GPU.
            this.handleWebGpuFailure(`WebGPU device lost (${reasonStr}) - running CPU Barnes-Hut`);
            return;
        }
        this.webGpuRecoveryAttempted = true;
        console.warn(`WebGPU device lost (${reasonStr}); attempting a one-time GPU re-creation...`);

        try {
            await this.webGpuEngine.init(this.params.count, this.state, this.params.activeCount);
            this.registerWebGpuLossHandler();
            this.webGpuEngine.updateUniforms(this.params.dt, this.params);
            console.log('WebGPU device re-created; continuing on GPU.');
        } catch (err) {
            console.error('WebGPU re-creation failed:', err);
            this.handleWebGpuFailure(`WebGPU device lost (${reasonStr}) and could not be re-created - running CPU Barnes-Hut`);
        }
    }

    /**
     * Initialises/re-initialises galaxy particle data including positions, velocities, and colours.
     */
    initGalaxy() {
        this.memory = new PhysicsMemory(this.params.count);
        this.state = new PhysicsState(this.params.count, this.memory);
        // Tear down any live worker before dropping the reference: the old bridge
        // holds the previous SharedArrayBuffer and can never be reused, so leaving
        // it alive orphans a worker (parked in Atomics.wait) plus its ping timer.
        this.workerBridge?.dispose();
        this.workerBridge = null;

        // The self-gravitating (galaxy) preset pins a fixed, source-only black hole
        // at the origin (index 0); the accretion preset uses a live SMBH particle
        // instead, so its analytic BH term stays off. Set this first: it gates which
        // index range counts as disk sources (see {@link bhStart}/{@link selfGravActiveCount}),
        // which both effectiveSoftening and the self-grav initial conditions read.
        this.params.blackHoleMass = this.params.preset === 'galaxy' ? GALAXY_CENTRAL_BH_MASS : 0;
        if (this.params.preset === 'galaxy') {
            this.params.blackHoleSoftening = SELF_GRAV_BH_SOFTENING;
        }

        // Lock in the mode-appropriate softening *before* computing velocities:
        // the initial conditions (circular speed, epicyclic frequency, and - for
        // the self-gravitating disk - the measured rotation curve) all read
        // params.softening, so they must use the same softening the engine will
        // run with, or the disk starts out of centrifugal balance.
        this.params.softening = this.effectiveSoftening();

        if (this.params.preset === 'galaxy') {
            this.initSelfGravDisk();
        } else {
            this.initAccretionDisk();
        }
    }

    /**
     * Accretion preset: a central SMBH (index 0) surrounded by a thin annulus of
     * Salpeter-sampled test particles. The disk is light, so it behaves as test
     * particles orbiting the SMBH + halo and relaxes into concentric rings.
     */
    private initAccretionDisk() {
        this.diskMass = 0;

        this.state.positionX[0] = 0;
        this.state.positionY[0] = 0;
        this.state.velocityX[0] = 0;
        this.state.velocityY[0] = 0;
        this.state.mass[0] = ACCRETION_BH_MASS;
        // Warm glow for the dominant central SMBH (instead of an invisible black point).
        this.state.colors[0] = 1;
        this.state.colors[1] = 1;
        this.state.colors[2] = 0.85;

        const particles: { x: number; y: number; mass: number; r: number; g: number; b: number; dist: number }[] = [];

        for (let i = 1; i < this.params.count; i++) {
            const angle = this.rng() * Math.PI * 2;
            const dist = DISK_INNER_RADIUS + this.rng() * GALAXY_RADIUS;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist;

            const mass = this.sampleSalpeterMass();
            const [r, g, b] = massToColor(mass);
            particles.push({ x, y, mass, r, g, b, dist });
        }

        particles.sort((a, b) => b.mass - a.mass);

        // Derive a safe dt for the analytic orbital field BEFORE the velocity loop:
        // computeStarVelocity's leapfrog half-step reads params.dt.
        this.params.dt = this.computeAdaptiveTimestep();

        let tempActiveCount = 0;

        for (let i = 1; i < this.params.count; i++) {
            const p = particles[i - 1];

            this.state.positionX[i] = p.x;
            this.state.positionY[i] = p.y;
            this.state.mass[i] = p.mass;

            this.state.colors[i * 3 + 0] = p.r;
            this.state.colors[i * 3 + 1] = p.g;
            this.state.colors[i * 3 + 2] = p.b;

            if (p.mass >= this.params.massThreshold) {
                tempActiveCount++;
            }

            this.computeStarVelocity(i, p.dist);
        }

        // The active set is the index range [0, activeCount). Particle 0 is the
        // central SMBH, so it occupies one slot; add 1 to the count of qualifying
        // heavy stars (indices 1..tempActiveCount) so none are demoted to passive.
        this.params.activeCount = tempActiveCount + 1;
    }

    /**
     * Self-gravitating preset: an exponential disk of macro-particles embedded in
     * the dark-matter halo, with a fixed central black hole pinned at the origin
     * (index 0; see {@link bhStart}). Velocities are set from the *measured* 2-D
     * rotation curve - disk pairwise gravity + halo + BH - so the disk starts in
     * centrifugal balance with the engine's actual forces, and warmed to a target
     * Toomre Q, producing swing-amplified transient spiral arms.
     *
     * The BH (index 0) is an inert, source-only marker: it carries {@link GALAXY_CENTRAL_BH_MASS}
     * purely so the renderers draw the central glow, sits at the origin, and is
     * excluded from every force sum (its pull on the disk comes from the engines'
     * analytic SMBH term, with its own {@link blackHoleSoftening}). The disk occupies
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
    private initSelfGravDisk() {
        const n = this.params.count;
        const start = this.bhStart();
        const nActive = this.selfGravActiveCount();
        // The active set carries the whole disk mass, so each active particle is
        // heavier (Mdisk / nActive). Passive tracers are given the same value for
        // render parity; it never enters the force sums. The disk source range is
        // [start, start + nActive); set activeCount to its end now, before the field
        // helpers below read it - mirrors the accretion preset's "+1" for its index-0 SMBH.
        this.params.activeCount = start + nActive;
        // The split's correctness depends on the engine honouring activeCount:
        // passive tracers carry a (render-only) nonzero mass, so if the engine
        // summed over every particle instead the disk would be n/nActive times too
        // massive. Make the invariant explicit rather than relying on the default.
        this.params.useActivePassive = true;
        const Rd = DISK_SCALE_LENGTH;
        const Rmax = DISK_TRUNCATION * Rd;
        const seedMass = SELF_GRAV_DISK_MASS / nActive;
        this.diskMass = SELF_GRAV_DISK_MASS;

        // Pin the fixed central BH at the origin (inert, source-only marker). Its
        // GALAXY_CENTRAL_BH_MASS drives the renderers' BH glow; it is never summed as
        // a disk source and never integrated (the engines skip index 0 when blackHoleMass > 0).
        if (start === 1) {
            this.state.positionX[0] = 0;
            this.state.positionY[0] = 0;
            this.state.velocityX[0] = 0;
            this.state.velocityY[0] = 0;
            this.state.mass[0] = GALAXY_CENTRAL_BH_MASS;
            this.state.colors[0] = 1;
            this.state.colors[1] = 1;
            this.state.colors[2] = 0.85;
        }

        const radii = new Float64Array(n);
        for (let i = start; i < n; i++) {
            const angle = this.rng() * Math.PI * 2;
            // Sample R from the exponential-disk *radial* distribution
            // dN/dR = 2*pi*R*Sigma(R) ∝ R*exp(-R/Rd): a Gamma(k=2, scale=Rd)
            // deviate (the sum of two exponentials), truncated at Rmax by rejection.
            // The 2*pi*R area Jacobian is essential - sampling exp(-R/Rd) directly
            // realises Sigma ∝ exp(-R/Rd)/R, which is centrally divergent, not the
            // intended exponential disk.
            let R: number;
            do {
                R = -Rd * (Math.log(1 - this.rng()) + Math.log(1 - this.rng()));
            } while (R > Rmax);
            radii[i] = R;

            this.state.positionX[i] = Math.cos(angle) * R;
            this.state.positionY[i] = Math.sin(angle) * R;
            this.state.mass[i] = seedMass;

            // Colour still encodes a sampled stellar (Salpeter) mass for visual
            // consistency with the accretion preset; the physical mass is equal.
            const [r, g, b] = massToColor(this.sampleSalpeterMass());
            this.state.colors[i * 3 + 0] = r;
            this.state.colors[i * 3 + 1] = g;
            this.state.colors[i * 3 + 2] = b;
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
            xMean += this.state.positionX[i];
            yMean += this.state.positionY[i];
        }
        xMean /= nDisk;
        yMean /= nDisk;
        for (let i = start; i < n; i++) {
            this.state.positionX[i] -= xMean;
            this.state.positionY[i] -= yMean;
            // Recompute radii from the recentred positions so radius and direction
            // stay consistent for computeStarVelocity.
            radii[i] = Math.hypot(this.state.positionX[i], this.state.positionY[i]);
        }

        // Tabulate the azimuthally-averaged radial acceleration and surface density
        // from the realized particle distribution, then warm each star to the
        // target Q using those *measured* profiles - so Q is self-consistent with
        // the disk that actually exists, not an assumed analytic Sigma.
        this.buildRotationCurve();

        // Calibrate the total disk mass so the measured disk fraction at 2.2 R_d
        // hits TARGET_F_DISK. The disk's radial force is linear in total mass
        // (positions are mass-independent), while the *external* force (halo + fixed
        // BH) is independent of it; so measure both at the provisional mass M0 and
        // solve the single linear equation f = M*k / (M*k + vExt2) for the target
        // mass, where vExt2 is the squared circular speed from the halo and the BH.
        const Rstar = DISK_FRACTION_RADIUS_FACTOR * DISK_SCALE_LENGTH;
        const M0 = this.diskMass;
        const extAcc = this.haloAcc(Rstar) + this.bhAcc(Rstar);     // halo + fixed BH
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
            for (let i = start; i < n; i++) this.state.mass[i] = m;
            this.diskMass = mTarget;
            // Rebuild the rotation curve: the disk accel now scales to the
            // calibrated mass (the external term is unchanged).
            this.buildRotationCurve();
        }

        this.buildSurfaceDensity();
        // Derive a safe dt from the now-final disk mass and measured rotation
        // curve, BEFORE computeStarVelocity applies its leapfrog half-step (which
        // reads params.dt).
        this.params.dt = this.computeAdaptiveTimestep();
        // Warm every particle - active and passive alike - to the same Q-derived
        // dispersions so the passive cloud shares the active disk's temperature and
        // traces the same spiral structure. (params.activeCount was fixed at the
        // top so the field helpers above already used the active set as sources.)
        // The pinned BH (index 0) is skipped: it keeps zero velocity.
        for (let i = start; i < n; i++) {
            this.computeStarVelocity(i, radii[i]);
        }

        // Stagger the (now synchronized) velocities half a step ahead using each
        // particle's *true* initial acceleration, so the leapfrog offset is exactly
        // consistent with the engine's first force evaluation (the per-star half-kick
        // in computeStarVelocity used only the azimuthally-averaged mean field). Must
        // run after the final dt is set above and after all velocities are assigned.
        this.applySelfGravHalfKick();

        this.removeNetMomentum();
    }

    /**
     * Draws a stellar mass from a Salpeter IMF over [0.1, 50] (exponent 1.35).
     * Used for particle colours in both presets and for the physical (test-
     * particle) masses in the accretion preset.
     */
    private sampleSalpeterMass(): number {
        const mMin = 0.1;
        const mMax = 50.0;
        const p = 1.35;
        const u = this.rng();
        const minP = Math.pow(mMin, -p);
        const maxP = Math.pow(mMax, -p);
        return Math.pow(u * (maxP - minP) + minP, -1 / p);
    }

    /**
     * Subtracts the mass-weighted mean velocity from every disk body so the disk
     * carries zero net linear momentum. Without this, Poisson asymmetry in the
     * disk's random realisation gives the whole galaxy a small bulk drift across
     * the view. Operates over the disk range [bhStart, n) only: the fixed central
     * BH (index 0) stays pinned at zero velocity and must not absorb the drift.
     * Only used by the self-gravitating preset.
     */
    private removeNetMomentum() {
        const n = this.params.count;
        const start = this.bhStart();
        let pxSum = 0, pySum = 0, mSum = 0;
        for (let i = start; i < n; i++) {
            const m = this.state.mass[i];
            pxSum += m * this.state.velocityX[i];
            pySum += m * this.state.velocityY[i];
            mSum += m;
        }
        if (mSum <= 0) return;
        const vxMean = pxSum / mSum;
        const vyMean = pySum / mSum;
        for (let i = start; i < n; i++) {
            this.state.velocityX[i] -= vxMean;
            this.state.velocityY[i] -= vyMean;
        }
    }

    /**
     * Applies the leapfrog half-kick (v += a*dt/2) to the self-gravitating disk
     * using each particle's *true* initial acceleration, mirroring the
     * {@link BruteForceEngine} kernel exactly so the staggered velocities match the
     * integrator's first force evaluation: a_i = sum_j G*m_j*d/(d^2+eps^2)^1.5 plus
     * the origin-pinned dark-matter halo and the fixed central black hole. This is a
     * one-time O(N^2) pass at init (~1e8 ops at N=1e4, same order as
     * buildRotationCurve), acceptable for initial conditions. Must run after the
     * final dt is set and after synchronized velocities are assigned.
     */
    private applySelfGravHalfKick() {
        const n = this.params.count;
        const start = this.bhStart();
        // Force sources are the active set only, exactly as the engine does it: an
        // active particle feels the other active particles, a passive particle
        // feels the active particles, and neither feels the passive set. Restricting
        // the inner loop to the disk active range is both the correct mirror and what
        // turns this one-time pass from O(N^2) into O(N * N_active) so a large passive
        // cloud does not stall init. The pinned BH (index 0) is not a pairwise source
        // - its pull is the analytic bhAcc term below - and is itself skipped.
        const srcEnd = start + this.selfGravActiveCount();
        const px = this.state.positionX;
        const py = this.state.positionY;
        const mass = this.state.mass;
        const G = this.params.gravity;
        const softeningSq = this.params.softening * this.params.softening;
        const halfDt = this.params.dt / 2;

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
                const aExt = this.haloAcc(r) + this.bhAcc(r);
                ax -= (pix / r) * aExt;
                ay -= (piy / r) * aExt;
            }

            this.state.velocityX[i] += ax * halfDt;
            this.state.velocityY[i] += ay * halfDt;
        }
    }

    /**
     * Resets particle velocities to (near-)circular orbits based on current positions.
     * Also re-applies the leapfrog half-step offset (a*dt/2) using the *current* dt,
     * so this MUST be called after any runtime change to params.dt to keep the
     * symplectic integrator's velocity correctly staggered half a step ahead.
     */
    softResetVelocities() {
        if (!this.state) return;
        const selfGrav = this.diskMass > 0;
        // Rebuild the measured rotation curve and surface density from the current
        // positions so the recomputed circular speeds and Q stay consistent with
        // the actual field.
        if (selfGrav) {
            this.buildRotationCurve();
            this.buildSurfaceDensity();
            // Keep dt consistent with the current rotation curve before the
            // recompute loop re-applies the leapfrog half-step (which reads dt).
            this.params.dt = this.computeAdaptiveTimestep();
        }
        // Skip index 0 in both presets: it is the central black hole - a live SMBH
        // for accretion, or the fixed pinned marker for self-grav (bhStart() === 1) -
        // and must keep its own velocity rather than be re-warmed as a disk star.
        const loopStart = selfGrav ? this.bhStart() : 1;
        for (let i = loopStart; i < this.params.count; i++) {
            const distSq = this.state.positionX[i] * this.state.positionX[i] + this.state.positionY[i] * this.state.positionY[i];
            const dist = Math.sqrt(distSq);

            if (dist === 0 && !selfGrav) continue;

            this.computeStarVelocity(i, dist);
        }

        if (this.webGpuEngine && this.engine === this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.webGpuEngine.updateUniforms(this.params.dt, this.params);
        }
    }

    /**
     * Softening to use given the current preset and engine. The accretion preset
     * uses the engine preset's softening; the self-gravitating preset overrides it
     * with ~the disk's local inter-particle spacing so the disk is collisionless
     * rather than exploding (see {@link SELF_GRAV_SOFTENING_FACTOR}). Auto-scales
     * with star count. The base is taken from the engine preset (not the current
     * params.softening) so a stale self-gravitating value can't leak back into the
     * accretion preset when toggling modes on an engine that doesn't reset it.
     *
     * The exponential disk is centrally concentrated, so the *mean*-area spacing
     * would under-soften the dense centre. We instead use the local spacing at the
     * half-mass radius (R_1/2 ~ 1.68 R_d), where most of the mass and the relevant
     * dynamics live: spacing = 1/sqrt(n_surf), n_surf = Sigma(R_1/2) / m_particle.
     */
    /**
     * Number of *active* (field-generating) macro-particles in the
     * self-gravitating disk: the first `selfGravActiveCount` indices, clamped to
     * the particle count (and at least 1). When it equals the count the
     * active/passive split is inert and every particle is active. Derived from the
     * parameter rather than `params.activeCount` so it is correct regardless of
     * call order (e.g. {@link effectiveSoftening} runs before
     * {@link initSelfGravDisk} sets `params.activeCount`). See
     * {@link SELF_GRAV_ACTIVE_COUNT}.
     */
    private selfGravActiveCount(): number {
        // Index 0 is reserved for the pinned BH marker when present, so the disk
        // (and its active source range) starts at bhStart(). Clamp the active count
        // to the slots actually available to the disk.
        const avail = Math.max(this.params.count - this.bhStart(), 1);
        return Math.max(1, Math.min(this.params.selfGravActiveCount, avail));
    }

    /**
     * First particle index that belongs to the disk. The self-gravitating preset
     * reserves index 0 for the fixed central black hole (an inert, source-only
     * marker pinned at the origin), so the disk - and every disk source loop and
     * the engines' pairwise/integration loops - starts at 1 when
     * {@link params.blackHoleMass} is on. The accretion preset leaves the BH term off
     * (its SMBH is the live index-0 particle), so the disk starts at 0.
     */
    private bhStart(): number {
        return this.params.blackHoleMass > 0 ? 1 : 0;
    }

    /**
     * Inward radial acceleration from the fixed central black hole at radius `r`:
     * a_BH = G * M_BH * r / (r^2 + eps_BH^2)^1.5, the magnitude the engines'
     * analytic SMBH term produces (distSq = r^2 + eps_BH^2). Zero when the BH is
     * off (the accretion preset), so it is a no-op there. Folded into the measured
     * rotation curve, the mass calibration, and the leapfrog half-kick so the disk
     * starts in centrifugal balance with the BH the engine actually applies.
     */
    private bhAcc(r: number): number {
        const M = this.params.blackHoleMass;
        if (M <= 0) return 0;
        const epsSq = this.params.blackHoleSoftening * this.params.blackHoleSoftening;
        const d = r * r + epsSq;
        return (this.params.gravity * M * r) / (d * Math.sqrt(d));
    }

    private effectiveSoftening(): number {
        const preset = ENGINE_PRESETS[this.params.engineType as keyof typeof ENGINE_PRESETS];
        const base = preset ? preset.softening : ENGINE_PRESETS.brute.softening;
        if (this.params.preset !== 'galaxy') return base;
        // Collisionality is set by the heavy *active* macro-particles (each carries
        // Mdisk / N_active and sources the field), so the relevant mass and spacing
        // are the active ones, not the full-count ones.
        const nActive = this.selfGravActiveCount();
        const mParticle = SELF_GRAV_DISK_MASS / nActive;
        const rHalf = 1.68 * DISK_SCALE_LENGTH;
        const sigma0 = SELF_GRAV_DISK_MASS / (2 * Math.PI * DISK_SCALE_LENGTH * DISK_SCALE_LENGTH);
        const sigmaHalf = sigma0 * Math.exp(-rHalf / DISK_SCALE_LENGTH);
        const spacing = Math.sqrt(mParticle / Math.max(sigmaHalf, 1e-30));
        return Math.max(base, SELF_GRAV_SOFTENING_FACTOR * spacing);
    }

    /**
     * Timestep to use given the current preset. Both presets *derive* a safe dt
     * so they can never silently under-resolve when the central mass (and hence
     * orbital speeds) is raised: dynamical times shrink as 1/sqrt(mass) while the
     * preset dt stays fixed.
     *
     * The accretion preset (test particles in a static SMBH + halo potential)
     * takes only the orbital-resolution limit, computed analytically from
     * {@link radialAcc} over the disk annulus - no close-encounter term, since the
     * test particles are massless to the field and exert no two-body kicks.
     *
     * The self-gravitating preset derives its dt from the disk that actually
     * exists (measured rotation curve + heavy-macro-particle encounters).
     *
     * dt is the minimum of three limits, floored so a mis-scaling can't stall the
     * sim:
     *   1. the engine preset dt (never run faster, nor slower unless forced);
     *   2. an orbital-resolution limit, one period at the peak angular frequency
     *      Omega_max over the measured rotation-curve grid, divided by
     *      {@link STEPS_PER_ORBIT};
     *   3. a close-encounter limit for the heavy macro-particles,
     *      {@link ENCOUNTER_SAFETY} * sqrt(eps^3 / (G m)), eps the softening.
     * Reads the live {@link diskMass} and {@link rotCurveAcc} (not the disk-mass
     * constant), so it stays correct if the mass is recalibrated and the curve
     * rebuilt before velocities are set. Requires the rotation curve to exist;
     * falls back to the preset dt otherwise. Mirrors {@link effectiveSoftening}.
     */
    computeAdaptiveTimestep(): number {
        const preset = ENGINE_PRESETS[this.params.engineType as keyof typeof ENGINE_PRESETS];
        const presetDt = preset ? preset.timeStep : ENGINE_PRESETS.brute.timeStep;
        if (this.params.preset === 'accretion') {
            // Resolve the fastest orbit about the central SMBH + halo. Sample
            // Omega(r) = vCirc(r)/r analytically over the annulus
            // [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. For a central
            // mass Omega is monotone-decreasing (peak at the inner edge); the grid is
            // just robustness against the halo term. No close-encounter limit: the
            // test particles are massless to the field, so there are no two-body kicks.
            const rMin = DISK_INNER_RADIUS;
            const rMax = DISK_INNER_RADIUS + GALAXY_RADIUS;
            const N = 128;
            let omegaMax = 0;
            for (let k = 0; k < N; k++) {
                const r = rMin + ((rMax - rMin) * k) / (N - 1);
                if (r <= 0) continue;
                const vCirc = Math.sqrt(Math.max(this.radialAcc(r) * r, 0));
                omegaMax = Math.max(omegaMax, vCirc / r);
            }
            let dt = presetDt; // limit 1: never faster than the preset.
            if (omegaMax > 0) dt = Math.min(dt, (2 * Math.PI / omegaMax) / STEPS_PER_ORBIT);
            // Floor so a pathological choice can't crawl the sim to a halt.
            return Math.max(dt, presetDt * MIN_DT_FRACTION);
        }
        if (this.params.preset !== 'galaxy') return presetDt;
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
        const eps = this.effectiveSoftening();
        const mParticle = this.diskMass / this.selfGravActiveCount();
        const G = this.params.gravity;
        if (mParticle > 0 && G > 0) {
            dt = Math.min(dt, ENCOUNTER_SAFETY * Math.sqrt((eps * eps * eps) / (G * mParticle)));
        }

        // Floor so a pathological (mis-scaled) choice can't crawl the sim to a halt.
        return Math.max(dt, presetDt * MIN_DT_FRACTION);
    }

    /**
     * Inward radial acceleration from the dark-matter halo (isothermal-cored)
     * at radius `r`: a_DM = dmStrength^2 * r / (r^2 + r_core^2). Shared by the
     * accretion preset's analytic rotation curve and the self-gravitating preset's
     * measured rotation curve.
     */
    private haloAcc(r: number): number {
        const s = this.params.dmStrength;
        return (s * s * r) / (r * r + this.params.dmCoreRadius * this.params.dmCoreRadius);
    }

    /**
     * Total inward radial acceleration on an accretion-preset test particle at
     * radius `r` from the central SMBH plus the dark-matter halo. (The
     * self-gravitating preset uses a *measured* rotation curve instead; see
     * {@link SimulationManager.buildRotationCurve}.)
     */
    private radialAcc(r: number): number {
        const softenedDistSq = r * r + this.params.softening * this.params.softening;
        const coreAcc = (this.params.gravity * ACCRETION_BH_MASS) / softenedDistSq;
        return coreAcc + this.haloAcc(r);
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
    private buildSurfaceDensity() {
        const Nr = 100;
        // Sum only the disk active set: it carries the full disk mass and sources the
        // field, so its surface density is the one the Toomre-Q warming must use.
        // Passive tracers share the active particles' render mass but must not be
        // double-counted into the field's Sigma; the pinned BH (index 0) carries
        // GALAXY_CENTRAL_BH_MASS and is excluded entirely (not part of the disk's Sigma).
        const start = this.bhStart();
        const srcEnd = start + this.selfGravActiveCount();
        const rMax = DISK_TRUNCATION * DISK_SCALE_LENGTH;
        const dr = rMax / Nr;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const mass = this.state.mass;

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
     * Surface density at radius `r`, linearly interpolated from the measured
     * profile {@link surfDensProfile} (bin centres at (k + 0.5) * dr). Falls back
     * to the smooth analytic exponential before the profile is built and beyond
     * the measured (truncated) range, and floors at a tiny positive value so the
     * asymmetric-drift log-derivative stays finite.
     */
    private diskSurfaceDensity(r: number): number {
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
     * Builds {@link rotCurveAcc}: the azimuthally-averaged inward radial
     * acceleration of the *realized* disk (summed pairwise from every disk source,
     * using the engine's softening) plus the analytic halo and the fixed central
     * black hole, sampled on a uniform radius grid. Setting circular speeds from
     * this - rather than a spherical enclosed-mass monopole, which is wrong for a
     * 2-D 1/r^2 disk - is what makes the disk start in centrifugal balance with the
     * forces the engine computes.
     */
    private buildRotationCurve() {
        const Nr = 128;
        const Naz = 32;
        // Only the disk active set sources the pairwise field (mirrors the engine,
        // which sums over [bhStart, activeCount)); passive tracers carry a render
        // mass but do not gravitate, and the pinned BH (index 0) is excluded here -
        // its contribution is the analytic bhAcc term added below. The active disk
        // particles are an i.i.d. subsample of the same exponential profile, so they
        // reproduce the field shape (with sqrt(N) more shot noise) at the full disk
        // mass they collectively carry.
        const start = this.bhStart();
        const srcEnd = start + this.selfGravActiveCount();
        const G = this.params.gravity;
        const epsSq = this.params.softening * this.params.softening;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const mass = this.state.mass;

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
            acc[k] = aRadSum / Naz + this.haloAcc(rk) + this.bhAcc(rk);
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

    /** Circular speed from the measured rotation curve. */
    private vCircAt(r: number): number {
        return Math.sqrt(Math.max(this.aRadInterp(r) * r, 0));
    }

    /**
     * Disk fraction f_disk = v_disk^2 / v_c^2 at radius `r` from the current
     * rotation curve, i.e. the share of the circular speed provided by the disk's
     * own gravity. Both the dark-matter halo and the fixed central black hole are
     * *external* fields (independent of the disk mass), so both are subtracted -
     * matching the mass calibration in {@link initSelfGravDisk}, which targets
     * exactly this ratio. Exposed for verification/telemetry without reaching into
     * private fields.
     */
    diskFractionAt(r: number): number {
        const total = this.aRadInterp(r) * r;
        const disk = (this.aRadInterp(r) - this.haloAcc(r) - this.bhAcc(r)) * r;
        return disk / Math.max(total, 1e-30);
    }

    /**
     * Epicyclic frequency kappa = sqrt(2 (v/R)(v/R + dv/dR)) from the measured
     * rotation curve via central finite difference.
     */
    private kappaAt(r: number): number {
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
    private sigmaRAt(r: number): number {
        const Sigma = this.diskSurfaceDensity(r); // already floored > 0
        const kappa = this.kappaAt(r);
        const eps = this.params.softening;
        const kCrit = (kappa * kappa) / (2 * Math.PI * this.params.gravity * Sigma);
        const soften = Math.exp(-kCrit * eps);
        return (TOOMRE_Q * 3.36 * this.params.gravity * Sigma * soften) / kappa;
    }

    /**
     * Sets the staggered (leapfrog half-step) velocity for star `i` at radius
     * `dist`. In the accretion preset this is a near-circular orbit with a little
     * scatter. In the self-gravitating preset the orbit uses the measured circular
     * speed, is warmed with radial + tangential dispersions for a target Toomre Q,
     * and has its mean azimuthal speed lowered by the asymmetric drift so the warm
     * disk stays in radial equilibrium.
     */
    private computeStarVelocity(i: number, dist: number) {
        const px = this.state.positionX[i];
        const py = this.state.positionY[i];
        const r = Math.max(dist, 1e-3);

        // Radial (outward) and tangential (counter-clockwise) unit vectors.
        const ux = px / r;
        const uy = py / r;
        const tx = -uy;
        const ty = ux;

        let vx: number;
        let vy: number;

        if (this.diskMass > 0) {
            // --- Self-gravitating disk: measured rotation curve + Toomre-Q warming ---
            const vCirc = this.vCircAt(r);
            const omega = vCirc / r;
            const kappa = this.kappaAt(r);

            const sigmaR = this.sigmaRAt(r);
            const sigmaPhi = sigmaR * (kappa / (2 * omega));

            // Asymmetric drift (Binney & Tremaine 2008, eq. 4.228, approx):
            // v_c - v_phi ~ sigma_R^2 / (2 v_c) * [sigma_phi^2/sigma_R^2 - 1 -
            //   d ln(Sigma sigma_R^2)/d ln R]. Lowers the mean azimuthal speed so
            // the pressure-supported disk is not over-supported and flung outward.
            let vBarPhi = vCirc;
            if (vCirc > 1e-6) {
                const dr = Math.max(r * 0.01, 1e-3);
                const rMinus = Math.max(r - dr, 1e-3);
                const fPlus = this.diskSurfaceDensity(r + dr) * this.sigmaRAt(r + dr) ** 2;
                const fMinus = this.diskSurfaceDensity(rMinus) * this.sigmaRAt(rMinus) ** 2;
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
            const dvR = this.gaussianRandom() * Math.min(sigmaR, vCirc);
            const dvPhi = this.gaussianRandom() * Math.min(sigmaPhi, vCirc);

            vx = tx * vBarPhi + ux * dvR + tx * dvPhi;
            vy = ty * vBarPhi + uy * dvR + ty * dvPhi;

            // Assign the *synchronized* velocity only. The leapfrog half-step
            // offset is applied later in initSelfGravDisk by applySelfGravHalfKick,
            // which uses each particle's true (Poisson) acceleration rather than the
            // azimuthally-averaged mean field, so the stagger matches the engine.
            this.state.velocityX[i] = vx;
            this.state.velocityY[i] = vy;
        } else {
            // --- Accretion (central-mass-dominated): near-circular with mild scatter ---
            const aTot = this.radialAcc(r);
            const vCirc = Math.sqrt(Math.max(aTot * r, 0));
            const velocity = vCirc * (0.9 + this.rng() * 0.2);
            vx = tx * velocity;
            vy = ty * velocity;

            // Leapfrog half-step offset using the (inward) radial acceleration, so
            // velocity stays staggered half a step ahead of position. The analytic
            // radialAcc already is this test particle's true force, so no O(N^2)
            // pass is needed.
            const ax = -ux * aTot;
            const ay = -uy * aTot;
            this.state.velocityX[i] = vx + ax * (this.params.dt / 2);
            this.state.velocityY[i] = vy + ay * (this.params.dt / 2);
        }
    }

    /**
     * Standard normal random sample (mean 0, variance 1) via Box-Muller.
     */
    private gaussianRandom(): number {
        let u = 0;
        let v = 0;
        while (u === 0) u = this.rng();
        while (v === 0) v = this.rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /**
     * Switches the active physics engine to the requested type.
     * @param type - The target engine's string identifier.
     */
    async switchEngine(type: string) {
        const quadTreeGroup = document.getElementById('ui-quadtree-group');
        if (quadTreeGroup) {
            quadTreeGroup.style.display = type === 'barnes' ? 'flex' : 'none';
        }

        const preset = ENGINE_PRESETS[type as keyof typeof ENGINE_PRESETS];
        if (preset) {
            this.params.theta = preset.theta;
            this.params.softening = preset.softening;
            this.params.dt = preset.timeStep;
        }
        // The preset resets softening to the accretion-preset value; restore the
        // larger self-gravitating softening (no-op for the accretion preset) before
        // softResetVelocities recomputes the IC, which reads params.softening.
        this.params.softening = this.effectiveSoftening();
        // Same for dt: restore the disk's derived dt so the preset switch doesn't
        // leave a stale preset dt (no-op for the accretion preset; softResetVelocities
        // re-derives it again for galaxy, but this keeps the two in lockstep).
        this.params.dt = this.computeAdaptiveTimestep();

        this.softResetVelocities();

        if (this.workerBridge && type !== 'worker') {
            this.workerBridge.dispose();
            this.workerBridge = null;
        }

        if (this.webGpuEngine) {
            this.webGpuEngine.setVisible(false);
        }
        if (this.renderer && this.renderer.canvas) {
            this.renderer.canvas.style.display = 'block';
        }

        if (type === 'brute') {
            this.engine = new BruteForceEngine(this.state);
        } else if (type === 'barnes') {
            this.engine = new BarnesHutEngine(this.state);
        } else if (type === 'webgpu') {
            if (!this.webGpuAvailable) {
                // WebGPU was already ruled out; do not retry. Stay on CPU.
                this.params.engineType = 'barnes';
                this.engine = new BarnesHutEngine(this.state);
                this.onEngineFallback('WebGPU unavailable - running CPU Barnes-Hut');
                return;
            }

            console.log("Switching to WebGPU...");

            try {
                if (!this.webGpuEngine) {
                    this.webGpuEngine = new WebGPUEngine();
                    await this.webGpuEngine.init(this.params.count, this.state, this.params.activeCount);
                    this.registerWebGpuLossHandler();
                } else {
                    this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
                }
            } catch (err) {
                this.markWebGpuUnavailable(err);
                this.params.engineType = 'barnes';
                this.engine = new BarnesHutEngine(this.state);
                this.onEngineFallback('WebGPU failed to initialise - running CPU Barnes-Hut');
                return;
            }

            this.webGpuEngine.setVisible(true);

            if (this.renderer && this.renderer.canvas) {
                this.renderer.canvas.style.display = 'none';
            }

            this.engine = this.webGpuEngine;
        } else if (type === 'worker') {
            if (!this.workerBridge) {
                this.workerBridge = new WorkerBridge(this.memory);
            }
            this.engine = this.workerBridge;
        } else {
            this.engine = new BarnesHutEngine(this.state);
        }
    }

    /**
     * Starts the main simulation update and rendering loop.
     */
    startLoop() {
        this.lastTelemetryUpdate = performance.now();
        this.lastFrameTime = 0;
        this.accumulator = 0;
        this.loop();
    }

    /**
     * Completely restarts the simulation, re-initialising the galaxy and active engine.
     */
    async restart() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = 0;
        }

        this.initGalaxy();

        if (this.params.engineType === 'webgpu' && this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.engine = this.webGpuEngine;
        } else {
            await this.switchEngine(this.params.engineType);
        }

        if (this.renderer) {
            this.renderer.state = this.state;
        }

        this.lastFrameTime = 0;
        this.accumulator = 0;
        // Guard against double-pumping: if a rAF was queued during the awaits
        // above (loop() only assigns animationFrameId at its tail), don't start a
        // second independent loop chain.
        if (!this.animationFrameId) this.loop();
    }

    /**
     * The primary recursive animation step driving physics iterations and screen painted representations.
     * Also calculates standard telemetry data like frame rates.
     */
    loop = () => {
        // --- Frame timing: accumulate real elapsed time for fixed-timestep stepping ---
        const now = performance.now();
        if (this.lastFrameTime === 0) this.lastFrameTime = now;
        let frameSeconds = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;
        // Clamp to avoid a "spiral of death" after a tab stall, breakpoint, or alt-tab.
        if (frameSeconds > 0.1) frameSeconds = 0.1;

        this.renderer.camera.update();

        const bgCanvas = document.getElementById('bg-canvas');
        if (bgCanvas) {
            const pPanFactor = 0.05;
            const pZoomFactor = 0.15;
            let bgScale = 1.0 + (this.renderer.camera.zoom - 1.0) * pZoomFactor;
            if (bgScale < 0.83) bgScale = 0.83;

            const bgX = this.renderer.camera.x * pPanFactor;
            const bgY = (this.renderer.camera.y * this.renderer.camera.tilt) * pPanFactor;
            bgCanvas.style.transform = `translate(${bgX}px, ${bgY}px) scale(${bgScale})`;
        }

        this.renderer.massThreshold = this.params.massThreshold;
        this.renderer.showQuadTree = this.params.shouldShowQuadTree;

        // --- Physics: advance in fixed dt increments proportional to real time ---
        // This keeps the simulation evolving at the same wall-clock rate regardless
        // of the display refresh rate, while preserving the integrator's fixed dt.
        if (!this.params.isPaused) {
            this.accumulator += frameSeconds;
            const dt = this.params.dt;
            let steps = 0;
            while (this.accumulator >= dt && steps < SimulationManager.MAX_SUBSTEPS) {
                this.engine.step(dt, this.params);
                this.accumulator -= dt;
                steps++;
            }
            // If we hit the cap and are still behind, drop the backlog rather than spiral.
            if (steps === SimulationManager.MAX_SUBSTEPS) this.accumulator = 0;
        }

        // --- Presentation: the one discriminant branch ---
        if (this.engine.kind === 'self-rendering') {
            // Keep GPU camera uniforms in sync (needed while paused too).
            this.params.cameraZoom = this.renderer.camera.zoom;
            this.params.cameraX = this.renderer.camera.x;
            this.params.cameraY = this.renderer.camera.y;
            this.params.cameraTilt = this.renderer.camera.tilt;
            this.engine.render(this.params);
        } else {
            if (this.params.engineType === 'barnes') {
                this.renderer.quadTree = (this.engine as BarnesHutEngine).root || null;
            } else {
                this.renderer.quadTree = null;
            }
            this.renderer.render();
        }

        this.frames++;

        if (now - this.lastTelemetryUpdate >= 250) {
            const fps = this.frames / ((now - this.lastTelemetryUpdate) / 1000);
            this.onTelemetry(fps, this);
            this.frames = 0;
            this.lastTelemetryUpdate = now;
        }

        this.animationFrameId = requestAnimationFrame(this.loop);
    }
}
