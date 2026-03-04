/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from './PhysicsState';
import type { PhysicsEngine, PhysicsParams, InitialConditionType } from './types';

/**
 * Handles the physics simulation for the N-body system.
 * Uses a brute-force O(N^2) gravity kernel and Velocity-Verlet integration.
 */
export class BruteForceEngine implements PhysicsEngine {
    private state!: PhysicsState;

    /**
     * Constructs the BruteForceEngine and immediately evaluates the provided state.
     * @param state - The complete structure of data arrays that track simulation elements.
     */
    constructor(state: PhysicsState) {
        this.init(state.n, state);
    }

    /**
     * Evaluates and updates the baseline state inside the engine.
     * @param _n - The unused explicit particle count (handled via state inspection).
     * @param initialConditions - The structure tracking starting attributes for all bodies.
     */
    public init(_n: number, initialConditions: InitialConditionType): void {
        this.state = initialConditions;
    }

    /**
     * Inspects the stored horizontal positions within the active internal state.
     * @returns The raw Float32Array mapped to X-coordinate memory space.
     */
    public getPositions(): Float32Array {
        return this.state.positionX; // Note: This only returns X. The interface is slightly ambiguous for SoA.
    }

    /**
     * Inspects the horizontal velocities actively iterating over time inside the engine.
     * @returns The associated Float32Array measuring the X-axis velocity data for all managed elements.
     */
    public getVelocities(): Float32Array {
        return this.state.velocityX;
    }

    /**
     * Updates the simulation by a time step `dt`.
     * Uses Leapfrog integration (v half-step ahead):
     * 1. Calculate a(t)
     * 2. v(t+dt/2) = v(t-dt/2) + a(t) * dt
     * 3. r(t+dt) = r(t) + v(t+dt/2) * dt
     * 
     * @param dt - The time step representing duration elapsed for numeric iteration logic.
     * @param params - Configuration parameter blocks evaluating spatial phenomena like Dark Matter.
     */
    public update(dt: number, params: PhysicsParams): void {
        // 1. Calculate a(t) and apply to v immediately
        this.calculateForcesAndAddKicks(dt, params);

        // 2. Update positions
        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const vx = this.state.velocityX;
        const vy = this.state.velocityY;

        for (let i = 0; i < n; i++) {
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
        }
    }

    /**
     * Brute-force O(N^2) gravity calculation.
     * Calculated acceleration is added directly to velocity.
     * 
     * @param dt - Numerical time duration for computing velocity modifiers based on active delta times.
     * @param params - Simulation constants establishing baseline forces between multiple active and trailing bodies.
     */
    private calculateForcesAndAddKicks(dt: number, params: PhysicsParams): void {
        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const vx = this.state.velocityX;
        const vy = this.state.velocityY;
        const mass = this.state.mass;
        const G = params.gravity;
        const softeningSq = params.softening * params.softening;
        const activeCount = params.useActivePassive ? Math.min(params.activeCount, n) : n;

        // 1. Heavy <-> Heavy interactions (Newton's 3rd Law Optimisation: i < j)
        for (let i = 0; i < activeCount; i++) {
            for (let j = i + 1; j < activeCount; j++) {
                const dx = px[j] - px[i];
                const dy = py[j] - py[i];
                const distSq = dx * dx + dy * dy + softeningSq;
                const dist = Math.sqrt(distSq);
                const aBase = G / (distSq * dist);

                // Acceleration on i due to j
                const ai = aBase * mass[j] * dt;
                vx[i] += ai * dx;
                vy[i] += ai * dy;

                // Acceleration on j due to i (Newton's 3rd Law: opposite force)
                const aj = aBase * mass[i] * dt;
                vx[j] -= aj * dx;
                vy[j] -= aj * dy;
            }
        }

        // 2. Heavy -> Light interactions (One-way Gravity)
        if (params.useActivePassive && activeCount < n) {
            for (let i = 0; i < activeCount; i++) {
                const mi = mass[i];
                const pix = px[i];
                const piy = py[i];

                for (let j = activeCount; j < n; j++) {
                    const dx = px[j] - pix;
                    const dy = py[j] - piy;
                    const distSq = dx * dx + dy * dy + softeningSq;
                    const dist = Math.sqrt(distSq);

                    // Light particle j is attracted by Heavy particle i
                    const aj = (G * mi * dt) / (distSq * dist);
                    vx[j] -= aj * dx;
                    vy[j] -= aj * dy;
                }
            }
        }

        // 3. Dark Matter Halo Force (Isothermal Halo toward centre)
        const dmStrength = params.dmStrength || 0;
        if (dmStrength > 0) {
            const dmCoreRadius = params.dmCoreRadius || 50.0;
            const dmStrengthSq = dmStrength * dmStrength;
            const dmCoreRadiusSq = dmCoreRadius * dmCoreRadius;

            for (let i = 0; i < n; i++) {
                const pix = px[i];
                const piy = py[i];
                const distSq = pix * pix + piy * piy;

                // Mathematical optimisation: `dist` natively cancels out
                // resulting in purely squared variables and zero square roots.
                const aDM_base = dmStrengthSq / (distSq + dmCoreRadiusSq);
                vx[i] -= pix * aDM_base * dt;
                vy[i] -= piy * aDM_base * dt;
            }
        }

        // 4. Supermassive Black Hole (SMBH) Central Force
        const smbhMass = params.blackHoleMass || 0;
        if (smbhMass > 0) {
            const smbhSofteningSq = (params.blackHoleSoftening || params.softening) ** 2;
            for (let i = 0; i < n; i++) {
                const pix = px[i];
                const piy = py[i];
                const distSq = pix * pix + piy * piy + smbhSofteningSq;
                const dist = Math.sqrt(distSq);

                // Force perfectly directed towards the galactic centre (0,0)
                const aSMBH = (G * smbhMass * dt) / (distSq * dist);
                vx[i] -= aSMBH * pix;
                vy[i] -= aSMBH * piy;
            }
        }
    }
}
