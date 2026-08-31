/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { SelfRenderingEngine, PhysicsParams, InitialConditionType } from './types';
import shaderWGSL from './shaders.wgsl?raw'; // Vite import for raw string

/**
 * Thrown by {@link WebGPUEngine.init} when the platform cannot provide a usable
 * WebGPU device: `navigator.gpu` is missing, no adapter is returned, or device
 * creation fails. Lets callers distinguish "WebGPU is unavailable, fall back to
 * a CPU engine" from a generic, possibly transient error.
 */
export class WebGPUUnavailableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'WebGPUUnavailableError';
    }
}

/** One labeled entry of the `Params` uniform block: a field name paired with its value. */
export interface UniformField {
    name: string;
    value: number;
}

/**
 * Single source of truth for the uniform write order. Each entry pairs a field name with its
 * value; {@link WebGPUEngine.updateUniforms} maps this to the flat `Float32Array` it uploads.
 * The order - and the `vecN` component names (`cameraPos.x`/`.y`, `canvasSize.x`/`.y`) - must
 * mirror the `Params` struct in `shaders.wgsl`. `tests/gpu/uniform-layout.test.ts` parses that
 * struct, computes WGSL byte offsets, and fails if this table ever drifts from the shader.
 */
export function buildUniformFields(
    params: PhysicsParams,
    dt: number,
    count: number,
    activeCount: number,
    canvasWidth: number,
    canvasHeight: number,
): UniformField[] {
    return [
        { name: 'gravity', value: params.gravity },
        { name: 'dt', value: dt },
        { name: 'softening', value: params.softening },
        { name: 'count', value: count },
        { name: 'activeCount', value: activeCount },
        { name: 'useActivePassive', value: params.useActivePassive ? 1.0 : 0.0 },
        { name: 'pad4', value: 0.0 },
        { name: 'dmStrength', value: params.dmStrength || 0.0 },
        { name: 'cameraPos.x', value: params.cameraX || 0 },
        { name: 'cameraPos.y', value: params.cameraY || 0 },
        { name: 'cameraZoom', value: params.cameraZoom || 1 },
        { name: 'cameraTilt', value: params.cameraTilt || 0.6 },
        { name: 'canvasSize.x', value: canvasWidth },
        { name: 'canvasSize.y', value: canvasHeight },
        { name: 'dmCoreRadius', value: params.dmCoreRadius || 50.0 },
        { name: 'blackHoleMass', value: params.blackHoleMass || 0.0 },
        { name: 'blackHoleSoftening', value: params.blackHoleSoftening || params.softening },
        { name: 'pad1', value: 0.0 },
        { name: 'pad2', value: 0.0 },
        { name: 'pad3', value: 0.0 },
    ];
}

/**
 * A highly optimised physics engine relying on WebGPU Compute Shaders.
 * Calculates N-Body gravity off the main thread and pipes directly into the render queue.
 */
export class WebGPUEngine implements SelfRenderingEngine {
    readonly kind = 'self-rendering' as const;
    private canvas: HTMLCanvasElement;
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private pipeline: GPUComputePipeline | null = null;        // naive sim_update
    private pipelineTiled: GPUComputePipeline | null = null;   // workgroup-tiled sim_update_tiled
    private renderPipeline: GPURenderPipeline | null = null;

    /**
     * Which compute kernel step() dispatches. The tiled kernel stages sources in
     * workgroup memory and is the default; 'naive' is kept for the bench parity check.
     */
    public kernelMode: 'tiled' | 'naive' = 'tiled';

    // Buffers
    private bufferParams: GPUBuffer | null = null;
    private bufferParticlesA: GPUBuffer | null = null; // Ping
    private bufferParticlesB: GPUBuffer | null = null; // Pong
    private bufferProps: GPUBuffer | null = null;      // Masses & Colours

    private bindGroupComputeA: GPUBindGroup | null = null;
    private bindGroupComputeB: GPUBindGroup | null = null;
    private bindGroupRenderA: GPUBindGroup | null = null;
    private bindGroupRenderB: GPUBindGroup | null = null;

    private simStep = 0;
    private count = 0;
    private activeCount = 0; // Number of heavy particles
    private lastUseActivePassive = false; // Mirrors the last uploaded uniform, for interaction counting

