/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * QuadTree centre-of-mass invariants (Phase 6). Barnes-Hut accuracy rests entirely on
 * each node carrying the correct aggregate mass + mass-weighted centre of mass, so this
 * tests `calculateMassDistribution` directly through the public API — no engine, no theta,
 * no force law. Three structural invariants:
 *   1. root.totalMass == Σ mass            (conservation of mass under aggregation)
 *   2. root COM       == mass-weighted mean of every particle
 *   3. every internal node == the mass-weighted combination of its four children
 *      (the exact recurrence the tree walk implements, checked node-by-node)
 * plus the coincident-particle / MIN_CELL_SIZE edge case (the subdivision cutoff that
 * stops infinite recursion when many particles share a coordinate).
 *
 * Pool gotcha (recorded in PROGRESS): `QuadTree.pool` is a *static* array. Subdivision
 * pulls child nodes from it and `free()` returns them, reset, for the next test. So every
 * test frees its root in a `finally` / afterEach — otherwise a later test's `create` could
 * hand back a node still wired into this test's tree. `create`/`reset` fully reinitialise a
 * pooled node, so freeing-then-rebuilding is the correct isolation, not a pool .length=0
 * (the field is private and inaccessible anyway).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { QuadTree, type Boundary } from '../../src/physics/QuadTree';
import { PhysicsState } from '../../src/physics/PhysicsState';

/** Deterministic mulberry32 PRNG — reproducible cloud without the Phase 7 rng util. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Body { x: number; y: number; m: number; }

/** Fills a fresh Float32 PhysicsState from a body list (velocities/colours irrelevant here). */
function makeState(bodies: Body[]): PhysicsState {
    const state = new PhysicsState(bodies.length);
    for (let i = 0; i < bodies.length; i++) {
        state.positionX[i] = bodies[i].x;
        state.positionY[i] = bodies[i].y;
        state.mass[i] = bodies[i].m;
    }
    return state;
}

/** A square boundary centred at origin wide enough to contain a box of half-width R. */
function squareBoundary(halfWidth: number): Boundary {
    const w = halfWidth * 2;
    return { x: 0, y: 0, width: w, height: w };
}

/** Builds + populates a tree, runs the aggregation, returns the root. Caller must free it. */
function buildTree(bodies: Body[], boundary: Boundary, capacity: number): { root: QuadTree; state: PhysicsState } {
    const state = makeState(bodies);
    const root = new QuadTree(boundary, capacity);
    for (let i = 0; i < bodies.length; i++) {
        // Sanity: every particle must land in the tree, else the invariants below are vacuous.
        expect(root.insert(i, state)).toBe(true);
    }
    root.calculateMassDistribution(state);
    return { root, state };
}

/** Reference mass-weighted COM over the float32 state values (float64 accumulation). */
function referenceCOM(state: PhysicsState): { mass: number; comX: number; comY: number } {
    let mass = 0, wx = 0, wy = 0;
    for (let i = 0; i < state.n; i++) {
        const m = state.mass[i];
        mass += m;
        wx += state.positionX[i] * m;
        wy += state.positionY[i] * m;
    }
    return { mass, comX: mass > 0 ? wx / mass : 0, comY: mass > 0 ? wy / mass : 0 };
}

// Track every root we build so it is always returned to the static pool, even on failure.
let pendingRoots: QuadTree[] = [];
function track(root: QuadTree): QuadTree { pendingRoots.push(root); return root; }
afterEach(() => {
    for (const r of pendingRoots) r.free();
    pendingRoots = [];
});

const R = 20.0;
const SEED = 0xc0ffee;

/** Deterministic spread-out cloud (distinct coordinates → deep subdivision). */
function makeCloud(n: number): Body[] {
    const rng = mulberry32(SEED);
    const bodies: Body[] = [];
    for (let i = 0; i < n; i++) {
        bodies.push({ x: (rng() * 2 - 1) * R, y: (rng() * 2 - 1) * R, m: 0.5 + rng() * 4 });
    }
    return bodies;
}

