/**
 * Copyright (c) 2026 Sajid Ahmed
 *
 * Content hash for typed-array views, used by the frozen initial-condition
 * fixtures. FNV-1a over the raw bytes, so it is sensitive to the last mantissa
 * bit of every sample rather than to a printed decimal.
 */

/** FNV-1a 32-bit over the bytes of a typed array view, as 8 hex chars. */
export function fnv1a32(view: ArrayBufferView): string {
    // The state arrays are views into one shared buffer, so hash this view's
    // own byte window, not the whole buffer.
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
