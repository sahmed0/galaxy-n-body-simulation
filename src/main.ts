/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager, presetDmDefault } from './state';
import { setupUI, updateTelemetry, setupInteractions } from './ui';
import { parsePermalink, randomUint32 } from './utils';
import { Starfield } from './rendering';
import { TopBar } from './ui/TopBar';
import { Sidebar } from './ui/Sidebar';
import { AboutPanel } from './ui/AboutPanel';
import './ui/tokens.css';
import './global.css';
import './ui/ui.css';
// Self-hosted fonts - no runtime CDN under COEP.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@kiwicarbon/assets/dist/kiwi.css';

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
  const about = new AboutPanel();
  const topBar = new TopBar({ onToggleSidebar: () => sidebar.toggle(), onAbout: () => about.toggle() });
  const sidebar = new Sidebar({ onChange: (open) => topBar.setSidebarExpanded(open) });

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
  if (link.preset !== undefined) {
    simManager.params.preset = link.preset;
    // Mirror the preset <select> handler, which resets the halo to the preset's default
    // on every change. Without this a hand-written #p=accretion with no dm= boots an
    // accretion disk inside the galaxy's halo - a state the UI cannot produce. An
    // explicit dm= still wins: it is applied after this.
    simManager.params.dmStrength = presetDmDefault(link.preset);
  }
  if (link.gravity !== undefined) simManager.params.gravity = link.gravity;
  if (link.dmStrength !== undefined) simManager.params.dmStrength = link.dmStrength;
  simManager.setSeed(link.seed ?? randomUint32());

  // Set telemetry callback before init so it's ready, but it's used in loop
  simManager.onTelemetry = updateTelemetry;

  // Parallax the starfield against the camera each frame. Kept in the entry layer
  // (not SimulationManager) so the state layer never touches the DOM.
  const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement | null;
  if (bgCanvas) {
    const starfield = new Starfield(bgCanvas);
    simManager.onFrame = (sim) => starfield.update(sim.renderer.camera);
  }

  await simManager.init(CANVAS_ID);

  // Expose the manager for the Playwright smoke tests (and handy for manual console
  // debugging). Deliberate and inert - nothing in the app reads it back.
  (window as unknown as { __sim: SimulationManager }).__sim = simManager;

  setupUI(simManager);
  setupInteractions(simManager);

  simManager.startLoop();

  // Opt-in performance harness: `/?bench` pulls in the bench overlay as a
  // separate async chunk, keeping it out of the main bundle for normal visitors.
  if (new URLSearchParams(location.search).has('bench')) {
    const { initBench } = await import('./bench/benchmark');
    initBench(simManager);
  }
}

startApp();
