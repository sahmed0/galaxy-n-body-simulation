/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Test-side alias of the production PRNG, so every suite seeds the exact generator
 * the app runs and a fixture seeded here reproduces the same realization in the browser.
 */
export { mulberry32 } from '../../src/utils/rng';
