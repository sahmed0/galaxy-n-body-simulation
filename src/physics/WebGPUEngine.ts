/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { PhysicsEngine, PhysicsParams, InitialConditionType } from './types';
import shaderWGSL from './shaders.wgsl?raw'; // Vite import for raw string

/**
 * A highly optimised physics engine relying on WebGPU Compute Shaders.
 * Calculates N-Body gravity off the main thread and pipes directly into the render queue.
 */
export class WebGPUEngine implements PhysicsEngine {
    private canvas: HTMLCanvasElement;
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private pipeline: GPUComputePipeline | null = null;
    private renderPipeline: GPURenderPipeline | null = null;

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

    private bindGroupLayoutCompute: GPUBindGroupLayout | null = null;
    private bindGroupLayoutRender: GPUBindGroupLayout | null = null;
    private bindGroupParams: GPUBindGroup | null = null;

    private lastDispatchTimeMs = 0;

    constructor() {
        // Create Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'webgpu-canvas';
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.canvas.style.position = 'fixed'; // Must be fixed, not absolute, to match CSS
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.display = 'none'; // Hidden by default
        document.body.appendChild(this.canvas);
    }

    /**
     * Bootstraps the WebGPU device, canvas context, and constructs the rendering pipelines.
     * @param n - Application's planned element count for memory sizing limits.
     * @param initialState - Base data tracking velocities, weights, and colours.
     * @param activeCount - Threshold parameter separating calculated Heavy components from passive objects.
     */
    async init(n: number, initialState: InitialConditionType, activeCount: number = 0) {
        if (!navigator.gpu) {
            console.error("WebGPU not supported on this browser.");
            return;
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.error("Request Adapter: No WebGPU adapter found.");
            return;
        }

        this.device = await adapter.requestDevice({ label: 'WebGPUEngine Device' });
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

        console.log("WebGPU Initialized");

        this.setParticles(n, initialState, activeCount);
    }

