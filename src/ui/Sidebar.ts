/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { el, elOrNull } from '../utils';
import { mountIcons } from './icons';

export interface SidebarOptions {
    onChange: (open: boolean) => void;
}

/** Below this width the sidebar is a bottom sheet, closed by default. */
const MOBILE_QUERY = '(max-width: 768px)';

/**
 * The persistent (desktop) / bottom-sheet (mobile) controls panel. Owns only its own
 * open/collapsed state; every control inside it is wired by {@link setupUI}.
 */
export class Sidebar {
    private readonly root: HTMLElement;
    private readonly onChange: (open: boolean) => void;
    private readonly mobileQuery: MediaQueryList;
    private open_: boolean;

    /**
     * Mounts icons, wires the close button, and applies the viewport's default open state
     * without animating the initial placement.
     * @param opts - `onChange` is called whenever the open state changes, including the
     *   initial application in this constructor.
     */
    constructor(opts: SidebarOptions) {
        this.root = el<HTMLElement>('control-island');
        this.onChange = opts.onChange;
        mountIcons(this.root);

        const closeBtn = elOrNull<HTMLButtonElement>('sidebar-close');
        closeBtn?.addEventListener('click', () => this.set(false));

        this.mobileQuery = window.matchMedia(MOBILE_QUERY);
        this.open_ = !this.mobileQuery.matches;
        this.set(this.open_);

        // The markup ships with .no-transition so this first placement doesn't animate.
        // Two rAFs guarantee the browser has painted that state before transitions
        // re-enable, so a later toggle is the first thing that ever animates.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.root.classList.remove('no-transition');
            });
        });

        this.mobileQuery.addEventListener('change', (e) => {
            this.set(!e.matches);
        });
    }

    /** Toggles the panel open or closed. */
    toggle(): void {
        this.set(!this.open_);
    }

    private set(open: boolean): void {
        this.open_ = open;
        this.root.classList.toggle('is-collapsed', !open);
        // A collapsed panel is translated off-screen and must not be Tab-reachable.
        this.root.inert = !open;
        this.onChange(open);
    }
}
