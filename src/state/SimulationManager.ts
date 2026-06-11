/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import {
    PhysicsState,
    PhysicsMemory,
    WebGPUEngine,
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
 * Base radius for galaxy particle distribution generation.
 */
export const GALAXY_RADIUS = 500;

/**
 * Inner radius of the disk; particles are seeded in the annulus
 * [DISK_INNER_RADIUS, DISK_INNER_RADIUS + GALAXY_RADIUS].
 */
export const DISK_INNER_RADIUS = 50;

/**
 * Mass of the central core object in the galaxy simulation.
 */
export const CORE_MASS = 4300000;

/**
 * Total disk mass used by the self-gravitating galaxy preset. Chosen so the
 * disk's collective self-gravity dominates the SMBH (~12x CORE_MASS) and the
 * dark-matter halo, which is what allows swing-amplified spiral arms to form.
 * It is normalised to a fixed total (independent of particle count) so the
 * dynamics — and the Toomre Q below — stay consistent at any star count.
 * Note: in the default "core" preset this is unused; the disk is just the raw
 * Salpeter masses (~thousands of units) and behaves as test particles, which
 * is why that preset relaxes into concentric rings rather than spiral arms.
 */
export const SELF_GRAV_DISK_MASS = 5.0e7;

/**
 * Target Toomre Q for the self-gravitating preset. Q ~ 1.2-1.5 is the
 * spiral-forming "sweet spot": cool enough that density perturbations get
 * swing-amplified into transient arms, hot enough to avoid fragmenting into
 * clumps (Q < 1). Larger Q -> smoother/featureless disk.
 */
export const TOOMRE_Q = 1.3;

/**
 * Cap on radial velocity dispersion as a fraction of the circular speed.
 * The 1/R surface-density profile would otherwise demand an enormous sigma_R
 * in the centre (Q is held fixed there), making the inner disk a hot blob and
 * flinging stars into the softened core. Capping keeps the spiral-forming
 * outer disk at the true target Q while taming the centre.
 */
export const SIGMA_FRAC_MAX = 0.5;

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

    animationFrameId: number = 0;
    frames = 0;
    lastTelemetryUpdate = 0;

    /**
     * Effective total disk mass of the current initialisation. Non-zero only in
     * the self-gravitating preset; used to add the disk's own contribution to
     * the circular velocity and to compute the Toomre-Q velocity dispersion.
     */
    diskMass = 0;

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
            this.webGpuEngine = new WebGPUEngine();
            await this.webGpuEngine.init(this.params.count, this.state, this.params.activeCount);
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
        } else {
            await this.switchEngine(this.params.engineType);
        }
    }

    /**
     * Initialises/re-initialises galaxy particle data including positions, velocities, and colours.
     */
    initGalaxy() {
        this.memory = new PhysicsMemory(this.params.count);
        this.state = new PhysicsState(this.params.count, this.memory);
        this.workerBridge = null;

        this.state.positionX[0] = 0;
        this.state.positionY[0] = 0;
        this.state.velocityX[0] = 0;
        this.state.velocityY[0] = 0;
        this.state.mass[0] = CORE_MASS;
        this.state.colors[0] = 0;
        this.state.colors[1] = 0;
        this.state.colors[2] = 0;

        const selfGrav = this.params.galaxyMode === 'selfgrav';
        const particles: { x: number; y: number; vx: number; vy: number; mass: number; r: number; g: number; b: number; dist: number }[] = [];

        let rawMassSum = 0;
        for (let i = 1; i < this.params.count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = DISK_INNER_RADIUS + Math.random() * GALAXY_RADIUS;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist;

            const mMin = 0.1;
            const mMax = 50.0;
            const p = 1.35;
            const u = Math.random();
            const minP = Math.pow(mMin, -p);
            const maxP = Math.pow(mMax, -p);
            const mass = Math.pow(u * (maxP - minP) + minP, -1 / p);

            // Colour reflects the *stellar* mass (Salpeter, 0.1-50 Msun), so it
            // stays consistent across presets even when we rescale the physical
            // mass below for the self-gravitating disk.
            const [r, g, b] = massToColor(mass);
            rawMassSum += mass;
            particles.push({ x, y, vx: 0, vy: 0, mass, r, g, b, dist });
        }

        if (selfGrav) {
            // Normalise the whole disk to a fixed total mass so its self-gravity
            // dominates the SMBH and halo (and is independent of star count).
            // Each particle becomes a "macro-particle" tracing a mass element,
            // not a single star -- the standard trade-off in N-body galaxies.
            const scale = SELF_GRAV_DISK_MASS / rawMassSum;
            for (const part of particles) part.mass *= scale;
            this.diskMass = SELF_GRAV_DISK_MASS;
        } else {
            this.diskMass = 0;
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
     * Resets particle velocities to (near-)circular orbits based on current positions.
     * Also re-applies the leapfrog half-step offset (a*dt/2) using the *current* dt,
     * so this MUST be called after any runtime change to params.dt to keep the
     * symplectic integrator's velocity correctly staggered half a step ahead.
     */
    softResetVelocities() {
        if (!this.state) return;
        for (let i = 1; i < this.params.count; i++) {
            const distSq = this.state.positionX[i] * this.state.positionX[i] + this.state.positionY[i] * this.state.positionY[i];
            const dist = Math.sqrt(distSq);

            if (dist === 0) continue;

            this.computeStarVelocity(i, dist);
        }

        if (this.activeEngineStr === 'gpu' && this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.webGpuEngine.updateUniforms(this.params.dt, this.params);
        }
    }

    /**
     * Total inward radial acceleration on a star at radius `r` from the smooth
     * mass components: the central SMBH, the dark-matter halo, and — only in the
     * self-gravitating preset — the disk's own enclosed mass (monopole
     * approximation). Used to set circular velocities and the epicyclic frequency.
     */
    private radialAcc(r: number): number {
        const G = this.params.gravity;
        const rawDistSq = r * r;
        const softenedDistSq = rawDistSq + this.params.softening * this.params.softening;

        const coreAcc = (G * CORE_MASS) / softenedDistSq;
        const dmAcc = (this.params.dmStrength * this.params.dmStrength * r) / (rawDistSq + this.params.dmCoreRadius * this.params.dmCoreRadius);

        let diskAcc = 0;
        if (this.diskMass > 0) {
            // Enclosed disk mass for the uniform-in-radius (Sigma ~ 1/R) profile.
            const encFrac = Math.min(Math.max((r - DISK_INNER_RADIUS) / GALAXY_RADIUS, 0), 1);
            diskAcc = (G * this.diskMass * encFrac) / softenedDistSq;
        }

        return coreAcc + dmAcc + diskAcc;
    }

    /**
     * Sets the staggered (leapfrog half-step) velocity for star `i` at radius
     * `dist`. In the default "core" preset this is a near-circular orbit with a
     * little scatter. In the self-gravitating preset the orbit is warmed with a
     * radial + tangential velocity dispersion derived from a target Toomre Q so
     * the disk is marginally stable and forms swing-amplified spiral arms.
     */
    private computeStarVelocity(i: number, dist: number) {
        const px = this.state.positionX[i];
        const py = this.state.positionY[i];

        const aTot = this.radialAcc(dist);
        const vCirc = Math.sqrt(aTot * dist);

        // Radial (outward) and tangential (counter-clockwise) unit vectors.
        const ux = px / dist;
        const uy = py / dist;
        const tx = -uy;
        const ty = ux;

        let vx: number;
        let vy: number;

        if (this.diskMass > 0) {
            // --- Self-gravitating disk: warm to target Toomre Q ---
            // Epicyclic frequency: kappa^2 = 2 (v/R)(v/R + dv/dR), via finite diff.
            const eps = Math.max(dist * 0.01, 1e-3);
            const rPlus = dist + eps;
            const rMinus = Math.max(dist - eps, 1e-3);
            const vPlus = Math.sqrt(this.radialAcc(rPlus) * rPlus);
            const vMinus = Math.sqrt(this.radialAcc(rMinus) * rMinus);
            const dvdr = (vPlus - vMinus) / (rPlus - rMinus);

            const omega = vCirc / dist;
            const kappa = Math.sqrt(Math.max(2 * omega * (omega + dvdr), 1e-6));

            // Local surface density of the uniform-in-R disk:
            // Sigma(R) = Mdisk / (2*pi*R*(r1 - r0)), with (r1 - r0) = GALAXY_RADIUS.
            const sigmaSurf = this.diskMass / (2 * Math.PI * dist * GALAXY_RADIUS);

            // Toomre Q for stars: Q = sigma_R * kappa / (3.36 * G * Sigma)
            //   => sigma_R = Q * 3.36 * G * Sigma / kappa
            let sigmaR = (TOOMRE_Q * 3.36 * this.params.gravity * sigmaSurf) / kappa;
            sigmaR = Math.min(sigmaR, SIGMA_FRAC_MAX * vCirc);

            // Epicyclic relation between the two dispersions.
            const sigmaPhi = sigmaR * (kappa / (2 * omega));

            const dvR = this.gaussianRandom() * sigmaR;
            const dvPhi = this.gaussianRandom() * sigmaPhi;

            // Mean motion is circular; asymmetric drift is neglected (the disk
            // settles into equilibrium within a few dynamical times regardless).
            vx = tx * vCirc + ux * dvR + tx * dvPhi;
            vy = ty * vCirc + uy * dvR + ty * dvPhi;
        } else {
            // --- Core-dominated (original): near-circular with mild scatter ---
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

        this.softResetVelocities();

        if (this.workerBridge && type !== 'worker') {
            this.workerBridge.destroy();
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
            console.log("Switching to WebGPU...");
            this.activeEngineStr = 'gpu';

            if (!this.webGpuEngine) {
                this.webGpuEngine = new WebGPUEngine();
                await this.webGpuEngine.init(this.params.count, this.state, this.params.activeCount);
            } else {
                this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
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
        this.loop();
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
