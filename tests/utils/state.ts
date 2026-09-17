/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Deep-copies a PhysicsState into fresh, unshared arrays so two engines can step
 * the same realization independently.
 */
import { PhysicsState } from '../../src/physics';

export function cloneState(src: PhysicsState): PhysicsState {
    const out = new PhysicsState(src.n);
    out.positionX.set(src.positionX);
    out.positionY.set(src.positionY);
    out.velocityX.set(src.velocityX);
    out.velocityY.set(src.velocityY);
    out.mass.set(src.mass);
    out.colors.set(src.colors);
    return out;
}
