/**
 * WGSL uniform layout guard.
 *
 * Pins the TS uniform write order ({@link buildUniformFields}) to the WGSL `Params` struct in
 * `shaders.wgsl`. The buffer is uploaded as a flat positional `Float32Array`, so any change that
 * shifts the struct's alignment (e.g. inserting a `vec2`/`vec3` that pushes a later field off its
 * naturally-aligned slot) would silently corrupt every subsequent uniform. This test recomputes
 * the WGSL byte layout statically and asserts the TS table matches it field-for-field.
 */
import { describe, it, expect } from 'vitest';
import shaderSrc from '../../src/physics/shaders.wgsl?raw';
import { buildUniformFields } from '../../src/physics/WebGPUEngine';
import type { PhysicsParams } from '../../src/physics/types';
import { parseStruct, computeComponentLayout } from '../utils/wgsl';

// Distinct representative values - the test asserts on names/offsets, not values, but a fully
// populated object exercises the real table rather than the `|| default` fallbacks.
const params: PhysicsParams = {
    gravity: 1, dt: 0.01, softening: 2, activeCount: 8, useActivePassive: true, theta: 0.7,
    dmStrength: 3, dmCoreRadius: 40, blackHoleMass: 5, blackHoleSoftening: 6,
    cameraZoom: 1.5, cameraX: 11, cameraY: 12, cameraTilt: 0.6,
};

describe('WGSL Params uniform layout', () => {
    const tsFields = buildUniformFields(params, 0.01, 256, 8, 1920, 1080);
    const { components, size } = computeComponentLayout(parseStruct(shaderSrc, 'Params'));

    it('TS table and WGSL struct have the same number of f32 components (20)', () => {
        expect(tsFields.length).toBe(20);
        expect(components.length).toBe(20);
    });

    it('struct size is 20 * 4 = 80 bytes', () => {
        expect(size).toBe(20 * 4);
    });

    it('every component is densely packed at byte offset 4*index (no alignment gaps)', () => {
        components.forEach((component, i) => {
            expect(component.offset).toBe(4 * i);
        });
    });

    it('TS field names match the WGSL components in order', () => {
        components.forEach((component, i) => {
            expect(tsFields[i].name).toBe(component.name);
        });
    });
});
