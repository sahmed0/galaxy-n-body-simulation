/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Log-scaled star-count slider. A linear 1k-200k slider makes everything below ~20k
 * unreachable, so the slider's fixed 0-SLIDER_STEPS position maps to [COUNT_MIN, max] in
 * log space, where `max` is the active engine's cap.
 */
export const COUNT_MIN = 1_000;
export const SLIDER_STEPS = 1_000;

/** Slider position for a count; counts outside [COUNT_MIN, max] pin to the ends. */
export function countToSliderPos(count: number, max: number): number {
    const c = Math.min(Math.max(count, COUNT_MIN), max);
    return Math.round((Math.log(c / COUNT_MIN) / Math.log(max / COUNT_MIN)) * SLIDER_STEPS);
}

/** Count for a slider position, rounded to 100 and clamped to [COUNT_MIN, max]. */
export function sliderPosToCount(pos: number, max: number): number {
    const count = COUNT_MIN * Math.pow(max / COUNT_MIN, pos / SLIDER_STEPS);
    return Math.min(max, Math.max(COUNT_MIN, Math.round(count / 100) * 100));
}

/** Writes the filled-track percentage for any range input (read by `.slider` CSS). */
export function setSliderFill(input: HTMLInputElement): void {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${pct}%`);
}
