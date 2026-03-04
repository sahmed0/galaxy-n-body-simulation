/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { PhysicsState } from './PhysicsState';

/**
 * Defines a 2-dimensional spatial area.
 */
export interface Boundary {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A spatial partitioning tree structured to accelerate N-body gravity calculations.
 */
export class QuadTree {
    boundary: Boundary;
    capacity: number;
    points: number[]; // Indices of particles in PhysicsState
    divided: boolean;
    northwest: QuadTree | null;
    northeast: QuadTree | null;
    southwest: QuadTree | null;
    southeast: QuadTree | null;

    totalMass: number;
    centerOfMassX: number;
    centerOfMassY: number;

    // --- OBJECT POOLING ---
    private static pool: QuadTree[] = [];
    private static readonly POOL_CAPACITY = 20000; // Pre-allocate/Limit

    /**
     * Retrieves a QuadTree instance from the object pool or creates a new one.
     * @param boundary - Spatial area constraints designated for this node.
     * @param capacity - Maximum particle capacity before forcing a subdivision.
     * @returns A clean QuadTree referencing the new spatial area.
     */
    static create(boundary: Boundary, capacity: number): QuadTree {
        if (QuadTree.pool.length > 0) {
            const node = QuadTree.pool.pop()!;
            node.reset(boundary, capacity);
            return node;
        }
        return new QuadTree(boundary, capacity);
    }

    /**
     * Recursively clears instances and pushes the nodes back onto the object pool.
     */
    free(): void {
        // Recursively free children
        if (this.divided) {
            if (this.northwest) this.northwest.free();
            if (this.northeast) this.northeast.free();
            if (this.southwest) this.southwest.free();
            if (this.southeast) this.southeast.free();
        }

        // Reset references to break cycles (help GC if pool overflows, though we reuse)
        this.northwest = null;
        this.northeast = null;
        this.southwest = null;
        this.southeast = null;
        this.points = [];
        this.divided = false;

        // Return to pool if space available
        if (QuadTree.pool.length < QuadTree.POOL_CAPACITY) {
            QuadTree.pool.push(this);
        }
    }

    /**
     * Reinitalises internal states with a new spatial boundary and capacity,
     * without creating new memory or abandoning the pooled memory slot.
     * @param boundary The new geometric region limits assigned.
     * @param capacity The particle storage capacity constraint.
     */
    private reset(boundary: Boundary, capacity: number): void {
        this.boundary = boundary;
        this.capacity = capacity;
        this.points = [];
        this.divided = false;
        this.northwest = null;
        this.northeast = null;
        this.southwest = null;
        this.southeast = null;
        this.totalMass = 0;
        this.centerOfMassX = 0;
        this.centerOfMassY = 0;
    }
    // ---------------------

    /**
     * Direct instantiator for QuadTree (Use QuadTree.create instead for pooling).
     * @param boundary - Limits of the spatial node.
     * @param capacity - Particle threshold limit.
     */
    constructor(boundary: Boundary, capacity: number) {
        this.boundary = boundary;
        this.capacity = capacity;
        this.points = [];
        this.divided = false;
        this.northwest = null;
        this.northeast = null;
        this.southwest = null;
        this.southeast = null;
        this.totalMass = 0;
        this.centerOfMassX = 0;
        this.centerOfMassY = 0;
    }

    /**
     * Determines if a designated spatial coordinate falls within the bounds of this node.
     * @param x - Horizontal coordinate space.
     * @param y - Vertical coordinate space.
     * @returns True if the point is contained natively inside this sector.
     */
    contains(x: number, y: number): boolean {
        return (
            x >= this.boundary.x - this.boundary.width / 2 &&
            x <= this.boundary.x + this.boundary.width / 2 &&
            y >= this.boundary.y - this.boundary.height / 2 &&
            y <= this.boundary.y + this.boundary.height / 2
        );
    }

    /**
     * Splits the node into four separate recursive coordinate blocks (NW, NE, SW, SE).
     */
    subdivide(): void {
        const x = this.boundary.x;
        const y = this.boundary.y;
        const w = this.boundary.width / 2;
        const h = this.boundary.height / 2;

        const nwVal: Boundary = { x: x - w / 2, y: y - h / 2, width: w, height: h };
        this.northwest = QuadTree.create(nwVal, this.capacity);

        const neVal: Boundary = { x: x + w / 2, y: y - h / 2, width: w, height: h };
        this.northeast = QuadTree.create(neVal, this.capacity);

        const swVal: Boundary = { x: x - w / 2, y: y + h / 2, width: w, height: h };
        this.southwest = QuadTree.create(swVal, this.capacity);

        const seVal: Boundary = { x: x + w / 2, y: y + h / 2, width: w, height: h };
        this.southeast = QuadTree.create(seVal, this.capacity);

        this.divided = true;
    }

