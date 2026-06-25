/**
 * Static WGSL struct parser + uniform-layout calculator (no GPU).
 *
 * Used by `tests/gpu/uniform-layout.test.ts` to compute the byte offsets WGSL assigns to each
 * field of a `struct` under the uniform address space alignment rules, then flatten each field
 * into its individual f32 components. A flat positional `Float32Array` on the TS side must match
 * this component layout exactly; any misalignment (e.g. a `vec2` that no longer lands on an
 * 8-aligned offset) shows up as a component offset that is not `4 * index`.
 */

/** A field as written in the WGSL struct source: its name and type spelling. */
export interface WgslField {
    name: string;
    type: string;
}

/** One f32-sized component of a laid-out field, at its absolute byte offset within the struct. */
export interface LaidOutComponent {
    name: string;
    offset: number;
}

/** WGSL alignment (bytes) per scalar/vector type, uniform address space. */
const ALIGN: Record<string, number> = {
    f32: 4,
    'vec2<f32>': 8,
    'vec3<f32>': 16,
    'vec4<f32>': 16,
};

/** WGSL size (bytes) per scalar/vector type. */
const SIZE: Record<string, number> = {
    f32: 4,
    'vec2<f32>': 8,
    'vec3<f32>': 12,
    'vec4<f32>': 16,
};

/** Component suffixes used when flattening a vector field into its f32 components. */
const COMPONENT_SUFFIX = ['.x', '.y', '.z', '.w'];

const roundUp = (value: number, align: number): number => Math.ceil(value / align) * align;

/**
 * Parse the fields of a named `struct` out of WGSL source. Strips line comments, isolates the
 * body between `struct <name> {` and the matching `}`, and reads each `name: type,` declaration.
 */
export function parseStruct(src: string, structName: string): WgslField[] {
    const withoutComments = src.replace(/\/\/[^\n]*/g, '');
    const match = withoutComments.match(new RegExp(`struct\\s+${structName}\\s*\\{([^}]*)\\}`));
    if (!match) {
        throw new Error(`struct ${structName} not found in WGSL source`);
    }

    return match[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
            const field = entry.match(/^(\w+)\s*:\s*(.+)$/);
            if (!field) {
                throw new Error(`Unparseable struct field: "${entry}"`);
            }
            return { name: field[1], type: field[2].replace(/\s+/g, '') };
        });
}

/**
 * Compute the WGSL uniform byte layout for an ordered list of fields and flatten each field into
 * its f32 components. Returns the component list (in order, with absolute byte offsets) and the
 * total struct size rounded up to 16 bytes (uniform struct alignment).
 */
export function computeComponentLayout(
    fields: WgslField[],
): { components: LaidOutComponent[]; size: number } {
    const components: LaidOutComponent[] = [];
    let cursor = 0;

    for (const field of fields) {
        const align = ALIGN[field.type];
        const size = SIZE[field.type];
        if (align === undefined || size === undefined) {
            throw new Error(`Unsupported WGSL type: ${field.type}`);
        }

        const offset = roundUp(cursor, align);
        const componentCount = size / 4;
        for (let c = 0; c < componentCount; c++) {
            const name = componentCount === 1 ? field.name : field.name + COMPONENT_SUFFIX[c];
            components.push({ name, offset: offset + c * 4 });
        }
        cursor = offset + size;
    }

    return { components, size: roundUp(cursor, 16) };
}
