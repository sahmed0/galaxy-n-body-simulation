/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from './PhysicsState';
import type { SharedStateEngine, PhysicsParams, InitialConditionType } from './types';
import { QuadTree } from './QuadTree';
import {
    pairwiseAccel,
    darkMatterAccel,
    smbhAccel,
    applyKick,
    applyDrift,
    type Accel,
} from './kernels';

/**
 * Barnes-Hut O(N log N) gravity engine: rebuilds a {@link QuadTree} each step and
 * approximates distant groups by their centre of mass (theta criterion), summing
 * the collected sources through the same `pairwiseAccel` kernel as brute force so
 * the two backends differ only in the spatial approximation, not the force law.
 */
export class BarnesHutEngine implements SharedStateEngine {
    public readonly kind = 'shared-state' as const;
    public state!: PhysicsState;
    public root?: QuadTree;

    // Reused scratch buffers for the per-particle tree walk: the collected sources
    // (a leaf's bodies + accepted internal nodes' COMs) acting on the current body,
    // summed through the shared `pairwiseAccel` kernel. Index 0 holds the receiver
    // itself (mass 0, never summed), so BH and brute force share one force formula.
    private srcX: number[] = [];
    private srcY: number[] = [];
    private srcM: number[] = [];

    // Reused across every kernel call in a step so the per-body tree walk allocates
    // nothing in steady state. Safe: each engine steps single-threaded, one call at a time.
    private scratchAccel: Accel = { ax: 0, ay: 0 };

    // Number of pairwise interactions (collected tree-walk sources) the most recent
    // step evaluated, for telemetry. Depends on N and theta, so it is measured, not derived.
    private lastInteractionCount = 0;

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
     * Adopts the given state as the engine's working set. The tree is rebuilt from
     * it every step, so no per-body setup is needed here.
     * @param _n - Total body count (unused; the engine reads `state.n` directly).
     * @param initialConditions - The state this engine steps in place.
     */
    public init(_n: number, initialConditions: InitialConditionType): void {
        this.state = initialConditions;
    }

    /**
     * Releases the pooled QuadTree back to its node pool so it can be reused by a
     * subsequent engine.
     */
    public dispose(): void {
        if (this.root) {
            this.root.free();
            this.root = undefined;
        }
    }

    /**
     * Number of pairwise interactions the most recent step evaluated (collected
     * tree-walk sources summed over all bodies).
     * @returns Interactions from the last {@link step}.
     */
    public getLastInteractionCount(): number {
        return this.lastInteractionCount;
    }

    /**
     * Updates the physics simulation using the Leapfrog integration method and QuadTree spatial partitioning.
     * @param dt - The time step delta to apply to velocities and positions.
     * @param params - A configuration object defining system forces such as gravity and softening.
     */
    public step(dt: number, params: PhysicsParams): void {
        if (!this.state) return;

        const n = this.state.n;
        const px = this.state.positionX;
        const py = this.state.positionY;
        const vx = this.state.velocityX;
        const vy = this.state.velocityY;
        const mass = this.state.mass;
        // When active/passive is disabled, every body participates in the tree
        // (full N-body). Otherwise only bodies at/above the mass threshold are
        // inserted, so sub-threshold bodies act as massless test particles.
        // Masses are strictly positive, so -Infinity admits all of them.
        const massThreshold = params.useActivePassive ? (params.massThreshold || 0) : -Infinity;

        // When a fixed central black hole is active (self-grav preset), index 0 is
        // its pinned, inert marker: it is excluded from the tree (not a source),
        // never kicked, and never integrated. Its pull on the disk is the analytic
        // SMBH term in §2b, with its own softening. `start` skips it everywhere.
        const start = (params.blackHoleMass || 0) > 0 ? 1 : 0;

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

        // Insert only particles with mass >= threshold. Skip index 0 when it is the
        // pinned BH marker: it must not act as a tree source (GALAXY_CENTRAL_BH_MASS would swamp
        // the disk field) - its pull comes from the analytic SMBH term in §2b.
        for (let i = start; i < n; i++) {
            if (mass[i] >= massThreshold) {
                this.root.insert(i, this.state);
            }
        }

        this.root.calculateMassDistribution(this.state);

        // 2. Calculate Forces and apply kicks v(t+dt/2) = v(t-dt/2) + a(t) * dt
        const G = params.gravity;
        const theta = params.theta;
        const softeningSq = params.softening * params.softening;

        // Calculate forces for all disk particles (index 0 skipped when it is the
        // pinned BH marker, which feels no force). The tree walk collects the
        // sources acting on `i`, then the shared `pairwiseAccel` kernel sums them -
        // BH and brute force therefore use the identical pairwise force law, so the
        // only difference under test is the theta tree approximation.
        // Count actual sources collected during the tree walks (srcX minus the receiver
        // slot at index 0), giving the exact per-step interaction total for telemetry.
        let interactions = 0;
        const acc = this.scratchAccel;
        for (let i = start; i < n; i++) {
            this.treeAcceleration(i, G, theta, softeningSq);
            interactions += this.srcX.length - 1;
            applyKick(vx, vy, i, acc.ax, acc.ay, dt);
        }
        this.lastInteractionCount = interactions;

        // 2b. Add Central Forces (Dark Matter Halo + Supermassive Black Hole), via
        // the shared central-field kernels (same formulas, dt applied by applyKick).
        const dmStrength = params.dmStrength || 0;
        const smbhMass = params.blackHoleMass || 0;

        if (dmStrength > 0 || smbhMass > 0) {
            const dmCoreRadius = params.dmCoreRadius || 50.0;
            const smbhSoftening = params.blackHoleSoftening || params.softening;

            const acc = this.scratchAccel;
            for (let i = start; i < n; i++) {
                if (dmStrength > 0) {
                    darkMatterAccel(px[i], py[i], dmStrength, dmCoreRadius, acc);
                    applyKick(vx, vy, i, acc.ax, acc.ay, dt);
                }
                if (smbhMass > 0) {
                    smbhAccel(px[i], py[i], G, smbhMass, smbhSoftening, acc);
                    applyKick(vx, vy, i, acc.ax, acc.ay, dt);
                }
            }
        }

        // 3. Update Positions x(t+dt) = x(t) + v(t+dt/2) * dt
        // Index 0 (the pinned BH marker) is left at the origin.
        for (let i = start; i < n; i++) {
            applyDrift(px, py, vx, vy, i, dt);
        }
    }

