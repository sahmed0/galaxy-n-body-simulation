/**
 * Copyright (c) 2026 Sajid Ahmed
 */

/**
 * Returns the element with the given id, typed as `T`. Throws if it is missing,
 * so a broken template fails fast at startup rather than surfacing as a later
 * null-deref. Use for elements the page is contractually required to contain.
 * @param id - The element id to look up.
 * @returns The element, typed as `T`.
 */
export function el<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) {
        throw new Error(`Required element #${id} not found`);
    }
    return found as T;
}

/**
 * Nullable variant of {@link el} for genuinely optional elements: returns the
 * element typed as `T`, or `null` if it is absent, without throwing.
 * @param id - The element id to look up.
 * @returns The element typed as `T`, or `null` when absent.
 */
export function elOrNull<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}
