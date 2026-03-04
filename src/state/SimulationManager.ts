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
 * Mass of the central core object in the galaxy simulation.
 */
export const CORE_MASS = 4300000;

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

        const G = this.params.gravity;
        const particles: { x: number; y: number; vx: number; vy: number; mass: number; r: number; g: number; b: number; dist: number }[] = [];

        for (let i = 1; i < this.params.count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 50 + Math.random() * GALAXY_RADIUS;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist;

            const mMin = 0.1;
            const mMax = 50.0;
            const p = 1.35;
            const u = Math.random();
            const minP = Math.pow(mMin, -p);
            const maxP = Math.pow(mMax, -p);
            const mass = Math.pow(u * (maxP - minP) + minP, -1 / p);

            const [r, g, b] = massToColor(mass);
            particles.push({ x, y, vx: 0, vy: 0, mass, r, g, b, dist });
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

            this.params.activeCount = tempActiveCount;

            const rawDistSq = p.dist * p.dist;
            const softenedDistSq = rawDistSq + this.params.softening * this.params.softening;

            const newtonianAccMag = (G * CORE_MASS) / softenedDistSq;
            const dmAccMag = (this.params.dmStrength * this.params.dmStrength * p.dist) / (rawDistSq + this.params.dmCoreRadius * this.params.dmCoreRadius);
            const totalAccMag = newtonianAccMag + dmAccMag;

            const velocity = Math.sqrt(totalAccMag * p.dist) * (0.95 + Math.random() * 0.2);

            const vtx = (-this.state.positionY[i] / p.dist) * velocity;
            const vty = (this.state.positionX[i] / p.dist) * velocity;

            const ax = -(this.state.positionX[i] / p.dist) * totalAccMag;
            const ay = -(this.state.positionY[i] / p.dist) * totalAccMag;

            this.state.velocityX[i] = vtx + ax * (this.params.dt / 2);
            this.state.velocityY[i] = vty + ay * (this.params.dt / 2);
        }
    }

    /**
     * Partially resets particle velocities based on current positions to maintain orbital mechanics.
     */
    softResetVelocities() {
        if (!this.state) return;
        const G = this.params.gravity;
        for (let i = 1; i < this.params.count; i++) {
            const distSq = this.state.positionX[i] * this.state.positionX[i] + this.state.positionY[i] * this.state.positionY[i];
            const dist = Math.sqrt(distSq);

            if (dist === 0) continue;

            const rawDistSq = distSq;
            const softenedDistSq = rawDistSq + this.params.softening * this.params.softening;

            const newtonianAccMag = (G * CORE_MASS) / softenedDistSq;
            const dmAccMag = (this.params.dmStrength * this.params.dmStrength * dist) / (rawDistSq + this.params.dmCoreRadius * this.params.dmCoreRadius);
            const totalAccMag = newtonianAccMag + dmAccMag;

            const velocity = Math.sqrt(totalAccMag * dist) * (0.95 + Math.random() * 0.2);
            const vtx = (-this.state.positionY[i] / dist) * velocity;
            const vty = (this.state.positionX[i] / dist) * velocity;

            const ax = -(this.state.positionX[i] / dist) * totalAccMag;
            const ay = -(this.state.positionY[i] / dist) * totalAccMag;

            this.state.velocityX[i] = vtx + ax * (this.params.dt / 2);
            this.state.velocityY[i] = vty + ay * (this.params.dt / 2);
        }

        if (this.activeEngineStr === 'gpu' && this.webGpuEngine) {
            this.webGpuEngine.setParticles(this.params.count, this.state, this.params.activeCount);
            this.webGpuEngine.updateUniforms(this.params.dt, this.params);
        }
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

        this.loop();
    }

    /**
     * The primary recursive animation step driving physics iterations and screen painted representations.
     * Also calculates standard telemetry data like frame rates.
     */
    loop = () => {
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

        if (!this.params.isPaused) {
            this.renderer.massThreshold = this.params.massThreshold;
            this.renderer.showQuadTree = this.params.shouldShowQuadTree;

            if (this.activeEngineStr === 'gpu' && this.webGpuEngine) {
                this.params.cameraZoom = this.renderer.camera.zoom;
                this.params.cameraX = this.renderer.camera.x;
                this.params.cameraY = this.renderer.camera.y;
                this.params.cameraTilt = this.renderer.camera.tilt;
                this.webGpuEngine.update(this.params.dt, this.params);
            } else {
                this.engine.update(this.params.dt, this.params);
                if (this.params.engineType === 'barnes') {
                    this.renderer.quadTree = (this.engine as BarnesHutEngine).root || null;
                } else {
                    this.renderer.quadTree = null;
                }
                this.renderer.render();
            }
        } else {
            if (this.activeEngineStr === 'cpu') {
                this.renderer.render();
            } else if (this.activeEngineStr === 'gpu' && this.webGpuEngine) {
                this.params.cameraZoom = this.renderer.camera.zoom;
                this.params.cameraX = this.renderer.camera.x;
                this.params.cameraY = this.renderer.camera.y;
                this.params.cameraTilt = this.renderer.camera.tilt;
                this.webGpuEngine.update(0, this.params);
            }
        }

        const now = performance.now();
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