    /**
     * Tree-walk acceleration on body `i`: collects every source acting on it (each
     * body in a leaf, or an accepted internal node's COM pseudo-body) into the reused
     * scratch buffers, then writes the Newtonian sum into `this.scratchAccel` via the
     * shared `pairwiseAccel` kernel. Acceleration only (no dt); the integrator applies dt.
     */
    private treeAcceleration(i: number, G: number, theta: number, softeningSq: number): void {
        const sx = this.srcX, sy = this.srcY, sm = this.srcM;
        sx.length = 0;
        sy.length = 0;
        sm.length = 0;
        // Index 0 is the receiver itself (mass 0, never summed - pairwiseAccel skips j===i).
        sx.push(this.state!.positionX[i]);
        sy.push(this.state!.positionY[i]);
        sm.push(0);

        this.collectSources(i, this.root!, theta, softeningSq);

        pairwiseAccel(sx, sy, sm, sx.length, 0, G, softeningSq, this.scratchAccel);
    }

    /**
     * Recursively walks the tree, pushing the sources that act on body `i` into the
     * scratch buffers: a leaf contributes each of its bodies (excluding `i`); an
     * internal node contributes its COM as a single pseudo-body when the theta
     * criterion `width / dist < theta` holds (softened distance), else recurses.
     */
    private collectSources(i: number, node: QuadTree, theta: number, softeningSq: number): void {
        // If node is empty (totalMass == 0), skip
        if (node.totalMass === 0) return;

        const px = this.state!.positionX[i];
        const py = this.state!.positionY[i];

        // 1. Leaf node: every body inside it is an exact source.
        if (!node.divided) {
            const points = node.points;
            const len = points.length;
            for (let k = 0; k < len; k++) {
                const j = points[k];
                if (i === j) continue;
                this.srcX.push(this.state!.positionX[j]);
                this.srcY.push(this.state!.positionY[j]);
                this.srcM.push(this.state!.mass[j]);
            }
            return;
        }

        // 2. Internal Node - Apply Theta Criterion (softened distance, unchanged).
        const dx = node.centerOfMassX - px;
        const dy = node.centerOfMassY - py;
        const distSq = dx * dx + dy * dy + softeningSq;
        const dist = Math.sqrt(distSq);

        // s = width of region; theta criterion: s / d < theta
        if (node.boundary.width / dist < theta) {
            // Treat as single body at the node's centre of mass.
            this.srcX.push(node.centerOfMassX);
            this.srcY.push(node.centerOfMassY);
            this.srcM.push(node.totalMass);
        } else {
            // Recurse
            if (node.northwest) this.collectSources(i, node.northwest, theta, softeningSq);
            if (node.northeast) this.collectSources(i, node.northeast, theta, softeningSq);
            if (node.southwest) this.collectSources(i, node.southwest, theta, softeningSq);
            if (node.southeast) this.collectSources(i, node.southeast, theta, softeningSq);
        }
    }
}
