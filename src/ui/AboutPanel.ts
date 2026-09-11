/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import 'katex/dist/katex.min.css';
import renderMathInElement from 'katex/contrib/auto-render';
import { el } from '../utils';
import { mountIcons } from './icons';

/**
 * The right-hand About slide-over: a scrim plus an accordion of the simulation's
 * background sections. Each section opens and closes independently; none open by
 * default. Math is rendered once at construction time - the content never changes,
 * and KaTeX renders hidden nodes fine, so there is nothing to redo on open.
 *
 * `AboutPanel` owns only itself: the info button that toggles it belongs to
 * {@link TopBar}, which calls {@link toggle} through its `onAbout` callback.
 */
export class AboutPanel {
    private readonly panel: HTMLElement;
    private readonly scrim: HTMLElement;
    private readonly closeBtn: HTMLButtonElement;
    private open_ = false;
    private lastFocused: Element | null = null;

    constructor() {
        this.panel = el<HTMLElement>('about-panel');
        this.scrim = el<HTMLElement>('about-scrim');
        this.closeBtn = el<HTMLButtonElement>('about-close');

        mountIcons(this.panel);
        renderMathInElement(this.panel, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
            ],
        });

        this.panel.querySelectorAll<HTMLButtonElement>('.accordion-trigger').forEach((trigger) => {
            trigger.addEventListener('click', () => {
                const open = trigger.getAttribute('aria-expanded') !== 'true';
                trigger.setAttribute('aria-expanded', open.toString());
                const target = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
                if (target) target.hidden = !open;
            });
        });

        this.closeBtn.addEventListener('click', () => this.close());
        this.scrim.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.open_) this.close();
        });
    }

    /** Opens the panel over the scrim and moves focus to the close button. */
    open(): void {
        if (this.open_) return;
        this.open_ = true;
        this.lastFocused = document.activeElement;
        this.panel.classList.add('is-open');
        this.panel.inert = false;
        this.scrim.hidden = false;
        this.closeBtn.focus();
    }

    /** Closes the panel and restores focus to whatever opened it. */
    close(): void {
        if (!this.open_) return;
        this.open_ = false;
        this.panel.classList.remove('is-open');
        this.panel.inert = true;
        this.scrim.hidden = true;
        if (this.lastFocused instanceof HTMLElement) this.lastFocused.focus();
    }

    /** Toggles the panel open or closed. */
    toggle(): void {
        if (this.open_) this.close();
        else this.open();
    }
}
