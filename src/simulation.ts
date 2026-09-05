/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager } from './state';
import { setupUI, updateTelemetry, setupInteractions } from './ui';
import { parsePermalink, randomUint32 } from './utils';
import './global.css';
import './style.css';
import './ui/ui.css';
// Self-hosted fonts no runtime CDN under COEP.
import '@fontsource/ibm-plex-sans/300.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/space-grotesk/300.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@kiwicarbon/assets/dist/kiwi.css';

/**
 * Draws a static deep space background with pinpoint stars on the bg-canvas.
 */
function drawSpaceBackground() {
  const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement;
  if (!bgCanvas) return;
  const ctx = bgCanvas.getContext('2d');
  if (!ctx) return;

  // Deliberately drawn at 1x device pixels (no DPR scaling): this is a blurred, static
  // starfield backdrop where per-pixel crispness is imperceptible and the extra fill cost isn't worth it.
  const width = window.innerWidth * 1.2;
  const height = window.innerHeight * 1.2;
  bgCanvas.width = width;
  bgCanvas.height = height;

  ctx.fillStyle = '#000000ff';
  ctx.fillRect(0, 0, width, height);

  const numStars = 1000 + Math.random() * 1500;
  for (let i = 0; i < numStars; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const size = Math.random() > 0.95 ? 2 : 1; // Make 2x2 much rarer
    const opacity = 0.05 + Math.random() * 0.55; // 0.05 to 0.6
    ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    ctx.fillRect(x, y, size, size);
  }
}

// Cross-Origin Isolation enables zero-copy SharedArrayBuffer, which the worker engine needs.
// The app runs fine without it: PhysicsMemory falls back to a plain ArrayBuffer and the worker
// option is disabled. Log the state for diagnostics only - never block startup.
console.info(`Cross-origin isolated: ${crossOriginIsolated}`);

const CANVAS_ID = 'sim-canvas';

/**
 * Main application bootstrapper. Instantiates the physics manager, hooks up UI event listeners,
 * and enters the infinite render loop.
 */
async function startApp() {
  drawSpaceBackground();
  window.addEventListener('resize', drawSpaceBackground);

  const simManager = new SimulationManager();

  // A permalink pins the realization and the parameters that shape it; anything absent
  // or malformed keeps its default. This must run before init(): initGalaxy() reads
  // count/preset and init() selects the engine, so none of it can be applied afterwards.
  // A permalinked engine needs no special handling - it lands in params pre-init and the
  // existing WebGPU-fallback path in init() covers it exactly as it covers the default.
  // The hash is left on the URL so the link stays re-copyable. Camera is not encoded.
  const link = parsePermalink(location.hash);
  // Explicit `!== undefined` throughout: seed 0 and dmStrength 0 are both legitimate
  // values and both falsy.
  if (link.engine !== undefined) simManager.params.engineType = link.engine;
  if (link.count !== undefined) simManager.params.count = link.count;
  if (link.preset !== undefined) simManager.params.preset = link.preset;
  if (link.gravity !== undefined) simManager.params.gravity = link.gravity;
  if (link.dmStrength !== undefined) simManager.params.dmStrength = link.dmStrength;
  simManager.setSeed(link.seed ?? randomUint32());

  // Set telemetry callback before init so it's ready, but it's used in loop
  simManager.onTelemetry = updateTelemetry;

  // Parallax the background canvas against the camera each frame. Kept in the entry
  // layer (not SimulationManager) so the state layer never touches the DOM.
  const bgCanvas = document.getElementById('bg-canvas');
  if (bgCanvas) {
    simManager.onFrame = (sim) => {
      const camera = sim.renderer.camera;
      const pPanFactor = 0.05;
      const pZoomFactor = 0.15;
      let bgScale = 1.0 + (camera.zoom - 1.0) * pZoomFactor;
      if (bgScale < 0.83) bgScale = 0.83;

      const bgX = camera.x * pPanFactor;
      const bgY = camera.y * camera.tilt * pPanFactor;
      bgCanvas.style.transform = `translate(${bgX}px, ${bgY}px) scale(${bgScale})`;
    };
  }

  await simManager.init(CANVAS_ID);

  // Expose the manager for the Playwright smoke tests (and handy for manual console
  // debugging). Deliberate and inert - nothing in the app reads it back.
  (window as unknown as { __sim: SimulationManager }).__sim = simManager;

  setupUI(simManager);
  setupInteractions(simManager);

  simManager.startLoop();

  // Opt-in performance harness: `sim.html?bench` pulls in the bench overlay as a
  // separate async chunk, keeping it out of the main bundle for normal visitors.
  if (new URLSearchParams(location.search).has('bench')) {
    const { initBench } = await import('./bench/benchmark');
    initBench(simManager);
  }
}

startApp();
