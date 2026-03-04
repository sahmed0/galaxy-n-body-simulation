/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import './global.css';

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

    const numStars = 2000 + Math.random() * 1500;
    for (let i = 0; i < numStars; i++) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const size = Math.random() > 0.95 ? 2 : 1; // Make 2x2 much rarer
        const opacity = 0.05 + Math.random() * 0.55; // 0.05 to 0.6
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fillRect(x, y, size, size);
    }
}

// Check for Cross-Origin Isolation (Required for SharedArrayBuffer)
if (!crossOriginIsolated) {
    const errorMsg = 'SharedArrayBuffer is not defined. This site requires Cross-Origin Isolation (COOP/COEP headers). verify that the server is sending "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".';
    console.error(errorMsg);
}

function initInteractions() {
    const widgets = document.querySelectorAll('.corner-widget');
    const modal = document.getElementById('info-modal');
    const modalContent = document.getElementById('modal-content');
    const closeBtn = document.getElementById('modal-close');

    if (!modal || !modalContent || !closeBtn) return;

    widgets.forEach(widget => {
        widget.addEventListener('click', () => {
            const targetId = widget.getAttribute('data-target');
            if (!targetId) return;

            const sourceData = document.getElementById(`content-${targetId}`);
            if (sourceData) {
                modalContent.innerHTML = sourceData.innerHTML;
                modal.classList.add('active');
            }
        });
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            modal.classList.remove('active');
        }
    });
}

/**
 * Initialises the landing page by drawing the space background,
 * setting up window resize listeners, and initialising interactions.
 */
export function initLanding() {
    drawSpaceBackground();
    window.addEventListener('resize', drawSpaceBackground);
    initInteractions();
}

initLanding();