    private bindGroupLayoutCompute: GPUBindGroupLayout | null = null;
    private bindGroupLayoutRender: GPUBindGroupLayout | null = null;
    private bindGroupParams: GPUBindGroup | null = null;

    private lastDispatchTimeMs = 0;

    // --- GPU-pass timing via timestamp-query (falls back to wall-clock) ---
    private hasTimestamp = false;
    private querySet: GPUQuerySet | null = null;
    private queryResolveBuffer: GPUBuffer | null = null;
    private queryStagingBuffer: GPUBuffer | null = null;
    private lastGpuPassMs = 0;
    private lastGpuPassSource: 'timestamp' | 'approx' = 'approx';
    private lastTimestampReadMs = 0;
    private mapPending = false;
    private static readonly TIMESTAMP_INTERVAL_MS = 250;

    /**
     * Invoked when the GPU device is lost *after* a successful init (driver reset,
     * GPU removed, browser policy, OOM). Not fired for an intentional teardown.
     * The owner (SimulationManager) sets this so it can fall back to a CPU engine.
     */
    onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null = null;

    constructor() {
        // Create Canvas. Backing store is sized in physical pixels (CSS size x dpr) for HiDPI
        // crispness; the shader compensates by scaling cameraZoom by dpr (see updateUniforms).
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'webgpu-canvas';
        this.canvas.width = Math.round(window.innerWidth * dpr);
        this.canvas.height = Math.round(window.innerHeight * dpr);
        this.canvas.style.position = 'fixed'; // Must be fixed, not absolute, to match CSS
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = window.innerWidth + 'px';
        this.canvas.style.height = window.innerHeight + 'px';
        this.canvas.style.display = 'none'; // Hidden by default
        document.body.appendChild(this.canvas);
    }

    /**
     * Drops references to every per-device GPU object so a subsequent {@link init}
     * rebuilds them from scratch. Called at the start of init() so the engine can
     * be re-initialised on the same instance (and same canvas) to recover from a
     * device loss. The dead device's resources are freed implicitly with the
     * device, so we only need to forget them here.
     */
    private resetGpuResources() {
        this.device = null;
        this.context = null;
        this.pipeline = null;
        this.pipelineTiled = null;
        this.renderPipeline = null;
        this.querySet = null;
        this.queryResolveBuffer = null;
        this.queryStagingBuffer = null;
        this.hasTimestamp = false;
        this.mapPending = false;
        this.bufferParams = null;
        this.bufferParticlesA = null;
        this.bufferParticlesB = null;
        this.bufferProps = null;
        this.bindGroupComputeA = null;
        this.bindGroupComputeB = null;
        this.bindGroupRenderA = null;
        this.bindGroupRenderB = null;
        this.bindGroupLayoutCompute = null;
        this.bindGroupLayoutRender = null;
        this.bindGroupParams = null;
        this.simStep = 0;
    }

