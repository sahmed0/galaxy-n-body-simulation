/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Frozen initial-condition fixtures. Every number below was recorded from a run of
 * initGalaxy(), not derived from theory: the test asserts that a given seed still
 * realizes the exact same galaxy, down to the last mantissa bit of every sample.
 *
 * A failure means a shared permalink no longer reproduces the state it was copied
 * from. Treat that as a bug in whatever changed the sampling order or arithmetic.
 * If the change is genuinely intended, re-record the values here and say so in the
 * commit body, so the break in permalink compatibility is on the record.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimulationManager } from '../../src/state/SimulationManager';
import { fnv1a32 } from '../utils/fixture';

interface Fixture {
    preset: 'galaxy' | 'accretion';
    count: number;
    /** Null leaves params.selfGravActiveCount at its default, which exceeds count and so is inert. */
    selfGravActiveCount: number | null;
    seed: number;
    hashes: { positionX: string; positionY: string; velocityX: string; velocityY: string; mass: string };
    /** Leading samples at 9 significant digits, which round-trips a float32 exactly. */
    positionX4: number[];
    velocityX4: number[];
    dt: number;
    activeCount: number;
    softening: number;
    diskMass: number;
}

const FIXTURES: Record<string, Fixture> = {
    'galaxy-inert-12345': {
        preset: 'galaxy', count: 2000, selfGravActiveCount: null, seed: 12345,
        hashes: {
            positionX: 'e3deb57b', positionY: 'ccb49c3f',
            velocityX: '111e0239', velocityY: 'd82af08a', mass: 'f019b9f3',
        },
        positionX4: [0, 155.510071, -72.8980179, 356.301666],
        velocityX4: [0, -13.2468576, -26.6614742, -4.8702383],
        dt: 0.016, activeCount: 2000, softening: 17.531725833858438, diskMass: 2478607.3106899266,
    },
    'galaxy-inert-c0ffee': {
        preset: 'galaxy', count: 2000, selfGravActiveCount: null, seed: 0xc0ffee,
        hashes: {
            positionX: '999e33e5', positionY: 'a7bf3239',
            velocityX: 'b21edb24', velocityY: '30aad491', mass: '7c1b9500',
        },
        positionX4: [0, 390.612854, 102.496063, 23.9713478],
        velocityX4: [0, -7.549685, -6.78411388, 56.1252136],
        dt: 0.016, activeCount: 2000, softening: 17.531725833858438, diskMass: 2462844.332718185,
    },
    'galaxy-split-12345': {
        preset: 'galaxy', count: 2000, selfGravActiveCount: 500, seed: 12345,
        hashes: {
            positionX: 'e3deb57b', positionY: 'ccb49c3f',
            velocityX: 'a901034e', velocityY: 'af5b8f20', mass: '21a4e209',
        },
        positionX4: [0, 155.510071, -72.8980179, 356.301666],
        velocityX4: [0, -13.9502172, -23.2764416, -3.81936979],
        dt: 0.016, activeCount: 501, softening: 35.05468470879306, diskMass: 2708501.826825522,
    },
    'galaxy-split-c0ffee': {
        preset: 'galaxy', count: 2000, selfGravActiveCount: 500, seed: 0xc0ffee,
        hashes: {
            positionX: '999e33e5', positionY: 'a7bf3239',
            velocityX: 'ca41e3e5', velocityY: '24904df9', mass: 'a260912c',
        },
        positionX4: [0, 390.612854, 102.496063, 23.9713478],
        velocityX4: [0, -8.33137035, -16.9523048, 63.4962807],
        dt: 0.016, activeCount: 501, softening: 35.05468470879306, diskMass: 2616621.870946926,
    },
    'accretion-12345': {
        preset: 'accretion', count: 2000, selfGravActiveCount: null, seed: 12345,
        hashes: {
            positionX: '7ed3b57b', positionY: 'de6a5c4a',
            velocityX: 'bae51228', velocityY: '55c25204', mass: '5541f604',
        },
        positionX4: [0, 44.5379486, -58.6275291, -286.006775],
        velocityX4: [0, 98.4959641, 83.4668427, 41.8087273],
        dt: 0.003991572331114555, activeCount: 107, softening: 1, diskMass: 0,
    },
    'accretion-c0ffee': {
        preset: 'accretion', count: 2000, selfGravActiveCount: null, seed: 0xc0ffee,
        hashes: {
            positionX: '9b37267e', positionY: '0881ac2f',
            velocityX: '7878f72b', velocityY: '4a699fde', mass: 'a212c7fb',
        },
        positionX4: [0, 324.575745, 84.2447128, 4.82504129],
        velocityX4: [0, 45.3398476, -86.3760834, 223.82486],
        dt: 0.003991572331114555, activeCount: 104, softening: 1, diskMass: 0,
    },
};

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

describe.each(Object.entries(FIXTURES))('%s', (_id, fx) => {
    /** Realizes the case without any DOM or GPU setup, exactly as the permalink path does. */
    function realize(): SimulationManager {
        const sim = new SimulationManager();
        sim.params.preset = fx.preset;
        sim.params.count = fx.count;
        if (fx.selfGravActiveCount !== null) sim.params.selfGravActiveCount = fx.selfGravActiveCount;
        sim.setSeed(fx.seed);
        sim.initGalaxy();
        return sim;
    }

    it('realizes the recorded sample arrays', () => {
        const { state } = realize();

        expect(fnv1a32(state.positionX)).toBe(fx.hashes.positionX);
        expect(fnv1a32(state.positionY)).toBe(fx.hashes.positionY);
        expect(fnv1a32(state.velocityX)).toBe(fx.hashes.velocityX);
        expect(fnv1a32(state.velocityY)).toBe(fx.hashes.velocityY);
        expect(fnv1a32(state.mass)).toBe(fx.hashes.mass);

        // A hash mismatch says only "something moved"; these name the first bodies
        // sampled, so a diff is readable without re-running a generator.
        expect(state.positionX.slice(0, 4)).toEqual(Float32Array.from(fx.positionX4));
        expect(state.velocityX.slice(0, 4)).toEqual(Float32Array.from(fx.velocityX4));
    });

    it('derives the recorded scalars', () => {
        const sim = realize();

        expect(sim.params.dt).toBe(fx.dt);
        expect(sim.params.activeCount).toBe(fx.activeCount);
        expect(sim.params.softening).toBe(fx.softening);
        expect(sim.diskMass).toBe(fx.diskMass);
    });
});
