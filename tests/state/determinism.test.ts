/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Seeded initial conditions: the guarantee a permalink rests on. One seed must yield
 * exactly one realization, on every manager and on every re-initialisation - otherwise
 * a shared link reproduces a different galaxy than the one it was copied from.
 *
 * initGalaxy() touches no DOM or GPU, so it is driven directly; init(canvasId) is not
 * needed here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulationManager } from '../../src/state/SimulationManager';

const PRESETS = ['galaxy', 'accretion'] as const;

// Small enough to keep the suite fast, large enough that a diverging stream is
// certain to show up in the compared arrays.
const COUNT = 2_000;

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

/** Builds and realizes a manager at a given seed, without any DOM/engine setup. */
function realize(preset: (typeof PRESETS)[number], seed: number, count = COUNT) {
    const sim = new SimulationManager();
    sim.params.preset = preset;
    sim.params.count = count;
    sim.setSeed(seed);
    sim.initGalaxy();
    return sim;
}

describe.each(PRESETS)('%s initial conditions are seed-determined', (preset) => {
    it('produces identical positions, velocities and masses for the same seed', () => {
        const a = realize(preset, 0xc0ffee);
        const b = realize(preset, 0xc0ffee);

        expect(a.state.positionX).toEqual(b.state.positionX);
        expect(a.state.positionY).toEqual(b.state.positionY);
        expect(a.state.velocityX).toEqual(b.state.velocityX);
        expect(a.state.velocityY).toEqual(b.state.velocityY);
        expect(a.state.mass).toEqual(b.state.mass);
    });

    it('produces a different realization for a different seed', () => {
        const a = realize(preset, 0xc0ffee);
        const b = realize(preset, 0xbadbed);

        expect(a.state.positionX).not.toEqual(b.state.positionX);
    });

    it('reproduces its realization when the same manager re-initialises', () => {
        // The restart(seed) contract: initGalaxy() must re-derive the stream, not
        // continue it, or a restart at a pinned seed would drift from the link.
        const sim = realize(preset, 0xc0ffee);
        const first = sim.state.positionX.slice();

        sim.initGalaxy();

        expect(sim.state.positionX).toEqual(first);
    });
});

describe('setSeed', () => {
    it('normalizes a seed to uint32', () => {
        const sim = new SimulationManager();
        sim.setSeed(-1);
        expect(sim.currentSeed).toBe(0xffffffff);
    });

    it('yields the realization of the normalized seed', () => {
        const a = realize('galaxy', -1);
        const b = realize('galaxy', 0xffffffff);
        expect(a.state.positionX).toEqual(b.state.positionX);
    });

    it('defaults to seed 0 so a bare manager is reproducible', () => {
        expect(new SimulationManager().currentSeed).toBe(0);
    });
});
