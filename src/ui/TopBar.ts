/**
 * Copyright (c) 2026 Sajid Ahmed
 */
import { el, elOrNull } from '../utils';
import { icons, mountIcons } from './icons';

export interface TopBarOptions {
    onToggleSidebar: () => void;
    /** Absent while nothing has wired the About panel up yet. */
    onAbout?: () => void;
}

/**
 * The floating top bar: sidebar toggle, brand, telemetry (with its "more" dropdown),
 * the About button and the GitHub link. Owns only its own DOM wiring - telemetry values
 * are written by {@link updateTelemetry}, and the About button only calls `onAbout`; it
 * does not own whatever panel that opens.
 */
export class TopBar {
    private readonly root: HTMLElement;
    private readonly sidebarToggle: HTMLButtonElement;

    /**
     * Mounts icons under the top bar and wires the sidebar toggle, the About button and
     * the telemetry "more" dropdown.
     * @param opts - Callbacks for the sidebar toggle and the About button.
     */
    constructor(opts: TopBarOptions) {
        this.root = el<HTMLElement>('top-bar');
        mountIcons(this.root);

        this.sidebarToggle = el<HTMLButtonElement>('ui-toggle-sidebar');
        this.sidebarToggle.addEventListener('click', () => opts.onToggleSidebar());

        const aboutBtn = elOrNull<HTMLButtonElement>('ui-about');
        if (aboutBtn) {
            aboutBtn.addEventListener('click', () => opts.onAbout?.());
        }

        const moreToggle = elOrNull<HTMLButtonElement>('tel-more-toggle');
        const morePanel = elOrNull<HTMLElement>('tel-more-panel');
        if (moreToggle && morePanel) {
            moreToggle.addEventListener('click', () => {
                const open = moreToggle.getAttribute('aria-expanded') !== 'true';
                moreToggle.setAttribute('aria-expanded', open.toString());
                morePanel.hidden = !open;
            });
        }
    }

    /** Sets the sidebar toggle's expanded state, swapping its icon to match. */
    setSidebarExpanded(open: boolean): void {
        this.sidebarToggle.setAttribute('aria-expanded', open.toString());
        this.sidebarToggle.innerHTML = open ? icons.panelLeftClose : icons.panelLeft;
    }
}
