/**
 * Wrapper class managing the SharedArrayBuffer memory allocation for multithreaded workers.
 */
/**
 * Copyright (c) 2026 Sajid Ahmed
 */
export class PhysicsMemory {
    public buffer: SharedArrayBuffer | ArrayBuffer;
    /** True when `buffer` is a SharedArrayBuffer. Only then may the worker use `Atomics.wait`. */
    public readonly isShared: boolean;
    public positionX: Float32Array;
    public positionY: Float32Array;
    public velocityX: Float32Array;
    public velocityY: Float32Array;
    public mass: Float32Array;
    public colors: Float32Array;
    public flags: Int32Array;
    public floatParams: Float32Array;

    // Layout constants
    //
    // `flags` (Int32Array) and `floatParams` (Float32Array) are two views over the SAME 256-slot
    // region at the tail of the buffer. A slot therefore has exactly one meaning - integer OR float -
    // and the two view types must never both claim the same index. Reserved allocation:
    //   int slots   {0, 10, 11}      - status flag + worker heartbeat/timing counters
    //   float slots {1..9, 12..14}   - physics params + worker param passthrough
    // Adding a new slot means picking an index outside both used sets, in the correct view.
    static readonly FLAG_STATUS = 0; // 0: IDLE, 1: COMPUTING
    static readonly STATUS_IDLE = 0;
    static readonly STATUS_COMPUTING = 1;
    // Worker heartbeat/timing counters (int view) and param passthrough (float view).
    static readonly FLAG_STEPS_DONE = 10;          // int: monotonic count of completed steps
    static readonly FLAG_STEP_US = 11;             // int: duration of last step, microseconds
    static readonly PARAM_ACTIVE_COUNT = 12;       // float: activeCount passed to the worker step
    static readonly PARAM_USE_ACTIVE_PASSIVE = 13; // float: useActivePassive flag (0/1)
    static readonly PARAM_INTERACTIONS = 14;       // float: worker's interaction count for the last step

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
            this.buffer = existingSab;
            this.isShared = true;
        } else if (typeof SharedArrayBuffer === 'undefined' || typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated) {
            // No cross-origin isolation: fall back to a plain ArrayBuffer. Every non-worker engine
            // works on it (Atomics.load/store/add operate on non-shared buffers); only Atomics.wait
            // requires shared memory, and that runs solely in the worker (gated on isShared).
            this.buffer = new ArrayBuffer(totalBytes);
            this.isShared = false;
        } else {
            this.buffer = new SharedArrayBuffer(totalBytes);
            this.isShared = true;
        }

        let offset = 0;

        // Create views (Structure of Arrays)
        this.positionX = new Float32Array(this.buffer, offset, n);
        offset += n * 4;
        this.positionY = new Float32Array(this.buffer, offset, n);
        offset += n * 4;

        this.velocityX = new Float32Array(this.buffer, offset, n);
        offset += n * 4;
        this.velocityY = new Float32Array(this.buffer, offset, n);
        offset += n * 4;

        this.mass = new Float32Array(this.buffer, offset, n);
        offset += n * 4;

        this.colors = new Float32Array(this.buffer, offset, n * 3);
        offset += n * 3 * 4;

        // Flags - Int32 for atomic ops
        this.flags = new Int32Array(this.buffer, offset, 256);

        // Float view aliasing the same region - see the layout constants above for the slot map.
        this.floatParams = new Float32Array(this.buffer, offset, 256);
    }
}
