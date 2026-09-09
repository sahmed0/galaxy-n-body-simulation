/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Lucide icons (ISC licence, https://lucide.dev), inlined: five icons do not justify a dependency.
 * SVGs carry no width/height; CSS sizes them. stroke="currentColor" makes `color` recolor them.
 */
const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
    info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
    panelLeft: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
    panelLeftClose: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
} as const;

export type IconName = keyof typeof icons;

/** Fills every `[data-icon="<name>"]` host under `root` with its SVG. */
export function mountIcons(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('[data-icon]').forEach((host) => {
        const name = host.dataset.icon;
        if (name && name in icons) host.innerHTML = icons[name as IconName];
    });
}
