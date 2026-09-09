/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { describe, it, expect } from 'vitest';
import { countToSliderPos, sliderPosToCount, COUNT_MIN, SLIDER_STEPS } from './slider';
import { ENGINE_MAX_COUNT } from '../physics/types';

describe('countToSliderPos / sliderPosToCount', () => {
    for (const [engine, cap] of Object.entries(ENGINE_MAX_COUNT)) {
        describe(engine, () => {
            it('maps position 0 to COUNT_MIN', () => {
                expect(countToSliderPos(COUNT_MIN, cap)).toBe(0);
            });

            it('maps position SLIDER_STEPS to the cap', () => {
                expect(countToSliderPos(cap, cap)).toBe(SLIDER_STEPS);
            });

            it('pins a count above the cap to the last position', () => {
                expect(countToSliderPos(cap * 10, cap)).toBe(SLIDER_STEPS);
            });

            it('round-trips representative counts within 1%', () => {
                for (const count of [1_000, 5_000, 10_000, cap]) {
                    const pos = countToSliderPos(count, cap);
                    const roundTripped = sliderPosToCount(pos, cap);
                    expect(Math.abs(roundTripped - count) / count).toBeLessThanOrEqual(0.01);
                }
            });
        });
    }
});
