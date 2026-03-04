/**
 * Wrapper class managing the SharedArrayBuffer memory allocation for multithreaded workers.
 */
/**
 * Copyright (c) 2026 Sajid Ahmed
 */
export class PhysicsMemory {
    public sab: SharedArrayBuffer;
    public positionX: Float32Array;
    public positionY: Float32Array;
    public velocityX: Float32Array;
    public velocityY: Float32Array;
    public mass: Float32Array;
    public colors: Float32Array;
    public flags: Int32Array;
    public floatParams: Float32Array;

    // Layout constants
    static readonly FLAG_STATUS = 0; // 0: IDLE, 1: COMPUTING
    static readonly STATUS_IDLE = 0;
    static readonly STATUS_COMPUTING = 1;

    /**
     * Evaluates total sizes based on array constants and aligns TypedArrays 
     * inside a single continuous block of lock-free memory space.
     * @param n - Number of overall particles allocated inside system matrices.
     * @param existingSab - An optional override buffer reference.
     */
    constructor(n: number, existingSab?: SharedArrayBuffer) {
        // Calculate total size:
        // pos: 2n, vel: 2n, mass: 1n, colors: 3n = 8n floats
        const float32Count = 8 * n;
        const flagsCount = 256;
        const totalBytes = float32Count * 4 + flagsCount * 4;

        if (existingSab) {
            this.sab = existingSab;
        } else {
            this.sab = new SharedArrayBuffer(totalBytes);
        }

        let offset = 0;

        // Create views (Structure of Arrays)
        this.positionX = new Float32Array(this.sab, offset, n);
        offset += n * 4;
        this.positionY = new Float32Array(this.sab, offset, n);
        offset += n * 4;

        this.velocityX = new Float32Array(this.sab, offset, n);
        offset += n * 4;
        this.velocityY = new Float32Array(this.sab, offset, n);
        offset += n * 4;

        this.mass = new Float32Array(this.sab, offset, n);
        offset += n * 4;

        this.colors = new Float32Array(this.sab, offset, n * 3);
        offset += n * 3 * 4;

        // Flags - Int32 for atomic ops
        this.flags = new Int32Array(this.sab, offset, 256);

        // Float view of the same flags buffer for passing float parameters
        this.floatParams = new Float32Array(this.sab, offset, 256);
    }
}
