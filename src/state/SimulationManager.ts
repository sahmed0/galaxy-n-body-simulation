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
    DEFAULT_RENDER_PARAMS,
} from '../physics';
import type { AnyEngine, EngineType, RenderParams } from '../physics';
import { EnergyMonitor } from '../physics/energy';
import { CanvasRenderer } from '../rendering';
import { massToColor, mulberry32, randomUint32 } from '../utils';
import { ENGINE_PRESETS, presetFor } from './enginePresets';
import type { SimulationParams } from './params';
import {
    DISK_INNER_RADIUS,
    GALAXY_RADIUS,
    MIN_DT_FRACTION,
    STEPS_PER_ORBIT,
    haloAcc,
    presetDmDefault,
    sampleSalpeterMass,
    type IcContext,
} from './ic/common';
import { GalaxyDisk, SELF_GRAV_ACTIVE_COUNT, SELF_GRAV_BH_SOFTENING } from './ic/GalaxyDisk';

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

    /**
     * Called once per render loop iteration, after the camera updates. Lets the entry
     * layer drive DOM-facing effects (e.g. the parallax background) without the state
     * layer touching the DOM itself.
     */
    onFrame: ((sim: SimulationManager) => void) | null = null;

    animationFrameId: number = 0;
    frames = 0;
    lastTelemetryUpdate = 0;

    /** Initial conditions of the current realization: a GalaxyDisk, or null on the accretion preset. */
    ic: GalaxyDisk | null = null;

    /** The galaxy initial conditions; throws on the accretion preset. */
    get galaxyDisk(): GalaxyDisk {
        if (!this.ic) throw new Error('galaxyDisk: preset is not galaxy');
        return this.ic;
    }

    /**
     * Effective total disk mass of the current initialisation. Non-zero only in
     * the self-gravitating preset; used to add the disk's own contribution to
     * the circular velocity and to compute the Toomre-Q velocity dispersion.
     */
    get diskMass(): number {
        return this.ic?.diskMass ?? 0;
    }

    /**
     * Source of randomness for all initial-condition sampling (Salpeter masses,
     * disk positions/velocities). Re-derived from {@link currentSeed} by every
     * {@link initGalaxy}, so one seed means one realization.
     */
    private rng: () => number = mulberry32(0);

    /**
     * Seed of the realization currently loaded. Defaults to 0 rather than a random draw
     * so a bare manager - i.e. every unit test - is reproducible without ceremony; the
     * entry layer draws the real default for the app.
     */
    public currentSeed = 0;

    // Fixed-timestep accumulator: decouples simulation speed from display refresh
    // rate so the physics advances at the same wall-clock rate on 60/120/144 Hz.
    private lastFrameTime = 0;
    private accumulator = 0;
    private static readonly MAX_SUBSTEPS = 5;

    // Completed-step count last observed from the worker. Simulated time is debited
    // only by the growth of this value, so steps the worker drops while busy never
    // advance the clock. Reset to 0 whenever a fresh WorkerBridge is created.
    private workerStepsSeen = 0;

    // Physics steps completed within the current telemetry window; flushed to
    // stepsPerSecond every ~250 ms. Distinct from `frames` (which counts renders).
    private stepsThisWindow = 0;
    /** Physics steps per second over the last telemetry window (read by the UI). */
    stepsPerSecond = 0;

    /**
     * Exact active-subsystem energy/momentum diagnostics, serviced by {@link serviceEnergy}
     * on a decimated schedule. Read by the UI's energy panel.
     */
    readonly energyMonitor = new EnergyMonitor();
    /**
     * Whether to spend cycles measuring energy. Owned by the energy panel's visibility:
     * a closed panel costs nothing.
     */
    energyEnabled = false;
    /**
     * Accumulated simulated seconds: `dt` × every step actually executed, worker steps
     * included. Stamped onto each energy sample. Reset with the initial conditions.
     */
    simTimeSeconds = 0;
    /** Wall-clock ms at which the last energy cycle *completed*; gates the next one. */
    private lastEnergyCycleEndMs = 0;
    /** Minimum wall-clock gap between the end of one energy cycle and the start of the next. */
    private static readonly ENERGY_CYCLE_INTERVAL_MS = 1000;

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
    params: SimulationParams = {
        engineType: 'webgpu',
        preset: 'galaxy',
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
        // Tied to the default preset (galaxy) via presetDmDefault so the two
        // can't drift apart. The UI resets this to presetDmDefault(preset) on switch.
        dmStrength: presetDmDefault('galaxy'),
        dmCoreRadius: 1200.0,
        shouldShowQuadTree: false,
    };

    /** Camera transform handed to a self-rendering engine, synced from the canvas camera each frame. */
    readonly renderParams: RenderParams = { ...DEFAULT_RENDER_PARAMS };

    /** The mutable surface the initial-conditions object writes into, built fresh per call. */
    private icContext(): IcContext {
        return { state: this.state, params: this.params, rng: this.rng };
    }

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
            this.webGpuEngine.updateUniforms(this.params.dt, this.params, this.renderParams);
            console.info('WebGPU device re-created; continuing on GPU.');
        } catch (err) {
            console.error('WebGPU re-creation failed:', err);
            this.handleWebGpuFailure(`WebGPU device lost (${reasonStr}) and could not be re-created - running CPU Barnes-Hut`);
        }
    }

    /**
     * Pins the realization for the next (re)initialisation, re-deriving the generator now
     * so a caller that samples before {@link initGalaxy} sees the stream it will get.
     *
     * The guarantee covers *initial conditions* only. Later actions draw from the same
     * stream and advance it - notably {@link switchEngine}, whose
     * {@link softResetVelocities} resamples Toomre kicks and velocity scatter - so a seed
     * reproduces t=0, not a mid-run state.
     *
     * @param seed - Stream selector, coerced to uint32.
     */
    setSeed(seed: number): void {
        this.currentSeed = seed >>> 0;
        this.rng = mulberry32(this.currentSeed);
    }

    /**
     * Initialises/re-initialises galaxy particle data including positions, velocities, and colours.
     */
    initGalaxy() {
        // Re-derive before any sampling: a restart must reproduce its seed's realization
        // exactly even though softResetVelocities and engine switches have since advanced
        // the stream past the initial-condition draws.
        this.rng = mulberry32(this.currentSeed);

        this.memory = new PhysicsMemory(this.params.count);
        this.state = new PhysicsState(this.params.count, this.memory);
        // Tear down any live worker before dropping the reference: the old bridge
        // holds the previous SharedArrayBuffer and can never be reused, so leaving
        // it alive orphans a worker (parked in Atomics.wait) plus its ping timer.
        this.workerBridge?.dispose();
        this.workerBridge = null;

        if (this.params.preset === 'galaxy') {
            this.ic = new GalaxyDisk();
            this.ic.initialise(this.icContext());
        } else {
            this.ic = null;
            // The accretion preset uses a live SMBH particle at index 0, so the
            // engines' analytic BH term stays off, and the engine preset softening
            // is already the right scale for a central-mass-dominated disk.
            this.params.blackHoleMass = 0;
            this.params.softening = presetFor(this.params.engineType).softening;
            this.initAccretionDisk();
        }

        // Fresh initial conditions: the simulated clock restarts and the old E0 describes
        // a system that no longer exists. Covers init(), restart(), and preset changes.
        this.simTimeSeconds = 0;
        this.resetEnergyBaseline();
    }

    /**
     * Drops the ΔE/E₀ baseline and history. Call whenever an edit makes the old E₀
     * meaningless. Idempotent.
     */
    resetEnergyBaseline(): void {
        this.energyMonitor.resetBaseline();
    }

    /**
     * Accretion preset: a central SMBH (index 0) surrounded by a thin annulus of
     * Salpeter-sampled test particles. The disk is light, so it behaves as test
     * particles orbiting the SMBH + halo and relaxes into concentric rings.
     */
    private initAccretionDisk() {
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

            const mass = sampleSalpeterMass(this.rng);
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
     * Resets particle velocities to (near-)circular orbits based on current positions.
     * Also re-applies the leapfrog half-step offset (a*dt/2) using the *current* dt,
     * so this MUST be called after any runtime change to params.dt to keep the
     * symplectic integrator's velocity correctly staggered half a step ahead.
     */
    softResetVelocities() {
        if (!this.state) return;
        if (this.ic) {
            this.ic.resetVelocities(this.icContext());
        } else {
            this.accretionResetVelocities();
        }

        if (this.webGpuEngine && this.engine === this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.webGpuEngine.updateUniforms(this.params.dt, this.params, this.renderParams);
        }

        // Every velocity in the subsystem just changed, so the old E0 is meaningless.
        // This is the chokepoint for it: switchEngine() calls us before all of its
        // fallback early-returns, and the gravity slider's `change` handler calls us too.
        this.resetEnergyBaseline();
    }

    /** Softening to use given the current preset and engine. */
    private effectiveSoftening(): number {
        if (this.ic) return this.ic.effectiveSoftening(this.params);
        return presetFor(this.params.engineType).softening;
    }

    /**
     * Timestep to use given the current preset: whatever the current initial
     * conditions derive from the disk they built. Both presets derive a safe dt
     * so they can never silently under-resolve when the central mass (and hence
     * orbital speeds) is raised: dynamical times shrink as 1/sqrt(mass) while the
     * preset dt stays fixed.
     */
    computeAdaptiveTimestep(): number {
        if (this.ic) return this.ic.adaptiveTimestep(this.params);
        return this.accretionAdaptiveTimestep();
    }

    /**
     * Timestep for the accretion preset: test particles in a static SMBH + halo
     * potential, so only the orbital-resolution limit applies, computed
     * analytically from {@link radialAcc} over the disk annulus. No
     * close-encounter term - the test particles are massless to the field and
     * exert no two-body kicks - and floored at {@link MIN_DT_FRACTION} of the
     * engine preset dt so a mis-scaling can't stall the sim.
     */
    private accretionAdaptiveTimestep(): number {
        const presetDt = presetFor(this.params.engineType).timeStep;
        // Resolve the fastest orbit about the central SMBH + halo. Sample
        // Omega(r) = vCirc(r)/r analytically over the annulus
        // [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS]. For a central
        // mass Omega is monotone-decreasing (peak at the inner edge); the grid is
        // just robustness against the halo term.
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

    /**
     * Total inward radial acceleration on an accretion-preset test particle at
     * radius `r` from the central SMBH plus the dark-matter halo. (The
     * self-gravitating preset uses a *measured* rotation curve instead; see
     * {@link GalaxyDisk}.)
     */
    private radialAcc(r: number): number {
        const softenedDistSq = r * r + this.params.softening * this.params.softening;
        const coreAcc = (this.params.gravity * ACCRETION_BH_MASS) / softenedDistSq;
        return coreAcc + haloAcc(r, this.params);
    }

    /**
     * Disk fraction f_disk = v_disk^2 / v_c^2 at radius `r` from the current
     * rotation curve. Galaxy preset only; throws on the accretion preset, which
     * has no measured curve. Exposed for verification and telemetry.
     */
    diskFractionAt(r: number): number {
        return this.galaxyDisk.diskFractionAt(r, this.params);
    }

    /**
     * Sets the staggered (leapfrog half-step) velocity for accretion-preset star
     * `i` at radius `dist`: a near-circular orbit about the central SMBH + halo
     * with a little scatter.
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

        const aTot = this.radialAcc(r);
        const vCirc = Math.sqrt(Math.max(aTot * r, 0));
        const velocity = vCirc * (0.9 + this.rng() * 0.2);
        const vx = tx * velocity;
        const vy = ty * velocity;

        // Leapfrog half-step offset using the (inward) radial acceleration, so
        // velocity stays staggered half a step ahead of position. The analytic
        // radialAcc already is this test particle's true force, so no O(N^2)
        // pass is needed.
        const ax = -ux * aTot;
        const ay = -uy * aTot;
        this.state.velocityX[i] = vx + ax * (this.params.dt / 2);
        this.state.velocityY[i] = vy + ay * (this.params.dt / 2);
    }

    /**
     * Re-derives every accretion-preset test-particle velocity from its current
     * radius. Index 0 is the live SMBH and keeps its own velocity; a particle
     * sitting exactly at the origin has no orbital plane, so it is left alone.
     */
    private accretionResetVelocities() {
        for (let i = 1; i < this.params.count; i++) {
            const distSq = this.state.positionX[i] * this.state.positionX[i] + this.state.positionY[i] * this.state.positionY[i];
            const dist = Math.sqrt(distSq);
            if (dist === 0) continue;
            this.computeStarVelocity(i, dist);
        }
    }

    /**
     * Switches the active physics engine to the requested type.
     * @param type - The target engine's string identifier.
     */
    async switchEngine(type: EngineType) {
        const preset = presetFor(type);
        this.params.theta = preset.theta;
        this.params.softening = preset.softening;
        this.params.dt = preset.timeStep;
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
            if (!this.memory.isShared) {
                // No cross-origin isolation: SharedArrayBuffer (and the worker's
                // Atomics.wait) is unavailable. Fall back to main-thread Barnes-Hut.
                this.params.engineType = 'barnes';
                this.engine = new BarnesHutEngine(this.state);
                this.onEngineFallback('Worker engine requires cross-origin isolation - running main-thread Barnes-Hut');
                return;
            }
            if (!this.workerBridge) {
                this.workerBridge = new WorkerBridge(this.memory);
            }
            this.workerStepsSeen = 0;
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
     * @param seed - Realization to load. Omitted - the Restart button, an engine-switch
     *   clamp - draws a fresh one, so a plain restart is a genuinely new galaxy.
     */
    async restart(seed?: number) {
        // ?? not ||: restart(0) must load seed 0, not draw randomly.
        this.setSeed(seed ?? randomUint32());

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
     * Advances the physics by the real time elapsed this frame, in fixed dt steps.
     *
     * Inline engines (brute/barnes/webgpu) run the fixed-timestep substep loop directly.
     * The worker engine runs a step off-thread, so instead of stepping here we account
     * for the steps it has *completed* and kick off at most one new step per frame:
     * simulated time is debited only by the growth of the worker's completed-step
     * counter, so a step dropped while the worker is busy never advances the clock and
     * the two threads stay in sync.
     *
     * Split out of {@link loop} so the accounting is unit-testable without a rAF loop.
     * @param frameSeconds - Real seconds elapsed since the previous frame (already clamped).
     */
    advancePhysics(frameSeconds: number) {
        const dt = this.params.dt;

        if (this.engine === this.workerBridge && this.workerBridge) {
            const bridge = this.workerBridge;
            const completed = bridge.getCompletedSteps();
            this.accumulator += frameSeconds;
            // Debit only work the worker has actually finished since we last looked.
            const delta = completed - this.workerStepsSeen;
            this.accumulator -= dt * delta;
            this.stepsThisWindow += delta;
            this.simTimeSeconds += dt * delta;
            this.workerStepsSeen = completed;
            if (this.accumulator < 0) this.accumulator = 0;
            // Drop backlog rather than let it spiral after a stall.
            const maxBacklog = dt * SimulationManager.MAX_SUBSTEPS;
            if (this.accumulator > maxBacklog) this.accumulator = maxBacklog;
            // One in-flight step per frame is the intended cadence; do not loop.
            if (this.accumulator >= dt && !bridge.isBusy()) {
                bridge.step(dt, this.params);
            }
            return;
        }

        this.accumulator += frameSeconds;
        let steps = 0;
        while (this.accumulator >= dt && steps < SimulationManager.MAX_SUBSTEPS) {
            this.engine.step(dt, this.params);
            this.accumulator -= dt;
            steps++;
        }
        this.stepsThisWindow += steps;
        this.simTimeSeconds += dt * steps;
        // If we hit the cap and are still behind, drop the backlog rather than spiral.
        if (steps === SimulationManager.MAX_SUBSTEPS) this.accumulator = 0;
    }

    /**
     * Services the energy monitor for one frame: continues an in-flight cycle, or starts
     * a new one when the cadence allows. Cheap and non-blocking - at most one chunk of
     * the pairwise sum per frame.
     *
     * Must be called *before* {@link advancePhysics}: on the worker path that method arms
     * the next step (flipping the bridge to COMPUTING), so a caller that services energy
     * afterwards would see `quiescent === false` on essentially every frame and never
     * sample at all. Pre-advance is also the only point where the snapshot and
     * {@link simTimeSeconds} describe the same instant for the inline engines.
     *
     * @param nowMs - The frame's `performance.now()` timestamp.
     * @param quiescent - Whether the state arrays are safe to read (no worker step in flight).
     */
    private serviceEnergy(nowMs: number, quiescent: boolean): void {
        const engine = this.engine;
        // The GPU engine's particles never leave the device, so there
        // is nothing to measure: stay idle and let the panel show its N/A state.
        if (engine.kind !== 'shared-state' || !this.energyEnabled) {
            this.energyMonitor.cancelCycle();
            return;
        }
        if (this.energyMonitor.inFlight) {
            if (this.energyMonitor.processChunk()) this.lastEnergyCycleEndMs = nowMs;
            return;
        }
        if (!quiescent) return;
        if (nowMs - this.lastEnergyCycleEndMs < SimulationManager.ENERGY_CYCLE_INTERVAL_MS) return;
        // Cadence is measured from the last cycle's *end*, so a cycle longer than the
        // interval simply back-to-backs; two cycles can never overlap.
        this.energyMonitor.beginCycle(engine.state, this.params, this.simTimeSeconds);
        if (this.energyMonitor.processChunk()) this.lastEnergyCycleEndMs = nowMs;
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

        // Let the entry layer drive DOM-facing per-frame effects (parallax background)
        // so the state layer stays DOM-free.
        this.onFrame?.(this);

        this.renderer.massThreshold = this.params.massThreshold;
        this.renderer.showQuadTree = this.params.shouldShowQuadTree;

        // One isBusy() read, shared by the paint gate and the energy gate below.
        const bridge = this.workerBridge !== null && this.engine === this.workerBridge ? this.workerBridge : null;
        const onWorker = bridge !== null;
        const workerIdle = bridge !== null && !bridge.isBusy();

        // Worker read-gate + ordering: the worker mutates the shared arrays for the
        // whole duration of a step, and a step can take longer than one display frame.
        // We must paint the last *completed* frame BEFORE advancePhysics arms the next
        // step - otherwise arming flips the status to COMPUTING and the read-gate below
        // would skip every paint, so physics would advance invisibly (a frozen view).
        // Painting only while idle also keeps the read-gate's anti-tearing guarantee.
        if (workerIdle) {
            this.renderer.quadTree = null;
            this.renderer.render();
        }

        // Energy: snapshot only while the shared arrays are quiescent and simTimeSeconds
        // still matches them - for the worker that is exactly this pre-arm window, the
        // same reason the paint happens here. See serviceEnergy.
        this.serviceEnergy(now, !onWorker || workerIdle);

        // --- Physics: advance in fixed dt increments proportional to real time ---
        // This keeps the simulation evolving at the same wall-clock rate regardless
        // of the display refresh rate, while preserving the integrator's fixed dt.
        if (!this.params.isPaused) {
            this.advancePhysics(frameSeconds);
        }

        // --- Presentation: the one discriminant branch (worker painted above) ---
        if (this.engine.kind === 'self-rendering') {
            // Keep GPU camera uniforms in sync (needed while paused too).
            this.renderParams.cameraZoom = this.renderer.camera.zoom;
            this.renderParams.cameraX = this.renderer.camera.x;
            this.renderParams.cameraY = this.renderer.camera.y;
            this.renderParams.cameraTilt = this.renderer.camera.tilt;
            this.engine.render(this.params, this.renderParams);
        } else if (!onWorker) {
            if (this.params.engineType === 'barnes') {
                this.renderer.quadTree = (this.engine as BarnesHutEngine).root || null;
            } else {
                this.renderer.quadTree = null;
            }
            this.renderer.render();
        }

        this.frames++;

        if (now - this.lastTelemetryUpdate >= 250) {
            const intervalSeconds = (now - this.lastTelemetryUpdate) / 1000;
            const fps = this.frames / intervalSeconds;
            this.stepsPerSecond = this.stepsThisWindow / intervalSeconds;
            this.stepsThisWindow = 0;
            this.onTelemetry(fps, this);
            this.frames = 0;
            this.lastTelemetryUpdate = now;
        }

        this.animationFrameId = requestAnimationFrame(this.loop);
    }
}