    /**
     * Inserts an element inside the bounds of this tree or a relative descendent recursively.
     * @param index - Identification number referencing global coordinates tracked inside SoA buffers.
     * @param state - The active structure managing positions for insertion referencing.
     * @returns Boolean confirming successful storage location internally.
     */
    insert(index: number, state: PhysicsState): boolean {
        const x = state.positionX[index];
        const y = state.positionY[index];

        if (!this.contains(x, y)) {
            return false;
        }

        if (this.points.length < this.capacity && !this.divided) {
            this.points.push(index);
            return true;
        }

        if (!this.divided) {
            this.subdivide();

            // Move existing points to children
            // Only leaf nodes hold points in this implementation
            const existingPoints = this.points;
            this.points = [];
            for (const pIndex of existingPoints) {
                if (this.northwest!.insert(pIndex, state)) continue;
                if (this.northeast!.insert(pIndex, state)) continue;
                if (this.southwest!.insert(pIndex, state)) continue;
                if (this.southeast!.insert(pIndex, state)) continue;
            }
        }

        // Insert the new point
        if (this.northwest!.insert(index, state)) return true;
        if (this.northeast!.insert(index, state)) return true;
        if (this.southwest!.insert(index, state)) return true;
        if (this.southeast!.insert(index, state)) return true;

        return false;
    }

    /**
     * Evaluates localised density mapping and generates a consolidated center of mass dynamically representing child nodes.
     * @param state - Physical object arrays evaluating raw masses to compound into node aggregates.
     */
    calculateMassDistribution(state: PhysicsState): void {
        // Init properties
        this.totalMass = 0;
        this.centerOfMassX = 0;
        this.centerOfMassY = 0;

        if (this.divided) {
            // Recursive calls for internal nodes
            this.northwest!.calculateMassDistribution(state);
            this.northeast!.calculateMassDistribution(state);
            this.southwest!.calculateMassDistribution(state);
            this.southeast!.calculateMassDistribution(state);

            // Accumulate mass and weighted position from children
            const children = [this.northwest!, this.northeast!, this.southwest!, this.southeast!];

            let massSum = 0;
            let weightedXSum = 0;
            let weightedYSum = 0;

            for (const child of children) {
                if (child.totalMass > 0) {
                    massSum += child.totalMass;
                    weightedXSum += child.centerOfMassX * child.totalMass;
                    weightedYSum += child.centerOfMassY * child.totalMass;
                }
            }

            this.totalMass = massSum;
            if (this.totalMass > 0) {
                this.centerOfMassX = weightedXSum / this.totalMass;
                this.centerOfMassY = weightedYSum / this.totalMass;
            }
        } else {
            // Leaf node: sum up points
            let massSum = 0;
            let weightedXSum = 0;
            let weightedYSum = 0;

            for (const index of this.points) {
                const m = state.mass[index];
                massSum += m;
                weightedXSum += state.positionX[index] * m;
                weightedYSum += state.positionY[index] * m;
            }

            this.totalMass = massSum;
            if (this.totalMass > 0) {
                this.centerOfMassX = weightedXSum / this.totalMass;
                this.centerOfMassY = weightedYSum / this.totalMass;
            }
        }
    }

    /**
     * Gathers spatial rectangles defining areas monitored within instances locally.
     * @param boundaries - Active running list tracking spatial rectangles parsed internally.
     * @returns Complete set of Boundary rectangles encompassing this localised network.
     */
    getAllBoundaries(boundaries: Boundary[] = []): Boundary[] {
        boundaries.push(this.boundary);
        if (this.divided) {
            this.northwest!.getAllBoundaries(boundaries);
            this.northeast!.getAllBoundaries(boundaries);
            this.southwest!.getAllBoundaries(boundaries);
            this.southeast!.getAllBoundaries(boundaries);
        }
        return boundaries;
    }

    /**
     * Zeroes structural data without freeing the object back to the pooling arrays.
     */
    clear(): void {
        this.points = [];
        this.divided = false;
        this.northwest = null;
        this.northeast = null;
        this.southwest = null;
        this.southeast = null;
        this.totalMass = 0;
        this.centerOfMassX = 0;
        this.centerOfMassY = 0;
    }
}
