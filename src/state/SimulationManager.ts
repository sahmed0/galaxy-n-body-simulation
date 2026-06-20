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
import type { PhysicsEngine } from '../physics';
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
 * Base radius for galaxy particle distribution generation. Used by the "core"
 * preset, which seeds the disk in the annulus
 * [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. The self-gravitating
 * preset instead uses an exponential profile (see {@link DISK_SCALE_LENGTH}).
 */
export const GALAXY_RADIUS = 500;

/**
 * Inner radius of the "core"-preset annulus (see {@link GALAXY_RADIUS}).
 */
export const DISK_INNER_RADIUS = 0;

/**
 * Mass of the central core object (SMBH) in the "core" galaxy preset. The
 * self-gravitating preset has no central point mass: its rotation is set by the
 * disk's own gravity plus the dark-matter halo.
 */
export const CORE_MASS = 1;

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
 * Total disk mass used by the self-gravitating galaxy preset. Chosen (in
 * arbitrary code units) so the disk's collective self-gravity dominates where
 * spiral arms form while the dark-matter halo flattens the outer rotation curve.
 * Normalised to a fixed total (independent of particle count) so the dynamics -
 * and the Toomre Q below - stay consistent at any star count. Unused by the
 * "core" preset, where the disk is just the raw Salpeter masses (test particles).
 */
export const SELF_GRAV_DISK_MASS = 13953;

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
 * softening = 1.0, which is correct for the central-mass-dominated "core" preset
 * but far smaller than the disk's particle spacing. With self-gravity ON that
 * makes the disk collisional: close encounters between the massive macro-particles
 * deliver huge velocity kicks that fling stars out within a crossing time.
 * Softening on the order of the spacing makes the disk behave as the smooth,
 * collisionless system the model assumes.
 */
export const SELF_GRAV_SOFTENING_FACTOR = 0.9;

/**
 * Manages the state, memory, and lifecycle of the N-Body physics simulation.
 */
export class SimulationManager {
    memory!: PhysicsMemory;
    state!: PhysicsState;
    engine!: PhysicsEngine;
    webGpuEngine: WebGPUEngine | null = null;
    activeEngineStr: 'cpu' | 'gpu' = 'cpu';
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
        // Galaxy initial-conditions preset:
        //   'core'     - SMBH/halo-dominated; disk is light (test-particle) -> rings
        //   'selfgrav' - massive self-gravitating disk tuned to Toomre Q -> spiral arms
        galaxyMode: 'core' as 'core' | 'selfgrav',
        gravity: 1,
        dt: 0.016,
        softening: 1.0,
        count: 10000,
        useActivePassive: true,
        activeCount: 0,
        theta: 1.0,
        massThreshold: 1.0,
        isPaused: false,
        cameraZoom: 1.0,
        cameraX: 0.0,
        cameraY: 0.0,
        cameraTilt: 0.6,
        dmStrength: 400.0,
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
                this.activeEngineStr = 'gpu';
                this.engine = this.webGpuEngine;
                this.webGpuEngine.setVisible(true);
                this.renderer.canvas.style.display = 'none';

                const preset = ENGINE_PRESETS['webgpu'];
                if (preset) {
                    this.params.theta = preset.theta;
                    this.params.softening = preset.softening;
                    this.params.dt = preset.timeStep;
                }
                // The preset resets softening to the core-preset value; restore
                // the larger self-gravitating softening so the disk stays stable.
                this.params.softening = this.effectiveSoftening();
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

        // Lock in the mode-appropriate softening *before* computing velocities:
        // the initial conditions (circular speed, epicyclic frequency, and - for
        // the self-gravitating disk - the measured rotation curve) all read
        // params.softening, so they must use the same softening the engine will
        // run with, or the disk starts out of centrifugal balance.
        this.params.softening = this.effectiveSoftening();

        if (this.params.galaxyMode === 'selfgrav') {
            this.initSelfGravDisk();
        } else {
            this.initCoreGalaxy();
        }
    }

    /**
     * "Core" preset: a central SMBH (index 0) surrounded by a thin annulus of
     * Salpeter-sampled test particles. The disk is light, so it behaves as test
     * particles orbiting the SMBH + halo and relaxes into concentric rings.
     */
    private initCoreGalaxy() {
        this.diskMass = 0;

        this.state.positionX[0] = 0;
        this.state.positionY[0] = 0;
        this.state.velocityX[0] = 0;
        this.state.velocityY[0] = 0;
        this.state.mass[0] = CORE_MASS;
        this.state.colors[0] = 0;
        this.state.colors[1] = 0;
        this.state.colors[2] = 0;

        const particles: { x: number; y: number; mass: number; r: number; g: number; b: number; dist: number }[] = [];

        for (let i = 1; i < this.params.count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = DISK_INNER_RADIUS + Math.random() * GALAXY_RADIUS;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist;

            const mass = this.sampleSalpeterMass();
            const [r, g, b] = massToColor(mass);
            particles.push({ x, y, mass, r, g, b, dist });
        }

        particles.sort((a, b) => b.mass - a.mass);

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
        // central core, so it occupies one slot; add 1 to the count of qualifying
        // heavy stars (indices 1..tempActiveCount) so none are demoted to passive.
        this.params.activeCount = tempActiveCount + 1;
    }

    /**
     * Self-gravitating preset: an exponential disk of equal-mass macro-particles
     * embedded in the dark-matter halo, with no central point mass. Velocities
     * are set from the *measured* 2-D rotation curve (so the disk starts in
     * centrifugal balance with the engine's actual forces) and warmed to a target
     * Toomre Q, producing swing-amplified transient spiral arms.
     */
    private initSelfGravDisk() {
        const n = this.params.count;
        const Rd = DISK_SCALE_LENGTH;
        const Rmax = DISK_TRUNCATION * Rd;
        // Normalisation of the truncated exponential CDF on [0, Rmax].
        const cdfMax = 1 - Math.exp(-Rmax / Rd);
        const equalMass = SELF_GRAV_DISK_MASS / n;
        this.diskMass = SELF_GRAV_DISK_MASS;

        const radii = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const angle = Math.random() * Math.PI * 2;
            // Inverse-CDF sample of the truncated exponential surface density.
            const R = -Rd * Math.log(1 - Math.random() * cdfMax);
            radii[i] = R;

            this.state.positionX[i] = Math.cos(angle) * R;
            this.state.positionY[i] = Math.sin(angle) * R;
            this.state.mass[i] = equalMass;

            // Colour still encodes a sampled stellar (Salpeter) mass for visual
            // consistency with the core preset; the physical mass is equal.
            const [r, g, b] = massToColor(this.sampleSalpeterMass());
            this.state.colors[i * 3 + 0] = r;
            this.state.colors[i * 3 + 1] = g;
            this.state.colors[i * 3 + 2] = b;
        }

        // Tabulate the azimuthally-averaged radial acceleration from the realized
        // particle distribution + halo, then warm each star to the target Q.
        this.buildRotationCurve();
        for (let i = 0; i < n; i++) {
            this.computeStarVelocity(i, radii[i]);
        }

        // Every macro-particle is equal mass and self-gravitating.
        this.params.activeCount = n;
        this.removeNetMomentum();
    }

    /**
     * Draws a stellar mass from a Salpeter IMF over [0.1, 50] (exponent 1.35).
     * Used for particle colours in both presets and for the physical (test-
     * particle) masses in the "core" preset.
     */
    private sampleSalpeterMass(): number {
        const mMin = 0.1;
        const mMax = 50.0;
        const p = 1.35;
        const u = Math.random();
        const minP = Math.pow(mMin, -p);
        const maxP = Math.pow(mMax, -p);
        return Math.pow(u * (maxP - minP) + minP, -1 / p);
    }

    /**
     * Subtracts the mass-weighted mean velocity from every body so the system
     * carries zero net linear momentum. Without this, Poisson asymmetry in the
     * disk's random realisation gives the whole galaxy (SMBH included) a small
     * bulk drift across the view. Only used by the self-gravitating preset.
     */
    private removeNetMomentum() {
        const n = this.params.count;
        let pxSum = 0, pySum = 0, mSum = 0;
        for (let i = 0; i < n; i++) {
            const m = this.state.mass[i];
            pxSum += m * this.state.velocityX[i];
            pySum += m * this.state.velocityY[i];
            mSum += m;
        }
        if (mSum <= 0) return;
        const vxMean = pxSum / mSum;
        const vyMean = pySum / mSum;
        for (let i = 0; i < n; i++) {
            this.state.velocityX[i] -= vxMean;
            this.state.velocityY[i] -= vyMean;
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
        // Rebuild the measured rotation curve from the current positions so the
        // recomputed circular speeds stay consistent with the actual field.
        if (selfGrav) this.buildRotationCurve();
        // The self-gravitating disk has no central point mass, so index 0 is a
        // real disk particle and must be (re)warmed too; the "core" preset keeps
        // its stationary SMBH at index 0.
        for (let i = selfGrav ? 0 : 1; i < this.params.count; i++) {
            const distSq = this.state.positionX[i] * this.state.positionX[i] + this.state.positionY[i] * this.state.positionY[i];
            const dist = Math.sqrt(distSq);

            if (dist === 0 && !selfGrav) continue;

            this.computeStarVelocity(i, dist);
        }

        if (this.activeEngineStr === 'gpu' && this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.webGpuEngine.updateUniforms(this.params.dt, this.params);
        }
    }

    /**
     * Softening to use given the current galaxy mode and engine. The "core" preset
     * uses the engine preset's softening; the self-gravitating preset overrides it
     * with ~the disk's local inter-particle spacing so the disk is collisionless
     * rather than exploding (see {@link SELF_GRAV_SOFTENING_FACTOR}). Auto-scales
     * with star count. The base is taken from the engine preset (not the current
     * params.softening) so a stale self-gravitating value can't leak back into the
     * "core" preset when toggling modes on an engine that doesn't reset it.
     *
     * The exponential disk is centrally concentrated, so the *mean*-area spacing
     * would under-soften the dense centre. We instead use the local spacing at the
     * half-mass radius (R_1/2 ~ 1.68 R_d), where most of the mass and the relevant
     * dynamics live: spacing = 1/sqrt(n_surf), n_surf = Sigma(R_1/2) / m_particle.
     */
    private effectiveSoftening(): number {
        const preset = ENGINE_PRESETS[this.params.engineType as keyof typeof ENGINE_PRESETS];
        const base = preset ? preset.softening : ENGINE_PRESETS.brute.softening;
        if (this.params.galaxyMode !== 'selfgrav') return base;
        const n = Math.max(this.params.count, 1);
        const mParticle = SELF_GRAV_DISK_MASS / n;
        const rHalf = 1.68 * DISK_SCALE_LENGTH;
        const sigma0 = SELF_GRAV_DISK_MASS / (2 * Math.PI * DISK_SCALE_LENGTH * DISK_SCALE_LENGTH);
        const sigmaHalf = sigma0 * Math.exp(-rHalf / DISK_SCALE_LENGTH);
        const spacing = Math.sqrt(mParticle / Math.max(sigmaHalf, 1e-30));
        return Math.max(base, SELF_GRAV_SOFTENING_FACTOR * spacing);
    }

    /**
     * Inward radial acceleration from the dark-matter halo (isothermal-cored)
     * at radius `r`: a_DM = dmStrength^2 * r / (r^2 + r_core^2). Shared by the
     * "core" preset's analytic rotation curve and the self-gravitating preset's
     * measured rotation curve.
     */
    private haloAcc(r: number): number {
        const s = this.params.dmStrength;
        return (s * s * r) / (r * r + this.params.dmCoreRadius * this.params.dmCoreRadius);
    }

    /**
     * Total inward radial acceleration on a "core"-preset test particle at radius
     * `r` from the central SMBH plus the dark-matter halo. (The self-gravitating
     * preset uses a *measured* rotation curve instead; see
     * {@link SimulationManager.buildRotationCurve}.)
     */
    private radialAcc(r: number): number {
        const softenedDistSq = r * r + this.params.softening * this.params.softening;
        const coreAcc = (this.params.gravity * CORE_MASS) / softenedDistSq;
        return coreAcc + this.haloAcc(r);
    }

    /**
     * Exponential surface density of the self-gravitating disk at radius `r`:
     * Sigma(R) = Sigma0 * exp(-R/R_d), Sigma0 = Mdisk / (2*pi*R_d^2).
     */
    private diskSurfaceDensity(r: number): number {
        const Rd = DISK_SCALE_LENGTH;
        const sigma0 = this.diskMass / (2 * Math.PI * Rd * Rd);
        return sigma0 * Math.exp(-r / Rd);
    }

    /**
     * Builds {@link rotCurveAcc}: the azimuthally-averaged inward radial
     * acceleration of the *realized* disk (summed pairwise from every particle,
     * using the engine's softening) plus the analytic halo, sampled on a uniform
     * radius grid. Setting circular speeds from this - rather than a spherical
     * enclosed-mass monopole, which is wrong for a 2-D 1/r^2 disk - is what makes
     * the disk start in centrifugal balance with the forces the engine computes.
     */
    private buildRotationCurve() {
        const Nr = 128;
        const Naz = 8;
        const n = this.params.count;
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
                for (let j = 0; j < n; j++) {
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
            acc[k] = aRadSum / Naz + this.haloAcc(rk);
        }

        this.rotCurveAcc = acc;
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
     * Epicyclic frequency kappa = sqrt(2 (v/R)(v/R + dv/dR)) from the measured
     * rotation curve via central finite difference.
     */
    private kappaAt(r: number): number {
        const dr = Math.max(r * 0.01, 1e-3);
        const rMinus = Math.max(r - dr, 1e-6);
        const vP = this.vCircAt(r + dr);
        const vM = this.vCircAt(rMinus);
        const dvdr = (vP - vM) / (r + dr - rMinus);
        const omega = this.vCircAt(r) / Math.max(r, 1e-6);
        return Math.sqrt(Math.max(2 * omega * (omega + dvdr), 1e-6));
    }

    /**
     * Radial velocity dispersion for the target Toomre Q at radius `r`:
     * Q = sigma_R * kappa / (3.36 * G * Sigma) => sigma_R = Q * 3.36 * G * Sigma / kappa.
     */
    private sigmaRAt(r: number): number {
        return (TOOMRE_Q * 3.36 * this.params.gravity * this.diskSurfaceDensity(r)) / this.kappaAt(r);
    }

    /**
     * Sets the staggered (leapfrog half-step) velocity for star `i` at radius
     * `dist`. In the "core" preset this is a near-circular orbit with a little
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

        let aTot: number;
        let vx: number;
        let vy: number;

        if (this.diskMass > 0) {
            // --- Self-gravitating disk: measured rotation curve + Toomre-Q warming ---
            aTot = this.aRadInterp(r);
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
        } else {
            // --- Core-dominated: near-circular with mild scatter ---
            aTot = this.radialAcc(r);
            const vCirc = Math.sqrt(Math.max(aTot * r, 0));
            const velocity = vCirc * (0.9 + Math.random() * 0.2);
            vx = tx * velocity;
            vy = ty * velocity;
        }

        // Leapfrog half-step offset using the (inward) radial acceleration, so
        // velocity stays staggered half a step ahead of position.
        const ax = -ux * aTot;
        const ay = -uy * aTot;
        this.state.velocityX[i] = vx + ax * (this.params.dt / 2);
        this.state.velocityY[i] = vy + ay * (this.params.dt / 2);
    }

    /**
     * Standard normal random sample (mean 0, variance 1) via Box-Muller.
     */
    private gaussianRandom(): number {
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
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
        // The preset resets softening to the core-preset value; restore the
        // larger self-gravitating softening (no-op for the "core" preset) before
        // softResetVelocities recomputes the IC, which reads params.softening.
        this.params.softening = this.effectiveSoftening();

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

        this.activeEngineStr = 'cpu';

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

            this.activeEngineStr = 'gpu';
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
            (this.renderer as any).state = this.state;
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

        const isGpu = this.activeEngineStr === 'gpu' && !!this.webGpuEngine;

        this.renderer.massThreshold = this.params.massThreshold;
        this.renderer.showQuadTree = this.params.shouldShowQuadTree;

        // Keep GPU camera uniforms in sync every frame (needed while paused too).
        if (isGpu) {
            this.params.cameraZoom = this.renderer.camera.zoom;
            this.params.cameraX = this.renderer.camera.x;
            this.params.cameraY = this.renderer.camera.y;
            this.params.cameraTilt = this.renderer.camera.tilt;
        }

        // --- Physics: advance in fixed dt increments proportional to real time ---
        // This keeps the simulation evolving at the same wall-clock rate regardless
        // of the display refresh rate, while preserving the integrator's fixed dt.
        if (!this.params.isPaused) {
            this.accumulator += frameSeconds;
            const dt = this.params.dt;
            let steps = 0;
            while (this.accumulator >= dt && steps < SimulationManager.MAX_SUBSTEPS) {
                if (isGpu) {
                    this.webGpuEngine!.step(dt, this.params);
                } else {
                    this.engine.update(dt, this.params);
                }
                this.accumulator -= dt;
                steps++;
            }
            // If we hit the cap and are still behind, drop the backlog rather than spiral.
            if (steps === SimulationManager.MAX_SUBSTEPS) this.accumulator = 0;
        }

        // --- Render exactly once per displayed frame ---
        if (isGpu) {
            this.webGpuEngine!.render(this.params);
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
