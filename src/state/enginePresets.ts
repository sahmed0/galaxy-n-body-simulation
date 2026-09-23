/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { EngineType } from '../physics';

/** Per-engine default physics parameters applied on an engine switch. */
export interface EnginePreset {
    theta: number;
    softening: number;
    timeStep: number;
}

/**
 * Preset configuration values for different physics engines. The worker engine runs
 * the same Barnes-Hut algorithm off-thread, so it shares the Barnes-Hut values.
 */
export const ENGINE_PRESETS: Record<EngineType, EnginePreset> = {
    brute: { theta: 0.0, softening: 1.0, timeStep: 0.016 },
    barnes: { theta: 1.0, softening: 1.0, timeStep: 0.016 },
    webgpu: { theta: 0.0, softening: 1.0, timeStep: 0.016 },
    worker: { theta: 1.0, softening: 1.0, timeStep: 0.016 }
};

/**
 * Resolves the preset for a given engine type.
 */
export function presetFor(type: EngineType): EnginePreset {
    return ENGINE_PRESETS[type];
}

// Engine capacity is a property of the engines, so it lives beside EngineType. Re-exported
// here because this module is where callers have always imported it from.
export { ENGINE_MAX_COUNT } from '../physics';
