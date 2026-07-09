/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from './PhysicsState';
import type { SharedStateEngine, PhysicsParams, InitialConditionType } from './types';
import { pairwiseAccel, darkMatterAccel, smbhAccel, applyKick, applyDrift } from './kernels';

/**
 * Handles the physics simulation for the N-body system.
 * Uses a brute-force O(N^2) gravity kernel and kick-drift leapfrog integration
 * (symplectic): `v += a*dt; x += v*dt`, where the initial conditions stagger the
 * velocity half a step ahead of the position so the scheme is 2nd-order and
 * energy-stable. The half-step offset assumes a fixed dt; if dt changes at
 * runtime the velocities must be re-staggered (see SimulationManager.softResetVelocities).
 */
export class BruteForceEngine implements SharedStateEngine {
    public readonly kind = 'shared-state' as const;
    public state!: PhysicsState;

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
     * No owned resources (workers, GPU buffers, DOM nodes, timers) to release.
     * Implemented for contract symmetry so callers can dispose any engine
     * uniformly.
     */
    public dispose(): void {
        // Intentionally empty.
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
    public step(dt: number, params: PhysicsParams): void {
        // 1. Calculate a(t) and apply to v immediately
        this.calculateForcesAndAddKicks(dt, params);

        // 2. Update positions
        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const vx = this.state.velocityX;
        const vy = this.state.velocityY;

        // When a fixed central black hole is active (self-grav preset), index 0 is
        // its pinned, inert marker: never integrate it so it stays at the origin.
        const start = (params.blackHoleMass || 0) > 0 ? 1 : 0;
        for (let i = start; i < n; i++) {
            applyDrift(px, py, vx, vy, i, dt);
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

        // When a fixed central black hole is active (self-grav preset), index 0 is
        // its pinned, inert marker: it is neither a pairwise source nor a receiver -
        // its pull on the disk is the analytic SMBH term (§4) with its own softening.
        // Start every pairwise/central loop at `start` so index 0 is left untouched.
        const start = (params.blackHoleMass || 0) > 0 ? 1 : 0;

        // 1. Heavy <-> Heavy interactions, via the shared pairwise-accel kernel.
        // Each heavy body gets the full Newtonian sum over the other heavies; the
        // kernel returns acceleration (no dt/mass[i]) and the integrator applies dt.
        // Views over [start, activeCount) exclude the pinned BH (index 0) as both a
        // source and a receiver and cap the sum at the active set, matching the old
        // loop bounds. (Drops the i<j symmetric optimisation in exchange for a single
        // force law shared with Barnes-Hut.)
        const hn = activeCount - start;
        if (hn > 1) {
            const hx = px.subarray(start, activeCount);
            const hy = py.subarray(start, activeCount);
            const hm = mass.subarray(start, activeCount);
            for (let k = 0; k < hn; k++) {
                const { ax, ay } = pairwiseAccel(hx, hy, hm, hn, k, G, softeningSq);
                applyKick(vx, vy, k + start, ax, ay, dt);
            }
        }

        // 2. Heavy -> Light interactions (One-way Gravity)
        if (params.useActivePassive && activeCount < n) {
            for (let i = start; i < activeCount; i++) {
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
            for (let i = start; i < n; i++) {
                const { ax, ay } = darkMatterAccel(px[i], py[i], dmStrength, dmCoreRadius);
                applyKick(vx, vy, i, ax, ay, dt);
            }
        }

        // 4. Supermassive Black Hole (SMBH) Central Force
        const smbhMass = params.blackHoleMass || 0;
        if (smbhMass > 0) {
            const smbhSoftening = params.blackHoleSoftening || params.softening;
            // Index 0 is the BH itself (pinned at origin); skip it via `start`.
            for (let i = start; i < n; i++) {
                const { ax, ay } = smbhAccel(px[i], py[i], G, smbhMass, smbhSoftening);
                applyKick(vx, vy, i, ax, ay, dt);
            }
        }
    }
}
