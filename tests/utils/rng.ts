/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Re-export of the production PRNG. The implementation moved to src/utils/rng.ts when
 * seeded permalinks made reproducible initial conditions a shipping feature; this shim
 * keeps existing test imports working and guarantees the suite seeds the exact generator
 * the app runs.
 */
export { mulberry32 } from '../../src/utils/rng';
