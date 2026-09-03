/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import type { SimulationManager } from '../state';

/** Redraw cadence while open. Samples land at ≤1/s, so most ticks are a no-op compare. */
const UPDATE_INTERVAL_MS = 250;
/**
 * Floor on the plot's half-range. Without it a perfectly-conserved trace (ΔE/E₀ ~ 1e-16,
 * i.e. float noise) would be auto-scaled up into a dramatic-looking wiggle.
 */
const SCALE_FLOOR = 1e-5;
/** Inset of the trace from the plot edges, in CSS px. */
const PLOT_PADDING = 6;

/**
 * The collapsible ΔE/E₀ panel: the one place the app shows its own physics being
 * checked. Plots the fractional energy drift of the active subsystem against the
 * baseline E₀, plus net momentum and a sample count.
 *
 * Ownership: the panel owns only its visibility and its redraw timer. The *schedule*
 * of the underlying measurement belongs to {@link SimulationManager}; opening the
 * panel just sets `sim.energyEnabled`, which is what makes a closed panel free.
 *
 * The panel deliberately reads nothing off `sim` in its constructor - every read
 * happens in {@link draw}, re-derived each time. That matters most for the GPU N/A
 * state: the default engine is `webgpu` and may fall back to a CPU engine
 * *asynchronously*, so a value cached at construction would be wrong.
 */
export class EnergyPanel {
    /** The panel's root element. Public so the outside-click handler can test containment. */
    readonly root: HTMLElement;

    private readonly plot: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D | null;
    private readonly naEl: HTMLElement;
    private readonly deltaEl: HTMLElement;
    private readonly e0El: HTMLElement;
    private readonly pxEl: HTMLElement;
    private readonly pyEl: HTMLElement;
    private readonly countEl: HTMLElement;

    private readonly sim: SimulationManager;
    private readonly onResize: () => void;
    private timer: number | null = null;
    private open_ = false;
    private lastRevision = -1;
    private lastGpu: boolean | null = null;
    private dpr = 1;
    private cssW = 0;
    private cssH = 0;

    /**
     * Builds the panel and mounts it (hidden) on `document.body`.
     * @param sim - The manager to measure. Stored only; nothing is read from it here.
     */
    constructor(sim: SimulationManager) {
        this.sim = sim;

        const root = document.createElement('div');
        root.id = 'energy-panel';
        root.className = 'tactical-glass energy-panel';
        root.innerHTML = `
            <h2 class="energy-title">Energy conservation</h2>
            <div class="energy-plot-wrap">
                <canvas id="energy-plot" class="energy-plot"></canvas>
                <p id="energy-na" class="energy-na">N/A - particle state resides on GPU</p>
            </div>
            <div class="telemetry-row"><span class="telemetry-label">ΔE/E₀</span><span id="energy-delta" class="telemetry-value">-</span></div>
            <div class="telemetry-row"><span class="telemetry-label">E₀</span><span id="energy-e0" class="telemetry-value">-</span></div>
            <div class="telemetry-row"><span class="telemetry-label">Σpₓ</span><span id="energy-px" class="telemetry-value">-</span></div>
            <div class="telemetry-row"><span class="telemetry-label">Σp_y</span><span id="energy-py" class="telemetry-value">-</span></div>
            <div class="telemetry-row"><span class="telemetry-label">SAMPLES</span><span id="energy-count" class="telemetry-value">0</span></div>
        `;
        document.body.appendChild(root);
        this.root = root;

        // Every `!` below is provably safe: the literal template above is the only source
        // of this subtree, and each id appears in it.
        this.plot = root.querySelector<HTMLCanvasElement>('#energy-plot')!;
        this.naEl = root.querySelector<HTMLElement>('#energy-na')!;
        this.deltaEl = root.querySelector<HTMLElement>('#energy-delta')!;
        this.e0El = root.querySelector<HTMLElement>('#energy-e0')!;
        this.pxEl = root.querySelector<HTMLElement>('#energy-px')!;
        this.pyEl = root.querySelector<HTMLElement>('#energy-py')!;
        this.countEl = root.querySelector<HTMLElement>('#energy-count')!;
        this.ctx = this.plot.getContext('2d');

        this.onResize = () => {
            if (!this.open_) return;
            this.resizePlot();
            this.draw();
        };
        window.addEventListener('resize', this.onResize);
    }

    /** Whether the panel is currently shown. */
    get isOpen(): boolean {
        return this.open_;
    }

    /** Shows the panel and starts measuring. */
    open(): void {
        if (this.open_) return;
        this.open_ = true;
        // Apply the class first: the plot has no box (and getBoundingClientRect returns
        // zeros) while the panel is display:none. Reading layout after the class change
        // forces the reflow, so resizePlot measures the real box in this same tick.
        this.root.classList.add('ui-active');
        this.sim.energyEnabled = true;
        this.resizePlot();
        this.draw();
        this.timer = window.setInterval(() => this.update(), UPDATE_INTERVAL_MS);
    }

