/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Seeded permalinks: the URL hash carries the seed and the parameters that shape a
 * realization, so a link reproduces the initial conditions it was copied from.
 *
 * The contract is t=0 only. A seed fixes the initial-condition draws; it does not
 * replay a run, because later user actions (engine switches, the gravity slider) draw
 * from the same generator and move it on. Camera is deliberately not encoded.
 *
 * Parsing treats the hash as hostile input: every field is validated independently and
 * a bad one is dropped rather than defaulted, so a mangled link degrades to "some
 * defaults" instead of throwing on boot.
 */
import { ENGINE_MAX_COUNT, isEngineType, type EngineType } from '../physics/types';

/** The shareable subset of simulation parameters, plus the seed that realized them. */
export interface PermalinkState {
    /** uint32 seed of the realization. */
    seed: number;
    /** Particle count; engine-capped. */
    count: number;
    /** Physics backend. */
    engine: EngineType;
    /** Initial-condition preset. */
    preset: 'galaxy' | 'accretion';
    /** Gravitational constant. */
    gravity: number;
    /** Dark-matter halo strength. */
    dmStrength: number;
}

const PRESETS = ['galaxy', 'accretion'] as const;

const GRAVITY_MIN = 0.1;
const GRAVITY_MAX = 10;
const DM_MIN = 0;
const DM_MAX = 1000;
const COUNT_MIN = 1_000;
const UINT32_MAX = 0xffffffff;

/**
 * Builds the hash fragment for a state.
 * @param s - The state to encode.
 * @returns A hash string including the leading `#`.
 */
export function encodePermalink(s: PermalinkState): string {
    return `#s=${s.seed}&n=${s.count}&e=${s.engine}&p=${s.preset}&g=${s.gravity}&dm=${s.dmStrength}`;
}

/**
 * Reads a field, mapping both absent and empty to undefined. Empty must not fall
 * through to the numeric parsers: `Number('')` is 0, which would silently forge a value.
 */
function raw(p: URLSearchParams, key: string): string | undefined {
    const v = p.get(key);
    return v === null || v === '' ? undefined : v;
}

/**
 * Reads a finite number, or undefined. Uses `Number`, not `parseFloat`, which would
 * accept '12abc' as 12 - a dropped field is the honest reading of a malformed one.
 */
function num(p: URLSearchParams, key: string): number | undefined {
    const s = raw(p, key);
    if (s === undefined) return undefined;
    const v = Number(s);
    return Number.isFinite(v) ? v : undefined;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}

/**
 * Parses a permalink hash into the fields it validly carries.
 *
 * Every check is an explicit `!== undefined` rather than a truthiness test: `seed = 0`
 * and `dmStrength = 0` are both legitimate values and both falsy.
 *
 * @param hash - A location hash, with or without the leading `#`. Malformed input
 *   yields `{}`; this never throws.
 * @returns Only the fields that were present and valid.
 */
export function parsePermalink(hash: string): Partial<PermalinkState> {
    const out: Partial<PermalinkState> = {};
    try {
        const p = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);

        const seed = num(p, 's');
        if (seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed <= UINT32_MAX) {
            out.seed = seed;
        }

        // Engine resolves first: a count's legal range is a property of the engine, so an
        // unresolved engine makes the count unclampable and both are dropped. Assuming a
        // default engine here would be wrong - the default is webgpu, which falls back to
        // barnes *asynchronously*, and barnes cannot run webgpu's 200k cap.
        const engineRaw = raw(p, 'e');
        if (engineRaw !== undefined && isEngineType(engineRaw)) {
            out.engine = engineRaw;

            const count = num(p, 'n');
            if (count !== undefined && Number.isInteger(count)) {
                out.count = clamp(count, COUNT_MIN, ENGINE_MAX_COUNT[engineRaw]);
            }
        }

        const preset = raw(p, 'p');
        if (preset !== undefined && (PRESETS as readonly string[]).includes(preset)) {
            out.preset = preset as PermalinkState['preset'];
        }

        const gravity = num(p, 'g');
        if (gravity !== undefined) out.gravity = clamp(gravity, GRAVITY_MIN, GRAVITY_MAX);

        const dmStrength = num(p, 'dm');
        if (dmStrength !== undefined) out.dmStrength = clamp(dmStrength, DM_MIN, DM_MAX);

        return out;
    } catch {
        // URLSearchParams is hard to make throw, but its percent-decoding is the one place a
        // hostile hash could bite, and boot must never die on a bad link.
        return {};
    }
}
