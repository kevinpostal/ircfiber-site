/* @ts-self-types="./wasm_img2irc.d.ts" */

/**
 * @param {number} f_r
 * @param {number} f_g
 * @param {number} f_b
 * @param {number} b_r
 * @param {number} b_g
 * @param {number} b_b
 * @param {number} t
 * @returns {Uint8Array}
 */
export function alpha_blend(f_r, f_g, f_b, b_r, b_g, b_b, t) {
    const ret = wasm.alpha_blend(f_r, f_g, f_b, b_r, b_g, b_b, t);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {Uint8Array} r1
 * @param {Uint8Array} g1
 * @param {Uint8Array} b1
 * @param {Uint8Array} r2
 * @param {Uint8Array} g2
 * @param {Uint8Array} b2
 * @param {Uint32Array} states_f
 * @param {Uint32Array} states_b
 * @param {Uint32Array} palette
 * @param {number} mode
 * @param {number} w
 * @param {Uint8Array} out_glyph
 * @param {Float32Array} out_err
 * @param {Uint8Array} out_bytes
 * @returns {number}
 */
export function batch_best_glyph(r1, g1, b1, r2, g2, b2, states_f, states_b, palette, mode, w, out_glyph, out_err, out_bytes) {
    const ptr0 = passArray8ToWasm0(r1, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(g1, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(b1, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(r2, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(g2, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(b2, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(states_f, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray32ToWasm0(states_b, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    var ptr9 = passArray8ToWasm0(out_glyph, wasm.__wbindgen_malloc);
    var len9 = WASM_VECTOR_LEN;
    var ptr10 = passArrayF32ToWasm0(out_err, wasm.__wbindgen_malloc);
    var len10 = WASM_VECTOR_LEN;
    var ptr11 = passArray8ToWasm0(out_bytes, wasm.__wbindgen_malloc);
    var len11 = WASM_VECTOR_LEN;
    const ret = wasm.batch_best_glyph(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, mode, w, ptr9, len9, out_glyph, ptr10, len10, out_err, ptr11, len11, out_bytes);
    return ret >>> 0;
}

/**
 * @param {Uint8Array} r1
 * @param {Uint8Array} g1
 * @param {Uint8Array} b1
 * @param {Uint8Array} r2
 * @param {Uint8Array} g2
 * @param {Uint8Array} b2
 * @param {Uint32Array} states_f
 * @param {Uint32Array} states_b
 * @param {Uint32Array} palette
 * @param {number} mode
 * @param {number} w
 * @param {Float32Array} glyph_ct
 * @param {Float32Array} glyph_cb
 * @param {Uint8Array} glyph_bytes
 * @param {Uint8Array} out_glyph
 * @param {Float32Array} out_err
 * @param {Uint8Array} out_bytes
 * @returns {number}
 */
export function batch_best_glyph_custom(r1, g1, b1, r2, g2, b2, states_f, states_b, palette, mode, w, glyph_ct, glyph_cb, glyph_bytes, out_glyph, out_err, out_bytes) {
    const ptr0 = passArray8ToWasm0(r1, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(g1, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(b1, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(r2, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(g2, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(b2, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(states_f, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray32ToWasm0(states_b, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArrayF32ToWasm0(glyph_ct, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArrayF32ToWasm0(glyph_cb, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ptr11 = passArray8ToWasm0(glyph_bytes, wasm.__wbindgen_malloc);
    const len11 = WASM_VECTOR_LEN;
    var ptr12 = passArray8ToWasm0(out_glyph, wasm.__wbindgen_malloc);
    var len12 = WASM_VECTOR_LEN;
    var ptr13 = passArrayF32ToWasm0(out_err, wasm.__wbindgen_malloc);
    var len13 = WASM_VECTOR_LEN;
    var ptr14 = passArray8ToWasm0(out_bytes, wasm.__wbindgen_malloc);
    var len14 = WASM_VECTOR_LEN;
    const ret = wasm.batch_best_glyph_custom(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, mode, w, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, out_glyph, ptr13, len13, out_err, ptr14, len14, out_bytes);
    return ret >>> 0;
}

/**
 * @param {BigUint64Array} masks
 * @param {Uint32Array} states_f
 * @param {Uint32Array} states_b
 * @param {Uint32Array} palette
 * @param {number} mode
 * @param {number} w
 * @param {Uint8Array} out_glyph
 * @param {Float32Array} out_err
 * @param {Uint8Array} out_bytes
 * @returns {number}
 */
export function batch_best_glyph_polygon(masks, states_f, states_b, palette, mode, w, out_glyph, out_err, out_bytes) {
    const ptr0 = passArray64ToWasm0(masks, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(states_f, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(states_b, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    var ptr4 = passArray8ToWasm0(out_glyph, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    var ptr5 = passArrayF32ToWasm0(out_err, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    var ptr6 = passArray8ToWasm0(out_bytes, wasm.__wbindgen_malloc);
    var len6 = WASM_VECTOR_LEN;
    const ret = wasm.batch_best_glyph_polygon(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, mode, w, ptr4, len4, out_glyph, ptr5, len5, out_err, ptr6, len6, out_bytes);
    return ret >>> 0;
}

/**
 * @param {Uint8Array} r
 * @param {Uint8Array} g
 * @param {Uint8Array} b
 * @param {Uint32Array} palette
 * @param {number} mode
 * @param {Uint8Array} out
 * @returns {number}
 */
export function batch_nearest(r, g, b, palette, mode, out) {
    const ptr0 = passArray8ToWasm0(r, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(g, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(b, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    var ptr4 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    const ret = wasm.batch_nearest(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, mode, ptr4, len4, out);
    return ret >>> 0;
}

/**
 * @param {Uint8Array} r_tops
 * @param {Uint8Array} g_tops
 * @param {Uint8Array} b_tops
 * @param {Uint8Array} r_bots
 * @param {Uint8Array} g_bots
 * @param {Uint8Array} b_bots
 * @param {Uint32Array} palette
 * @param {number} mode
 * @param {number} size
 * @param {number} ng
 * @param {Uint32Array} out
 * @returns {number}
 */
export function batch_row_palette(r_tops, g_tops, b_tops, r_bots, g_bots, b_bots, palette, mode, size, ng, out) {
    const ptr0 = passArray8ToWasm0(r_tops, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(g_tops, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(b_tops, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(r_bots, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(g_bots, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(b_bots, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    var ptr7 = passArray32ToWasm0(out, wasm.__wbindgen_malloc);
    var len7 = WASM_VECTOR_LEN;
    const ret = wasm.batch_row_palette(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, mode, size, ng, ptr7, len7, out);
    return ret >>> 0;
}

/**
 * @param {number} r1
 * @param {number} g1
 * @param {number} b1
 * @param {number} r2
 * @param {number} g2
 * @param {number} b2
 * @param {number} f_r
 * @param {number} f_g
 * @param {number} f_b
 * @param {number} b_r
 * @param {number} b_g
 * @param {number} b_b
 * @param {string} mode
 * @param {number} w
 * @returns {number}
 */
export function best_glyph_for_state(r1, g1, b1, r2, g2, b2, f_r, f_g, f_b, b_r, b_g, b_b, mode, w) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.best_glyph_for_state(r1, g1, b1, r2, g2, b2, f_r, f_g, f_b, b_r, b_g, b_b, ptr0, len0, w);
    return ret >>> 0;
}

/**
 * @param {Uint8Array} data
 * @param {number} p_w
 * @param {number} p_h
 * @param {number} radius
 * @param {number} sigma
 * @param {number} passes
 */
export function bilateral_filter(data, p_w, p_h, radius, sigma, passes) {
    var ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.bilateral_filter(ptr0, len0, data, p_w, p_h, radius, sigma, passes);
}

/**
 * @returns {boolean}
 */
export function has_simd() {
    const ret = wasm.has_simd();
    return ret !== 0;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {Uint32Array} palette
 * @param {string} mode
 * @returns {number}
 */
export function nearest_index(r, g, b, palette, mode) {
    const ptr0 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.nearest_index(r, g, b, ptr0, len0, ptr1, len1);
    return ret >>> 0;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {Uint32Array} palette
 * @param {Uint32Array} irc_palette
 * @param {string} mode
 * @returns {number}
 */
export function nearest_index_irc(r, g, b, palette, irc_palette, mode) {
    const ptr0 = passArray32ToWasm0(palette, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(irc_palette, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.nearest_index_irc(r, g, b, ptr0, len0, ptr1, len1, ptr2, len2);
    return ret >>> 0;
}

/**
 * @param {number} f_r
 * @param {number} f_g
 * @param {number} f_b
 * @param {number} b_r
 * @param {number} b_g
 * @param {number} b_b
 * @param {number} t
 * @returns {Uint8Array}
 */
export function oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, t) {
    const ret = wasm.oklab_blend(f_r, f_g, f_b, b_r, b_g, b_b, t);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {number} l
 * @param {number} a
 * @param {number} b
 * @returns {Uint8Array}
 */
export function oklab_to_srgb(l, a, b) {
    const ret = wasm.oklab_to_srgb(l, a, b);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {any} blocks
 * @param {string} render_str
 * @param {boolean} nograyscale
 * @returns {string}
 */
export function render_blocks(data, width, height, blocks, render_str, nograyscale) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(render_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.render_blocks(ptr0, len0, width, height, blocks, ptr1, len1, nograyscale);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {string} render_str
 * @param {boolean} nograyscale
 * @returns {string}
 */
export function render_braille(data, width, height, render_str, nograyscale) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(render_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.render_braille(ptr0, len0, width, height, ptr1, len1, nograyscale);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {Float32Array}
 */
export function srgb_to_oklab(r, g, b) {
    const ret = wasm.srgb_to_oklab(r, g, b);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * @param {number} _row
 * @returns {boolean}
 */
export function viterbi_row(_row) {
    const ret = wasm.viterbi_row(_row);
    return ret !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_c7f28e53671b41e8: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_string_get_d154f1e671052120: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_from_74f3d90e0ff11240: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_get_c0c8f8d7da0c03dd: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_isArray_291e8fbbc73f8b2e: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_ecfa2c63d3d0d82c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./wasm_img2irc_bg.js": import0,
    };
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasm_img2irc_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