    /** Hides the panel and stops measuring (the manager drops any in-flight cycle). */
    close(): void {
        if (!this.open_) return;
        this.open_ = false;
        this.root.classList.remove('ui-active');
        this.sim.energyEnabled = false;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Toggles the panel's visibility. */
    toggle(): void {
        if (this.open_) this.close();
        else this.open();
    }

    /**
     * Redraws, but only if there is something new to show: the monitor's revision counter
     * changes on a new sample or a baseline reset, and the engine may have swapped to or
     * from the GPU. At ≤1 sample/s this is a pointer compare three ticks in four.
     */
    update(): void {
        if (!this.open_) return;
        const gpu = this.sim.engine.kind === 'self-rendering';
        if (this.sim.energyMonitor.revision === this.lastRevision && gpu === this.lastGpu) return;
        this.draw();
    }

    /** Removes the panel from the DOM and releases its timer and listeners. */
    dispose(): void {
        this.close();
        window.removeEventListener('resize', this.onResize);
        this.root.remove();
    }

    /**
     * Matches the canvas backing store to its CSS box at the current DPR.
     * @returns False when the box has no area (panel hidden, or a layout-free test DOM),
     *   in which case nothing was measured and the caller must not draw.
     */
    private resizePlot(): boolean {
        const rect = this.plot.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // Same DPR cap as CanvasRenderer: bounds fill cost on mobile.
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.plot.width = Math.round(rect.width * this.dpr);
        this.plot.height = Math.round(rect.height * this.dpr);
        this.cssW = rect.width;
        this.cssH = rect.height;
        // Unlike CanvasRenderer, the CSS box is not pinned here: the stylesheet owns it.
        return true;
    }

    /** Renders the readouts and the trace from the monitor's current history. */
    private draw(): void {
        const gpu = this.sim.engine.kind === 'self-rendering';
        this.lastGpu = gpu;
        this.lastRevision = this.sim.energyMonitor.revision;

        if (gpu) {
            // No readback exists for the GPU engine, so the monitor is idle. Leaving the
            // last CPU numbers on screen under an "N/A" plot would read as live data.
            this.plot.style.display = 'none';
            this.naEl.classList.add('energy-na-active');
            this.deltaEl.textContent = '-';
            this.e0El.textContent = '-';
            this.pxEl.textContent = '-';
            this.pyEl.textContent = '-';
            this.countEl.textContent = '0';
            return;
        }

        this.plot.style.display = '';
        this.naEl.classList.remove('energy-na-active');

        const m = this.sim.energyMonitor;
        const e0 = m.baselineEnergy();
        const hist = m.history();
        const delta = m.deltaE0();

        this.deltaEl.textContent = delta === null ? '-' : sci(delta, 1);
        this.e0El.textContent = e0 === null ? '-' : sci(e0, 2);
        this.pxEl.textContent = m.lastSample === null ? '-' : sci(m.lastSample.px, 1);
        this.pyEl.textContent = m.lastSample === null ? '-' : sci(m.lastSample.py, 1);
        this.countEl.textContent = m.sampleCount.toString();

        this.drawPlot(hist.map((s) => s.E), e0);
    }

    /**
     * Draws the zero line and the ΔE/E₀ trace, auto-scaled symmetrically about zero.
     * @param energies - Sample energies, oldest first.
     * @param e0 - The baseline energy, or null when there is no baseline yet.
     */
    private drawPlot(energies: readonly number[], e0: number | null): void {
        const ctx = this.ctx;
        if (!ctx) return;
        if (this.cssW === 0 || this.cssH === 0) {
            // First paint after open() on a zero-area box (or a layout-free test DOM).
            if (!this.resizePlot()) return;
        }

        const w = this.cssW;
        const h = this.cssH;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Zero line: the value a perfectly conserved system holds.
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        if (e0 === null || e0 === 0 || energies.length < 2) return;

        const series = energies.map((E) => (E - e0) / Math.abs(e0));
        let scale = SCALE_FLOOR;
        for (const r of series) scale = Math.max(scale, Math.abs(r));

        const halfH = h / 2 - PLOT_PADDING;
        const span = w - 2 * PLOT_PADDING;
        ctx.strokeStyle = '#00aaff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = 0; k < series.length; k++) {
            const x = PLOT_PADDING + (k * span) / Math.max(1, series.length - 1);
            const y = h / 2 - (series[k] / scale) * halfH;
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
}

/**
 * Formats a value in signed scientific notation for the readouts.
 * @param v - The value.
 * @param digits - Digits after the decimal point.
 * @returns e.g. `-3.2e-4`, or `-` if the value is not finite.
 */
function sci(v: number, digits: number): string {
    return Number.isFinite(v) ? v.toExponential(digits) : '-';
}