    /**
     * Initialises and writes physical elements directly into GPU internal buffer state.
     * Overwrites memory directly by passing arrays sequentially instead of struct-of-arrays representation.
     * @param n - Defined number of simulated particles to initialise.
     * @param initialState - Original configuration source struct to extract details from.
     * @param activeCount - High mass element tracking boundary.
     */
    setParticles(n: number, initialState: InitialConditionType, activeCount: number) {
        if (!this.device) return;
        this.count = n;
        this.activeCount = activeCount;

        console.log(`[WebGPUEngine] Set particles: ${n}, Active Heavy: ${this.activeCount}`);

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
     * Flushes local configuration variables (e.g., zoom, dt, mass rules) to WebGPU Unifoms, 
     * making sure the compute shaders can evaluate state with the newest boundaries.
     * @param dt - Delta time multiplier.
     * @param params - Reference standard config object carrying runtime simulation tuning.
     */
    updateUniforms(dt: number, params: PhysicsParams) {
        if (!this.device || !this.context) return;

        const useActivePassiveVal = params.useActivePassive ? 1.0 : 0.0;

        // Resize WebGPU Canvas if needed
        if (this.canvas.width !== window.innerWidth || this.canvas.height !== window.innerHeight) {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
            // Need to reconfigure context if canvas size changes
            this.context?.configure({
                device: this.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'premultiplied',
            });
        }

        const uniformData = new Float32Array([
            params.gravity,
            dt,
            params.softening,
            this.count,
            this.activeCount,
            useActivePassiveVal,
            params.theta || 1.0,
            params.dmStrength || 0.0,
            params.cameraX || 0,
            params.cameraY || 0,
            params.cameraZoom || 1,
            params.cameraTilt || 0.6,
            this.canvas.width,
            this.canvas.height,
            params.dmCoreRadius || 50.0,
            params.blackHoleMass || 0.0,
            params.blackHoleSoftening || params.softening,
            0.0, // pad1
            0.0, // pad2
            0.0  // pad3
        ]);
        this.device.queue.writeBuffer(this.bufferParams!, 0, uniformData);
    }

    /**
     * Re-encodes compute commands directly into the WebGPU render API.
     * Toggles read/write Ping-Pong buffers automatically per loop execution.
     * @param dt - Unused delta duration inside function logic (transferred via updateUniforms).
     * @param params - Configuration parameter blocks evaluating runtime features.
     */
    update(dt: number, params: PhysicsParams) {
        if (!this.device || !this.pipeline || !this.renderPipeline || !this.context) return;
        if (!this.bindGroupComputeA || !this.bindGroupComputeB) return;
        if (!this.bindGroupRenderA || !this.bindGroupRenderB) return;

        // 1. Update Uniforms
        this.updateUniforms(dt, params);
        // 2. Encode Commands
        const commandEncoder = this.device.createCommandEncoder({ label: 'Command Encoder' });

        // -- COMPUTE PASS --
        const computePass = commandEncoder.beginComputePass({ label: 'Compute Pass' });
        computePass.setPipeline(this.pipeline);

        // Bind Params (Group 0)
        computePass.setBindGroup(0, this.bindGroupParams!);

        // Determine compute bind group
        // Step 0: Read A, Write B. (Even)
        const bgCompute = (this.simStep % 2 === 0) ? this.bindGroupComputeA : this.bindGroupComputeB;
        computePass.setBindGroup(1, bgCompute!);

        const workgroupCount = Math.ceil(this.count / 64);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();

        // -- RENDER PASS --
        // Render the buffer that was just written to (particlesOut).
        // The render pipeline uses the exact same bind group layout as the compute pipeline.
        // Therefore, binding the same group used for compute allows the vertex shader 
        // to natively read the `particlesOut` storage buffer as its input.

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

        // Bind Group 0 (Params)
        // WebGPU validation requires all bind groups declared in the shader layout to be bound, 
        // even if the specific entry point (e.g. fragment shader) does not actively reference them.
        renderPass.setBindGroup(0, this.bindGroupParams!);

        // Determine render bind group
        // If step 0: Read A, Wrote B. So new state is in B.
        // We render what we just wrote.
        const bgRender = (this.simStep % 2 === 0) ? this.bindGroupRenderB : this.bindGroupRenderA;

        renderPass.setBindGroup(1, bgRender);

        // Draw 6 vertices per instance, with this.count instances
        renderPass.draw(6, this.count);
        renderPass.end();

        const start = performance.now();
        this.device.queue.submit([commandEncoder.finish()]);

        this.device.queue.onSubmittedWorkDone().then(() => {
            const end = performance.now();
            this.lastDispatchTimeMs = end - start;
        });

        // Swap for next frame
        this.simStep++;
    }

    /**
     * Extracts telemetry tracking GPU hardware processing times per compute pass.
     * @returns Duration in milliseconds simulating the last iteration sequence.
     */
    getLastDispatchTime(): number {
        return this.lastDispatchTimeMs;
    }

    /**
     * Computes the approximate RAM utilized across VRAM buffer pools.
     * @returns Byte count scaled upward to Megabytes.
     */
    getMemoryUsageMB(): number {
        if (!this.bufferParticlesA || !this.bufferProps) return 0;
        const totalBytes = this.bufferParticlesA.size * 2 + this.bufferProps.size;
        return totalBytes / (1024 * 1024);
    }

    /**
     * An anti-pattern interface override returning zero (GPU coordinates remain on-device).
     * @returns Fake empty array for interface compatibility. 
     */
    getPositions(): Float32Array {
        return new Float32Array(0);
    }

    /**
     * An anti-pattern interface override returning zero (GPU coordinates remain on-device).
     * @returns Fake empty array for interface compatibility.
     */
    getVelocities(): Float32Array {
        return new Float32Array(0);
    }

    /**
     * Modifies the internal layout visibility attribute.
     * @param visible - Target presentation tracking status.
     */
    setVisible(visible: boolean) {
        this.canvas.style.display = visible ? 'block' : 'none';
    }
}
