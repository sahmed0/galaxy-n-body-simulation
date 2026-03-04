/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from './PhysicsState';
import type { PhysicsEngine, PhysicsParams, InitialConditionType } from './types';
import { QuadTree } from './QuadTree';

/**
 * Barnes-Hut Physics Engine.
 */
export class BarnesHutEngine implements PhysicsEngine {
    private state?: PhysicsState;
    public root?: QuadTree;
    private hasLogged: boolean = false;

    // No permanent acceleration buffers needed for Leapfrog
    // We calculate acceleration and apply it directly to velocity.

    /**
     * Constructs the BarnesHutEngine and optionally initializes it with a given state.
     * @param state - The optional initial state to apply upon construction.
     */
    constructor(state?: PhysicsState) {
        if (state) {
            this.init(state.n, state);
        }
    }

    /**
     * Initialises the engine with the provided number of bodies and starting data.
     * @param n - The number of bodies to simulate.
     * @param initialConditions - The structure holding initial state information.
     */
    public init(n: number, initialConditions: InitialConditionType): void {
        this.state = initialConditions;
        this.hasLogged = false;

        console.log(`[BarnesHutEngine] Initialised with ${n} bodies.`);
    }

    /**
     * Retrieves the X-axis positions of all tracked bodies.
     * @returns A Float32Array containing body positions along the X-axis.
     */
    public getPositions(): Float32Array {
        return this.state ? this.state.positionX : new Float32Array(0);
    }

    /**
     * Retrieves the X-axis velocities of all tracked bodies.
     * @returns A Float32Array containing body velocities along the X-axis.
     */
    public getVelocities(): Float32Array {
        return this.state ? this.state.velocityX : new Float32Array(0);
    }

    /**
     * Updates the physics simulation using the Leapfrog integration method and QuadTree spatial partitioning.
     * @param dt - The time step delta to apply to velocities and positions.
     * @param params - A configuration object defining system forces such as gravity and softening.
     */
    public update(dt: number, params: PhysicsParams): void {
        if (!this.state) return;

        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const vx = this.state.velocityX;
        const vy = this.state.velocityY;
        const mass = this.state.mass;
        const massThreshold = params.massThreshold || 0;

        // --- Leapfrog Step ---
        // 1. Rebuild QuadTree (at time t)

        // 1. Establish Dynamic Boundaries for the QuadTree
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        // Find the absolute minimum and maximum bounds of all particles this frame
        for (let i = 0; i < n; i++) {
            if (mass[i] >= massThreshold) {
                if (px[i] < minX) minX = px[i];
                if (px[i] > maxX) maxX = px[i];
                if (py[i] < minY) minY = py[i];
                if (py[i] > maxY) maxY = py[i];
            }
        }

        // Add a small 1% padding to the boundaries to ensure edge particles fit cleanly
        const width = (maxX - minX) || 1;
        const height = (maxY - minY) || 1;
        const paddingLimit = Math.max(width, height) * 1.01;

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const boundary = {
            x: centerX,
            y: centerY,
            width: paddingLimit,
            height: paddingLimit
        };

        // Free the old tree back to the pool
        if (this.root) {
            this.root.free();
        }

        // Get a new root from the pool
        this.root = QuadTree.create(boundary, 4);

        // Insert only particles with mass >= threshold
        for (let i = 0; i < n; i++) {
            if (mass[i] >= massThreshold) {
                this.root.insert(i, this.state);
            }
        }

        this.root.calculateMassDistribution(this.state);

        // 2. Calculate Forces and apply kicks v(t+dt/2) = v(t-dt/2) + a(t) * dt
        const G = params.gravity;
        const theta = params.theta;
        const softening = params.softening;

        // Calculate forces for ALL particles (indices 0 to N-1)
        for (let i = 0; i < n; i++) {
            this.calculateForceAndAddKick(i, this.root, G, theta, softening, dt);
        }

        // 2b. Add Central Forces (Dark Matter Halo + Supermassive Black Hole)
        const dmStrength = params.dmStrength || 0;
        const smbhMass = params.blackHoleMass || 0;

        if (dmStrength > 0 || smbhMass > 0) {
            const dmCoreRadius = params.dmCoreRadius || 50.0;
            const dmStrengthSq = dmStrength * dmStrength;
            const dmCoreRadiusSq = dmCoreRadius * dmCoreRadius;
            const smbhSofteningSq = (params.blackHoleSoftening || params.softening) ** 2;

            for (let i = 0; i < n; i++) {
                const pix = px[i];
                const piy = py[i];
                const rawDistSq = pix * pix + piy * piy;

                // Dark Matter (No square roots as they are slow)
                if (dmStrength > 0) {
                    const aDM_base = dmStrengthSq / (rawDistSq + dmCoreRadiusSq);
                    vx[i] -= pix * aDM_base * dt;
                    vy[i] -= piy * aDM_base * dt;
                }

                // Supermassive Black Hole
                if (smbhMass > 0) {
                    const smbhDistSq = rawDistSq + smbhSofteningSq;
                    const smbhDist = Math.sqrt(smbhDistSq);
                    const aSMBH = (G * smbhMass * dt) / (smbhDistSq * smbhDist);
                    vx[i] -= aSMBH * pix;
                    vy[i] -= aSMBH * piy;
                }
            }
        }

        // 3. Update Positions x(t+dt) = x(t) + v(t+dt/2) * dt
        for (let i = 0; i < n; i++) {
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
        }

        if (!this.hasLogged) {
            console.log("Barnes-Hut engine: Physics active.");
            this.hasLogged = true;
        }
    }

    private calculateForceAndAddKick(i: number, node: QuadTree, G: number, theta: number, softening: number, dt: number): void {
        // If node is empty (totalMass == 0), skip
        if (node.totalMass === 0) return;

        const px = this.state!.positionX[i];
        const py = this.state!.positionY[i];

        // 1. If it's a leaf node, calculate force from all bodies inside it
        if (!node.divided) {
            const points = node.points;
            const len = points.length;
            for (let k = 0; k < len; k++) {
                const j = points[k];
                if (i === j) continue;

                const dx = this.state!.positionX[j] - px;
                const dy = this.state!.positionY[j] - py;
                const distSq = dx * dx + dy * dy + softening * softening;
                const dist = Math.sqrt(distSq);

                const a = (G * this.state!.mass[j] * dt) / (distSq * dist);
                this.state!.velocityX[i] += a * dx;
                this.state!.velocityY[i] += a * dy;
            }
            return;
        }

        // 2. Internal Node - Apply Theta Criterion
        const dx = node.centerOfMassX - px;
        const dy = node.centerOfMassY - py;
        const distSq = dx * dx + dy * dy + softening * softening;
        const dist = Math.sqrt(distSq);

        // s = width of region
        const s = node.boundary.width;

        // theta criterion: s / d < theta
        if (s / dist < theta) {
            // Treat as single body
            const a = (G * node.totalMass * dt) / (distSq * dist);
            this.state!.velocityX[i] += a * dx;
            this.state!.velocityY[i] += a * dy;
        } else {
            // Recurse
            if (node.northwest) this.calculateForceAndAddKick(i, node.northwest, G, theta, softening, dt);
            if (node.northeast) this.calculateForceAndAddKick(i, node.northeast, G, theta, softening, dt);
            if (node.southwest) this.calculateForceAndAddKick(i, node.southwest, G, theta, softening, dt);
            if (node.southeast) this.calculateForceAndAddKick(i, node.southeast, G, theta, softening, dt);
        }
    }
}
