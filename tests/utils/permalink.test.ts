/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Permalink encode/parse. The parser's whole job is to be safe with a hostile or
 * hand-edited hash, so most of these cases are about what it *rejects*.
 */
import { describe, it, expect } from 'vitest';
import { encodePermalink, parsePermalink, type PermalinkState } from '../../src/utils/permalink';

const GALAXY: PermalinkState = {
    seed: 12345,
    count: 5000,
    engine: 'barnes',
    preset: 'galaxy',
    gravity: 1,
    dmStrength: 250,
};

const ACCRETION: PermalinkState = {
    seed: 4294967295,
    count: 20000,
    engine: 'brute',
    preset: 'accretion',
    gravity: 2.5,
    dmStrength: 0,
};

describe('encodePermalink / parsePermalink round-trip', () => {
    it('recovers a galaxy state exactly', () => {
        expect(parsePermalink(encodePermalink(GALAXY))).toEqual(GALAXY);
    });

    it('recovers an accretion state exactly, including dmStrength = 0', () => {
        expect(parsePermalink(encodePermalink(ACCRETION))).toEqual(ACCRETION);
    });

    it('accepts a hash with or without the leading #', () => {
        const hash = encodePermalink(GALAXY);
        expect(parsePermalink(hash.slice(1))).toEqual(GALAXY);
    });
});

describe('parsePermalink hostile input', () => {
    it('drops every field of the spec hostile case', () => {
        // s=-1 out of uint32 range; e=<script> is not an engine, which drops n with it;
        // g=abc is NaN.
        expect(parsePermalink('#s=-1&n=1e99&e=<script>&g=abc')).toEqual({});
    });

    it('never throws on structurally broken hashes', () => {
        for (const h of ['', '#', '#%%%', '#&&&=', '#s=1&s=2', '#=', '#####']) {
            expect(() => parsePermalink(h)).not.toThrow();
        }
    });
});

describe('parsePermalink seed validation', () => {
    it('admits seed 0 despite it being falsy', () => {
        expect(parsePermalink('#s=0').seed).toBe(0);
    });

    it('admits the uint32 maximum', () => {
        expect(parsePermalink('#s=4294967295').seed).toBe(4294967295);
    });

    it.each([
        ['above uint32', '#s=4294967296'],
        ['negative', '#s=-1'],
        ['non-integer', '#s=1.5'],
        ['empty', '#s='],
        ['non-numeric', '#s=abc'],
        // parseFloat would take this as 12; Number does not.
        ['trailing garbage', '#s=12abc'],
    ])('drops a %s seed', (_label, hash) => {
        expect(parsePermalink(hash).seed).toBeUndefined();
    });
});

describe('parsePermalink count clamping against engine caps', () => {
    it.each([
        ['brute', '#e=brute&n=50000', 20_000],
        ['barnes', '#e=barnes&n=50000', 50_000],
        ['webgpu', '#e=webgpu&n=50000', 50_000],
        ['webgpu over cap', '#e=webgpu&n=999999', 200_000],
        ['worker', '#e=worker&n=50000', 50_000],
    ])('clamps %s to its cap', (_label, hash, expected) => {
        expect(parsePermalink(hash).count).toBe(expected);
    });

    it('clamps up to the 1000 floor', () => {
        expect(parsePermalink('#e=barnes&n=10').count).toBe(1_000);
    });

    it('drops a non-integer count', () => {
        expect(parsePermalink('#e=brute&n=1500.5').count).toBeUndefined();
    });
});

describe('parsePermalink engine gating of count', () => {
    it('drops count when no engine is given, since the cap is unknowable', () => {
        const r = parsePermalink('#n=5000');
        expect(r.count).toBeUndefined();
        expect(r.engine).toBeUndefined();
    });

    it('drops both when the engine is invalid', () => {
        const r = parsePermalink('#e=nope&n=5000');
        expect(r.count).toBeUndefined();
        expect(r.engine).toBeUndefined();
    });

    it('keeps other fields when the engine is invalid', () => {
        expect(parsePermalink('#e=nope&n=5000&s=7&g=2')).toEqual({ seed: 7, gravity: 2 });
    });
});

describe('parsePermalink scalar clamping', () => {
    it.each([
        ['gravity above max', '#g=99', 'gravity', 10],
        ['gravity below min', '#g=0', 'gravity', 0.1],
        ['gravity negative', '#g=-5', 'gravity', 0.1],
        ['dm negative', '#dm=-5', 'dmStrength', 0],
        ['dm above max', '#dm=99999', 'dmStrength', 1000],
    ] as const)('clamps %s', (_label, hash, field, expected) => {
        expect(parsePermalink(hash)[field]).toBe(expected);
    });
});

describe('parsePermalink preset whitelist', () => {
    it.each(['galaxy', 'accretion'])('admits %s', (preset) => {
        expect(parsePermalink(`#p=${preset}`).preset).toBe(preset);
    });

    it.each(['bogus', 'GALAXY', ''])('drops %s', (preset) => {
        expect(parsePermalink(`#p=${preset}`).preset).toBeUndefined();
    });
});
