/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { SimulationManager } from './state';
import { setupUI, updateTelemetry, setupInteractions } from './ui';
import './global.css';
import './style.css';
import './ui/ui.css';

/**
 * Draws a static deep space background with pinpoint stars on the bg-canvas.
 */
function drawSpaceBackground() {
  const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement;
  if (!bgCanvas) return;
  const ctx = bgCanvas.getContext('2d');
  if (!ctx) return;

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

  // Set telemetry callback before init so it's ready, but it's used in loop
  simManager.onTelemetry = updateTelemetry;

  await simManager.init(CANVAS_ID);

  setupUI(simManager);
  setupInteractions(simManager);

  simManager.startLoop();
}

startApp();