    /**
     * Bootstraps the WebGPU device, canvas context, and constructs the rendering pipelines.
     * @param n - Application's planned element count for memory sizing limits.
     * @param initialState - Base data tracking velocities, weights, and colours.
     * @param activeCount - Threshold parameter separating calculated Heavy components from passive objects.
     */
    async init(n: number, initialState: InitialConditionType, activeCount: number = 0) {
        // Drop any prior per-device resources so init() can run from scratch. This
        // makes it safe to call again to re-create the device after a loss: without
        // it, setParticles() would short-circuit buffer recreation and the bind
        // groups would still reference the dead device's buffers.
        this.resetGpuResources();

        if (!navigator.gpu) {
            throw new WebGPUUnavailableError('navigator.gpu is missing (WebGPU not supported or disabled).');
        }

        let adapter: GPUAdapter | null;
        try {
            adapter = await navigator.gpu.requestAdapter();
        } catch (err) {
            throw new WebGPUUnavailableError('navigator.gpu.requestAdapter() threw.', { cause: err });
        }
        if (!adapter) {
            throw new WebGPUUnavailableError('No WebGPU adapter available.');
        }

        // 'timestamp-query' gives real GPU-pass durations. Optional: request it only when
        // the adapter advertises it, and fall back to wall-clock timing when it is absent.
        this.hasTimestamp = adapter.features.has('timestamp-query');
        try {
            this.device = await adapter.requestDevice({
                label: 'WebGPUEngine Device',
                requiredFeatures: this.hasTimestamp ? ['timestamp-query'] : [],
            });
        } catch (err) {
            throw new WebGPUUnavailableError('adapter.requestDevice() failed.', { cause: err });
        }

        // Surface a post-init device loss (driver reset, GPU removed, OOM, browser
        // policy) to the owner so it can fall back to a CPU engine. A 'destroyed'
        // reason is an intentional teardown and is deliberately ignored.
        this.device.lost.then((info) => {
            if (info.reason === 'destroyed') return;
            console.error(`WebGPU device lost: ${info.reason} - ${info.message}`);
            // Drop the dead device so any step()/render() that fire before the
            // owner recovers no-op via the existing `!this.device` guards rather
            // than issuing commands against a lost device.
            this.device = null;
            this.onDeviceLost?.(info);
        });

        // Promote otherwise-silent GPU validation / out-of-memory errors so they
        // are not swallowed into a blank canvas.
        this.device.addEventListener('uncapturederror', (event) => {
            console.error('WebGPU uncaptured error:', (event as GPUUncapturedErrorEvent).error);
        });

        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;

        const format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: format,
            alphaMode: 'premultiplied',
        });

        // Params Buffer
        this.bufferParams = this.device.createBuffer({
            label: 'Params Buffer',
            size: 20 * 4, // 20 floats (80 bytes) maintaining strict 16-byte WGSL alignment
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const bindGroupLayoutParams = this.device.createBindGroupLayout({
            label: 'Bind Group Layout Params',
            entries: [{
                binding: 0,
                // Params are used in Compute and Vertex
                visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' }
            }]
        });

        this.bindGroupLayoutCompute = this.device.createBindGroupLayout({
            label: 'Bind Group Layout Compute',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
            ]
        });

        this.bindGroupLayoutRender = this.device.createBindGroupLayout({
            label: 'Bind Group Layout Render',
            entries: [
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
            ]
        });

        const pipelineLayoutCompute = this.device.createPipelineLayout({
            label: 'Pipeline Layout Compute',
            bindGroupLayouts: [bindGroupLayoutParams, this.bindGroupLayoutCompute]
        });

        const pipelineLayoutRender = this.device.createPipelineLayout({
            label: 'Pipeline Layout Render',
            bindGroupLayouts: [bindGroupLayoutParams, this.bindGroupLayoutRender]
        });

        const shaderModule = this.device.createShaderModule({ label: 'Simulation Shader Module', code: shaderWGSL });

        this.pipeline = await this.device.createComputePipelineAsync({
            label: 'Compute Pipeline (Sim Update)',
            layout: pipelineLayoutCompute,
            compute: { module: shaderModule, entryPoint: 'sim_update' },
        });

        // Tiled kernel shares the compute pipeline layout (workgroup memory needs no
        // layout change); step() picks between the two via kernelMode.
        this.pipelineTiled = await this.device.createComputePipelineAsync({
            label: 'Compute Pipeline (Sim Update Tiled)',
            layout: pipelineLayoutCompute,
            compute: { module: shaderModule, entryPoint: 'sim_update_tiled' },
        });

        // Timestamp-query resources: a 2-entry query set (pass begin/end) resolved into
        // a buffer, then copied to a mappable staging buffer for async read-back.
        if (this.hasTimestamp) {
            this.querySet = this.device.createQuerySet({ type: 'timestamp', count: 2 });
            this.queryResolveBuffer = this.device.createBuffer({
                label: 'Timestamp Resolve Buffer',
                size: 16, // 2 x u64
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
            this.queryStagingBuffer = this.device.createBuffer({
                label: 'Timestamp Staging Buffer',
                size: 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }

        this.renderPipeline = await this.device.createRenderPipelineAsync({
            label: 'Render Pipeline',
            layout: pipelineLayoutRender,
            vertex: { module: shaderModule, entryPoint: 'vs_main' },
            fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });

        this.bindGroupParams = this.device.createBindGroup({
            label: 'Bind Group Params',
            layout: bindGroupLayoutParams,
            entries: [{ binding: 0, resource: { buffer: this.bufferParams } }],
        });

        this.setParticles(n, initialState, activeCount);
    }

    /**
     * Uploads `n` bodies from a CPU {@link PhysicsState} into the GPU particle
     * buffers, packing position+velocity and the per-body properties into the two
     * vec4 layouts the compute shader expects.
     * @param n - Number of bodies to upload.
     * @param initialState - Source SoA arrays to read from.
     * @param activeCount - Number of leading heavy (field-generating) bodies.
     */
    setParticles(n: number, initialState: InitialConditionType, activeCount: number) {
        if (!this.device) return;
        this.count = n;
        this.activeCount = activeCount;

        const dataPosVel = new Float32Array(n * 4);
        const dataProps = new Float32Array(n * 4);

        for (let i = 0; i < n; i++) {
            dataPosVel[i * 4 + 0] = initialState.positionX[i];
            dataPosVel[i * 4 + 1] = initialState.positionY[i];
            dataPosVel[i * 4 + 2] = initialState.velocityX[i];
            dataPosVel[i * 4 + 3] = initialState.velocityY[i];

            dataProps[i * 4 + 0] = initialState.mass[i];
            dataProps[i * 4 + 1] = initialState.colors[i * 3 + 0];
            dataProps[i * 4 + 2] = initialState.colors[i * 3 + 1];
            dataProps[i * 4 + 3] = initialState.colors[i * 3 + 2];
        }

        const particleBufferSize = dataPosVel.byteLength;
        const propsBufferSize = dataProps.byteLength;

        if (!this.bufferParticlesA || this.bufferParticlesA.size !== particleBufferSize) {
            if (this.bufferParticlesA) this.bufferParticlesA.destroy();
            if (this.bufferParticlesB) this.bufferParticlesB.destroy();
            if (this.bufferProps) this.bufferProps.destroy();

            const usageParticles = GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

            this.bufferParticlesA = this.device.createBuffer({
                label: 'Particles Buffer A',
                size: particleBufferSize,
                usage: usageParticles,
            });

            this.bufferParticlesB = this.device.createBuffer({
                label: 'Particles Buffer B',
                size: particleBufferSize,
                usage: usageParticles,
            });

            this.bufferProps = this.device.createBuffer({
                label: 'Props Buffer',
                size: propsBufferSize,
                usage: usageParticles,
            });

            this.bindGroupComputeA = this.device.createBindGroup({
                label: 'Bind Group Compute A',
                layout: this.bindGroupLayoutCompute!,
                entries: [
                    { binding: 0, resource: { buffer: this.bufferParticlesA } },
                    { binding: 1, resource: { buffer: this.bufferProps } },
                    { binding: 2, resource: { buffer: this.bufferParticlesB } },
                ],
            });

            this.bindGroupComputeB = this.device.createBindGroup({
                label: 'Bind Group Compute B',
                layout: this.bindGroupLayoutCompute!,
                entries: [
                    { binding: 0, resource: { buffer: this.bufferParticlesB } },
                    { binding: 1, resource: { buffer: this.bufferProps } },
                    { binding: 2, resource: { buffer: this.bufferParticlesA } },
                ],
            });

            this.bindGroupRenderA = this.device.createBindGroup({
                label: 'Bind Group Render A',
                layout: this.bindGroupLayoutRender!,
                entries: [
                    { binding: 1, resource: { buffer: this.bufferProps } },
                    { binding: 3, resource: { buffer: this.bufferParticlesA } },
                ],
            });

            this.bindGroupRenderB = this.device.createBindGroup({
                label: 'Bind Group Render B',
                layout: this.bindGroupLayoutRender!,
                entries: [
                    { binding: 1, resource: { buffer: this.bufferProps } },
                    { binding: 3, resource: { buffer: this.bufferParticlesB } },
                ],
            });
        }

        this.device.queue.writeBuffer(this.bufferParticlesA!, 0, dataPosVel);
        this.device.queue.writeBuffer(this.bufferProps!, 0, dataProps);
        this.simStep = 0;
    }

    /**
     * Writes the current frame's parameters (dt, gravity, softening, camera, mass
     * rules, …) into the GPU uniform buffer so the next compute and render pass see
     * up-to-date values. Also resizes the canvas to the window if it changed.
     * @param dt - Time step for this frame.
     * @param params - Runtime simulation parameters to upload.
     */
    updateUniforms(dt: number, params: PhysicsParams) {
        if (!this.device || !this.context) return;

        // Resize WebGPU Canvas if needed. Backing store is CSS size x dpr (physical pixels).
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const physW = Math.round(window.innerWidth * dpr);
        const physH = Math.round(window.innerHeight * dpr);
        if (this.canvas.width !== physW || this.canvas.height !== physH) {
            this.canvas.width = physW;
            this.canvas.height = physH;
            this.canvas.style.width = window.innerWidth + 'px';
            this.canvas.style.height = window.innerHeight + 'px';
            // Need to reconfigure context if canvas size changes
            this.context?.configure({
                device: this.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'premultiplied',
            });
        }

        // canvasSize carries physical pixels, so scale cameraZoom by dpr to map world units to
        // physical pixels uniformly (the shader multiplies both position and point size by zoom).
        // cameraPos is left unscaled: it is subtracted before the zoom multiply in the shader.
        this.lastUseActivePassive = params.useActivePassive;
        const fields = buildUniformFields(params, dt, this.count, this.activeCount,
            this.canvas.width, this.canvas.height);
        const zoomField = fields.find(f => f.name === 'cameraZoom');
        if (zoomField) zoomField.value *= dpr;
        const uniformData = new Float32Array(fields.map(f => f.value));
        this.device.queue.writeBuffer(this.bufferParams!, 0, uniformData);
    }

    /**
     * Advances the simulation by one compute step (no rendering).
     * Toggles the read/write ping-pong buffers and increments simStep so the
     * latest state always lives in the buffer the NEXT step would read from.
     * Decoupled from rendering so the caller can run several fixed-dt sub-steps
     * per displayed frame (frame-rate-independent physics).
     * @param dt - Delta time for this physics step.
     * @param params - Configuration parameter blocks evaluating runtime features.
     */
    step(dt: number, params: PhysicsParams) {
        if (!this.device || !this.pipeline || !this.pipelineTiled) return;
        if (!this.bindGroupComputeA || !this.bindGroupComputeB) return;

        this.updateUniforms(dt, params);

        const pipeline = this.kernelMode === 'tiled' ? this.pipelineTiled : this.pipeline;

        // Throttle timestamp read-back: at most one sample every TIMESTAMP_INTERVAL_MS,
        // and never while a previous map is still pending. On other frames we run a plain
        // dispatch with no query overhead.
        const nowMs = performance.now();
        const sampleTimestamp = this.hasTimestamp && !this.mapPending
            && this.querySet !== null
            && (nowMs - this.lastTimestampReadMs) >= WebGPUEngine.TIMESTAMP_INTERVAL_MS;

        const commandEncoder = this.device.createCommandEncoder({ label: 'Compute Command Encoder' });

        const computePass = commandEncoder.beginComputePass(
            sampleTimestamp
                ? { label: 'Compute Pass', timestampWrites: { querySet: this.querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
                : { label: 'Compute Pass' }
        );
        computePass.setPipeline(pipeline);
        computePass.setBindGroup(0, this.bindGroupParams!);

        // Step 0 (even): read A, write B.
        const bgCompute = (this.simStep % 2 === 0) ? this.bindGroupComputeA : this.bindGroupComputeB;
        computePass.setBindGroup(1, bgCompute!);

        const workgroupCount = Math.ceil(this.count / 64);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();

        if (sampleTimestamp && this.queryResolveBuffer && this.queryStagingBuffer) {
            commandEncoder.resolveQuerySet(this.querySet!, 0, 2, this.queryResolveBuffer, 0);
            commandEncoder.copyBufferToBuffer(this.queryResolveBuffer, 0, this.queryStagingBuffer, 0, 16);
        }

        const start = performance.now();
        this.device.queue.submit([commandEncoder.finish()]);
        this.device.queue.onSubmittedWorkDone().then(() => {
            this.lastDispatchTimeMs = performance.now() - start;
        });

        if (sampleTimestamp && this.queryStagingBuffer) {
            this.lastTimestampReadMs = nowMs;
            this.mapPending = true;
            const staging = this.queryStagingBuffer;
            staging.mapAsync(GPUMapMode.READ).then(() => {
                const times = new BigUint64Array(staging.getMappedRange().slice(0));
                staging.unmap();
                // Timestamps are in nanoseconds; diff and convert to ms.
                const deltaNs = times[1] - times[0];
                this.lastGpuPassMs = Number(deltaNs) / 1e6;
                this.lastGpuPassSource = 'timestamp';
                this.mapPending = false;
            }).catch(() => {
                // Device lost or map failed: drop back to the wall-clock fallback.
                this.mapPending = false;
            });
        }

        // Swap for next step. After incrementing, the latest state is in the
        // buffer the next compute step would READ from.
        this.simStep++;
    }

    /**
     * Renders the current simulation state to the canvas. Safe to call without a
     * preceding step (e.g. when paused or when no physics sub-step ran this frame).
     * @param params - Configuration parameters (camera transform, etc.).
     */
    render(params: PhysicsParams) {
        if (!this.device || !this.renderPipeline || !this.context) return;
        if (!this.bindGroupRenderA || !this.bindGroupRenderB) return;

        // Refresh uniforms so camera changes apply even on frames with no step.
        this.updateUniforms(0, params);

        const commandEncoder = this.device.createCommandEncoder({ label: 'Render Command Encoder' });

        const textureView = this.context.getCurrentTexture().createView({ label: 'Canvas Texture View' });
        const renderPass = commandEncoder.beginRenderPass({
            label: 'Render Pass',
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }, // Transparent background
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        renderPass.setPipeline(this.renderPipeline);
        renderPass.setBindGroup(0, this.bindGroupParams!);

        // The latest written state lives in the buffer the next step would read.
        // After simStep was incremented in step(): even -> A holds latest, odd -> B.
        const bgRender = (this.simStep % 2 === 0) ? this.bindGroupRenderA : this.bindGroupRenderB;
        renderPass.setBindGroup(1, bgRender);

        // Draw 6 vertices per instance, with this.count instances
        renderPass.draw(6, this.count);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }

    /**
     * Wall-clock time the last compute dispatch took to complete, in milliseconds.
     * @returns Duration of the most recent compute pass.
     */
    getLastDispatchTime(): number {
        return this.lastDispatchTimeMs;
    }

    /**
     * Duration of the last measured compute pass. Prefers a real GPU-timeline
     * measurement from timestamp-query when one is fresh; otherwise reports the
     * `onSubmittedWorkDone` wall-clock approximation.
     * @returns The pass duration in ms and which clock produced it.
     */
    getLastGpuPassMs(): { ms: number; source: 'timestamp' | 'approx' } {
        if (this.hasTimestamp && this.lastGpuPassSource === 'timestamp') {
            return { ms: this.lastGpuPassMs, source: 'timestamp' };
        }
        return { ms: this.lastDispatchTimeMs, source: 'approx' };
    }

    /**
     * Exact number of pairwise force interactions the last step evaluated:
     * `count × limit`, where limit is the active-source count (all bodies when
     * active/passive is off). The GPU force loop is dense, so this closed form is exact.
     * @returns Pairwise interactions evaluated in the most recent step.
     */
    getLastInteractionCount(): number {
        const limit = this.lastUseActivePassive ? this.activeCount : this.count;
        return this.count * limit;
    }

    /**
     * Approximate GPU memory held by the particle and property buffers.
     * @returns Buffer footprint in megabytes.
     */
    getMemoryUsageMB(): number {
        if (!this.bufferParticlesA || !this.bufferProps) return 0;
        const totalBytes = this.bufferParticlesA.size * 2 + this.bufferProps.size;
        return totalBytes / (1024 * 1024);
    }

    /**
     * Shows or hides this engine's own canvas.
     * @param visible - Whether the GPU canvas should be displayed.
     */
    setVisible(visible: boolean) {
        this.canvas.style.display = visible ? 'block' : 'none';
    }

    /**
     * Tears the engine down for good: explicitly frees every GPU buffer, destroys
     * the device, and removes the canvas appended in the constructor. Destroying
     * the device resolves `device.lost` with reason `'destroyed'`, which the
     * loss handler in init() deliberately ignores, so this does NOT trigger the
     * CPU-fallback path. Idempotent - safe to call more than once.
     */
    dispose() {
        this.bufferParticlesA?.destroy();
        this.bufferParticlesB?.destroy();
        this.bufferProps?.destroy();
        this.bufferParams?.destroy();
        this.querySet?.destroy();
        this.queryResolveBuffer?.destroy();
        this.queryStagingBuffer?.destroy();
        this.device?.destroy();
        this.canvas.remove();
        // Forget every per-device reference so the instance is inert afterwards.
        this.resetGpuResources();
    }
}
