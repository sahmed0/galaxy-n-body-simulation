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
   * Initialises standard non-shared array buffers representing particle coordinates.
   * Optionally accepts references to memory slices if part of a multithreaded pool.
   * @param n - Particle initialisation boundary count constraint.
   * @param shared - Config parameter passing reference views from external Shared buffers.
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
   * Resets the state with a new number of particles.
   * Warning: This does NOT resize the inner SharedArrayBuffer if one is used.
   * Logic requiring a resize must destroy and recreate the parent PhysicsMemory constraint.
   * @param n - Expanded or narrowed structural array length sequence identifier.
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
