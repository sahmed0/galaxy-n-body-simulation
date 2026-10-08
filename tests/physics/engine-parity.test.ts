/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Cross-engine source-selection parity. Every engine must agree on *which* bodies
 * are gravitational sources: with the active/passive split engaged, only the index
 * range [start, activeCount) generates the pairwise field, and every body receives it.
 *
 * The galaxy preset makes this observable: its passive tracers carry the same
 * per-body mass as the active disk particles, so an engine that picked sources by
 * mass instead of by index would sum every tracer too and overshoot the field.
 * This suite builds a galaxy state with the split engaged and checks one kick from
 * BruteForceEngine and from BarnesHutEngine at theta = 0 against a direct oracle
 * that sums the active range only, plus the halo and pinned-BH terms.
 */
import { describe, it, expect, vi } from 'vitest';
import { BruteForceEngine, BarnesHutEngine, PhysicsState } from '../../src/physics';
import type { PhysicsParams } from '../../src/physics/types';
import { pairwiseAccel, darkMatterAccel, smbhAccel } from '../../src/physics/kernels';
import { SimulationManager } from '../../src/state';
import { cloneState } from '../utils/state';

describe('engine source-selection parity (galaxy split)', () => {
    it('brute force and theta = 0 Barnes-Hut match a direct active-range oracle', () => {
        vi.spyOn(console, 'log').mockImplementation(() => { });

        const sim = new SimulationManager();
        sim.params.preset = 'galaxy';
        sim.params.count = 4000;
        sim.params.selfGravActiveCount = 1000;
        sim.setSeed(12345);
        sim.initGalaxy();
        const base = cloneState(sim.state);      // t = 0 snapshot, never stepped
        const p = sim.params;                    // blackHoleMass > 0, dt set by the IC
        const n = base.n;
        const start = 1;                         // index 0 is the pinned BH

        // The split is engaged: 1000 active disk particles after the pinned BH.
        expect(p.activeCount).toBe(1001);
        expect(p.activeCount).toBeLessThan(n);
        expect(p.blackHoleMass).toBeGreaterThan(0);

        // Oracle arrays: slot 0 is the receiver (mass 0), slots 1.. are the active sources.
        const nSrc = p.activeCount - start;
        const ox = new Float64Array(nSrc + 1);
        const oy = new Float64Array(nSrc + 1);
        const om = new Float64Array(nSrc + 1);
        ox.set(base.positionX.subarray(start, p.activeCount), 1);
        oy.set(base.positionY.subarray(start, p.activeCount), 1);
        om.set(base.mass.subarray(start, p.activeCount), 1);  // om[0] stays 0: the receiver never sums itself

        /** Expected kick dv on body i from the active sources + halo + pinned BH, mirroring BruteForceEngine. */
        function oracleKick(i: number): { dvx: number; dvy: number } {
            ox[0] = base.positionX[i];
            oy[0] = base.positionY[i];
            const acc = { ax: 0, ay: 0 };
            let ax = 0, ay = 0;
            // Pairwise over the active range. An active receiver also appears once among
            // the sources; that copy sits at distance 0, so it contributes
            // G*m*0/(eps^2)^1.5 = 0 to both components and needs no skip.
            pairwiseAccel(ox, oy, om, nSrc + 1, 0, p.gravity, p.softening * p.softening, acc);
            ax += acc.ax; ay += acc.ay;
            darkMatterAccel(base.positionX[i], base.positionY[i], p.dmStrength, p.dmCoreRadius, acc);
            ax += acc.ax; ay += acc.ay;
            smbhAccel(base.positionX[i], base.positionY[i], p.gravity, p.blackHoleMass, p.blackHoleSoftening, acc);
            ax += acc.ax; ay += acc.ay;
            return { dvx: ax * p.dt, dvy: ay * p.dt };
        }

        // step() also drifts positions, but the kick precedes the drift and the drift
        // never writes velocity, so the velocity deltas are exactly the kick.
        function kicksFrom(engine: BruteForceEngine | BarnesHutEngine, s: PhysicsState, params: PhysicsParams) {
            const vx0 = s.velocityX.slice(), vy0 = s.velocityY.slice();
            engine.step(params.dt, params);
            return { dvx: (i: number) => s.velocityX[i] - vx0[i], dvy: (i: number) => s.velocityY[i] - vy0[i] };
        }
        const sBrute = cloneState(base);
        const brute = kicksFrom(new BruteForceEngine(sBrute), sBrute, p);
        const sTree = cloneState(base);
        const treeEngine = new BarnesHutEngine(sTree);
        const tree = kicksFrom(treeEngine, sTree, { ...p, theta: 0 });
        treeEngine.dispose();

        const expected = new Array<{ dvx: number; dvy: number }>(n);
        let maxOracle = 0;
        for (let i = start; i < n; i++) {
            expected[i] = oracleKick(i);
            maxOracle = Math.max(maxOracle, Math.hypot(expected[i].dvx, expected[i].dvy));
        }
        const floor = 1e-6 * maxOracle;

        /** Max over receivers of |dv_engine - dv_oracle| / max(|dv_oracle|, floor). */
        function maxRelError(k: ReturnType<typeof kicksFrom>): number {
            let worst = 0;
            for (let i = start; i < n; i++) {
                const e = expected[i];
                const err = Math.hypot(k.dvx(i) - e.dvx, k.dvy(i) - e.dvy);
                worst = Math.max(worst, err / Math.max(Math.hypot(e.dvx, e.dvy), floor));
            }
            return worst;
        }
        // Both engines sum each force term in float64 and kick once per term. The remaining
        // error is float32 velocity storage: the kick is read back as a difference of
        // float32 velocities, whose rounding is large next to a single step's dv.
        // Measured ≈ 4.3e-5 for both; frozen with ~2.3x margin. Kicking the passive
        // tracers once per source into float32 measured ≈ 6.0e-4 and fails this bound.
        expect(maxRelError(brute)).toBeLessThan(1e-4);
        expect(maxRelError(tree)).toBeLessThan(1e-4);

        // One active and one passive receiver, as magnitude ratios. A tree that picked
        // sources by mass summed every equal-mass tracer too: measured 3.8 and 3.3 here.
        const ratio = (k: ReturnType<typeof kicksFrom>, i: number) =>
            Math.hypot(k.dvx(i), k.dvy(i)) / Math.hypot(expected[i].dvx, expected[i].dvy);
        for (const k of [brute, tree]) {
            for (const i of [1, n - 1]) {
                const r = ratio(k, i);
                expect(r).toBeGreaterThanOrEqual(0.99);
                expect(r).toBeLessThanOrEqual(1.01);
            }
        }
    });
});