describe('QuadTree centre-of-mass aggregation invariants', () => {
    it('root totalMass equals the sum of all particle masses', () => {
        const bodies = makeCloud(200);
        const { root } = track2(buildTree(bodies, squareBoundary(32), 1));
        const ref = referenceCOM(makeState(bodies));
        // Both sum the same float32 values in float64 but in different order; roundoff over
        // ~200 terms is ~1e-13 relative. Assert < 1e-12 rel (defensible float64 floor).
        expect(Math.abs(root.totalMass - ref.mass) / ref.mass).toBeLessThan(1e-12);
    });

    it('root centre of mass equals the mass-weighted mean position', () => {
        const bodies = makeCloud(200);
        const { root, state } = track2(buildTree(bodies, squareBoundary(32), 1));
        const ref = referenceCOM(state);
        // Scale by R so the tolerance is a relative position error; tree-order vs index-order
        // summation differ only at float64 roundoff (~1e-12·R).
        expect(Math.abs(root.centerOfMassX - ref.comX) / R).toBeLessThan(1e-12);
        expect(Math.abs(root.centerOfMassY - ref.comY) / R).toBeLessThan(1e-12);
    });

    it('every internal node equals the mass-weighted combination of its four children', () => {
        const bodies = makeCloud(300);
        const { root, state } = track2(buildTree(bodies, squareBoundary(32), 1));

        let internalNodesChecked = 0;
        let leafNodesChecked = 0;

        const walk = (node: QuadTree): void => {
            if (node.divided) {
                internalNodesChecked++;
                const children = [node.northwest!, node.northeast!, node.southwest!, node.southeast!];
                // Replicate calculateMassDistribution's recurrence EXACTLY, including the
                // `child.totalMass > 0` guard — empty children contribute nothing. Same float64
                // arithmetic in the same order ⇒ bit-identical, so the tolerance is just guarding
                // against accidental reordering, not real numeric drift.
                let massSum = 0, wx = 0, wy = 0;
                for (const c of children) {
                    if (c.totalMass > 0) {
                        massSum += c.totalMass;
                        wx += c.centerOfMassX * c.totalMass;
                        wy += c.centerOfMassY * c.totalMass;
                    }
                }
                expect(Math.abs(node.totalMass - massSum)).toBeLessThan(1e-9);
                if (massSum > 0) {
                    expect(Math.abs(node.centerOfMassX - wx / massSum)).toBeLessThan(1e-9);
                    expect(Math.abs(node.centerOfMassY - wy / massSum)).toBeLessThan(1e-9);
                }
                for (const c of children) walk(c);
            } else {
                leafNodesChecked++;
                // Leaf COM must be the mass-weighted mean of just its own points. Read the
                // float32 state values the tree actually used (NOT the float64 `bodies`, whose
                // mass differs from its float32 storage by ~1e-7).
                let massSum = 0, wx = 0, wy = 0;
                for (const idx of node.points) {
                    const m = state.mass[idx];
                    massSum += m;
                    wx += state.positionX[idx] * m;
                    wy += state.positionY[idx] * m;
                }
                expect(Math.abs(node.totalMass - massSum)).toBeLessThan(1e-9);
                if (massSum > 0) {
                    expect(Math.abs(node.centerOfMassX - wx / massSum)).toBeLessThan(1e-9);
                    expect(Math.abs(node.centerOfMassY - wy / massSum)).toBeLessThan(1e-9);
                }
            }
        };
        walk(root);

        // The recurrence is only meaningful if the cloud actually forced subdivision.
        expect(internalNodesChecked).toBeGreaterThan(0);
        expect(leafNodesChecked).toBeGreaterThan(0);
    });

    it('handles coincident particles via the MIN_CELL_SIZE cutoff without losing mass', () => {
        // Many particles at the *same* coordinate would recurse forever; the tree stops
        // subdividing once a cell shrinks below MIN_CELL_SIZE (1e-3) and lets one leaf hold
        // them all. Build deliberately: a dense coincident clump plus a few outliers.
        const clump: Body[] = [];
        for (let i = 0; i < 64; i++) clump.push({ x: 5, y: -5, m: 1 + (i % 3) });
        const outliers: Body[] = [
            { x: -10, y: 10, m: 2 },
            { x: 12, y: 8, m: 3 },
            { x: -3, y: -14, m: 1.5 },
        ];
        const bodies = [...clump, ...outliers];
        // capacity 1 forces maximal subdivision pressure on the clump.
        const { root, state } = track2(buildTree(bodies, squareBoundary(32), 1));

        const ref = referenceCOM(state);
        // Total mass + COM must still be exact despite the unsplit coincident leaf.
        expect(Math.abs(root.totalMass - ref.mass) / ref.mass).toBeLessThan(1e-12);
        expect(Math.abs(root.centerOfMassX - ref.comX) / R).toBeLessThan(1e-12);
        expect(Math.abs(root.centerOfMassY - ref.comY) / R).toBeLessThan(1e-12);

        // The clump must have collapsed into a single below-MIN_CELL_SIZE leaf holding all 64
        // coincident points (proves the cutoff fired rather than recursing unboundedly).
        let coincidentLeafFound = false;
        const walk = (node: QuadTree): void => {
            if (node.divided) {
                for (const c of [node.northwest!, node.northeast!, node.southwest!, node.southeast!]) walk(c);
            } else if (node.points.length >= 64) {
                coincidentLeafFound = true;
                expect(node.boundary.width).toBeLessThan(QuadTreeMinCellSize);
            }
        };
        walk(root);
        expect(coincidentLeafFound).toBe(true);
    });
});

// MIN_CELL_SIZE is a private static; mirror its value here (kept in sync with QuadTree.ts).
const QuadTreeMinCellSize = 1e-3;

/** Tracks the root for pooled cleanup, passing the build result straight through. */
function track2(built: { root: QuadTree; state: PhysicsState }): { root: QuadTree; state: PhysicsState } {
    track(built.root);
    return built;
}
