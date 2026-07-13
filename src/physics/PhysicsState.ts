/**
 * Copyright (c) 2026 Sajid Ahmed
 */
/**
 * Manages the raw Structure of Arrays (SoA) data for the N-body simulation.
 * This layout is cache-friendly and mimics GPU memory patterns for future WebGPU porting.
 */
export class PhysicsState {
  // Using Float32Array for performance and WebGL/WebGPU compatibility.
  public n: number;
  public positionX: Float32Array;
  public positionY: Float32Array;
  public velocityX: Float32Array;
  public velocityY: Float32Array;
  public mass: Float32Array;
  public colors: Float32Array;

  /**
   * Allocates the per-body arrays. If `shared` is given, the state instead adopts
   * those already-allocated views (the SharedArrayBuffer path used by the worker),
   * so main thread and worker read and write the same memory.
   * @param n - Number of bodies.
   * @param shared - Optional externally-owned views to adopt instead of allocating.
   */
  constructor(n: number, shared?: {
    positionX: Float32Array,
    positionY: Float32Array,
    velocityX: Float32Array,
    velocityY: Float32Array,
    mass: Float32Array,
    colors: Float32Array
  }) {
    this.n = n;
    if (shared) {
      this.positionX = shared.positionX;
      this.positionY = shared.positionY;
      this.velocityX = shared.velocityX;
      this.velocityY = shared.velocityY;
      this.mass = shared.mass;
      this.colors = shared.colors;
    } else {
      this.positionX = new Float32Array(n);
      this.positionY = new Float32Array(n);
      this.velocityX = new Float32Array(n);
      this.velocityY = new Float32Array(n);
      this.mass = new Float32Array(n);
      this.colors = new Float32Array(n * 3);
    }
  }

  /**
   * Reallocates all arrays for a new body count.
   * Warning: this allocates fresh (non-shared) arrays and does NOT resize any
   * backing SharedArrayBuffer. A shared-memory resize must instead recreate the
   * owning PhysicsMemory.
   * @param n - New number of bodies.
   */
  public resize(n: number): void {
    // Throw error or handle properly if using shared memory, as we can't resize a SAB view easily without reallocating everything.
    // For now, assume this is only called when NOT using shared memory or appropriately handled by caller.
    this.n = n;
    this.positionX = new Float32Array(n);
    this.positionY = new Float32Array(n);
    this.velocityX = new Float32Array(n);
    this.velocityY = new Float32Array(n);
    this.mass = new Float32Array(n);
    this.colors = new Float32Array(n * 3);
  }
}
