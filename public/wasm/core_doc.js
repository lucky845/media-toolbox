/**
 * 契约版本，前端启动时自检。
 * @returns {number}
 */
export function contract_version() {
    const ret = wasm.contract_version();
    return ret >>> 0;
}

/**
 * 人类可读体积/时长（前端不重复实现），便于 UI 与错误文案完全一致。
 * @param {number} n
 * @returns {string}
 */
export function format_bytes(n) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.format_bytes(retptr, n);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {number} secs
 * @returns {string}
 */
export function format_duration(secs) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.format_duration(retptr, secs);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 能力（JSON）。Web 侧固定为「受限」形态。
 * @returns {string}
 */
export function get_capabilities() {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.get_capabilities(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 错误码表（JSON），前端用它渲染中文文案，不在 TS 里复制一份。
 * @returns {string}
 */
export function get_error_spec() {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.get_error_spec(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 阈值（JSON）。
 * @returns {string}
 */
export function get_limits() {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.get_limits(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 内容哈希（blake3 hex）。用于双端一致性比对与缓存键。
 * @param {Uint8Array | number[]} input
 * @returns {string}
 */
export function hash_bytes(input) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
        const len0 = WASM_VECTOR_LEN;
        wasm.hash_bytes(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 返回 `[x, kernel(x)]` 的扁平数组（x 从 0 到 max，步长 step）。
 * @param {string} filter_name
 * @param {number} max
 * @param {number} step
 * @returns {Float32Array}
 */
export function kernel_samples(filter_name, max, step) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const val2 = +max;
        const val3 = +step;
        const ptr0 = passStringToWasm0(filter_name, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
        const len0 = WASM_VECTOR_LEN;
        wasm.kernel_samples(retptr, ptr0, len0, val2, val3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v4 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 输出文件名。
 * @param {string} stem
 * @param {string} params_json
 * @param {string} encode_json
 * @returns {string}
 */
export function make_output_name(stem, params_json, encode_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passStringToWasm0(stem, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(encode_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.make_output_name(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr4 = r0;
        var len4 = r1;
        if (r3) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred5_0, deferred5_1, 1);
    }
}

/**
 * 生成缩略图（预览用，返回 PNG）。
 * @param {Uint8Array | number[]} input
 * @param {number} max_side
 * @returns {Uint8Array}
 */
export function make_thumbnail(input, max_side) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const val2 = +max_side;
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
        const len0 = WASM_VECTOR_LEN;
        wasm.make_thumbnail(retptr, ptr0, len0, val2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {string} direction
 * @returns {string}
 */
export function office_fidelity_note(direction) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const ptr0 = passStringToWasm0(direction, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
        const len0 = WASM_VECTOR_LEN;
        wasm.office_fidelity_note(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr2 = r0;
        var len2 = r1;
        if (r3) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function office_structure_text(raw) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const ptr0 = passStringToWasm0(raw, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
        const len0 = WASM_VECTOR_LEN;
        wasm.office_structure_text(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr2 = r0;
        var len2 = r1;
        if (r3) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {string} password
 * @returns {Uint8Array}
 */
export function pdf_decrypt(input, password) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(password, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_decrypt(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {string} password
 * @returns {Uint8Array}
 */
export function pdf_encrypt(input, password) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(password, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_encrypt(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {string} selector_json
 * @param {string} what
 * @returns {string}
 */
export function pdf_extract(input, selector_json, what) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(selector_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(what, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_extract(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr4 = r0;
        var len4 = r1;
        if (r3) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred5_0, deferred5_1, 1);
    }
}

/**
 * @param {Array<any>} inputs
 * @returns {Uint8Array}
 */
export function pdf_merge(inputs) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.pdf_merge(retptr, inputs);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @returns {string}
 */
export function pdf_probe(input) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
        const len0 = WASM_VECTOR_LEN;
        wasm.pdf_probe(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr2 = r0;
        var len2 = r1;
        if (r3) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {Uint32Array | number[]} order
 * @returns {Uint8Array}
 */
export function pdf_reorder(input, order) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray32ToWasm0(order, wasm.__wbindgen_export5);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_reorder(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {string} selector_json
 * @param {number} degrees
 * @returns {Uint8Array}
 */
export function pdf_rotate(input, selector_json, degrees) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const val3 = +degrees;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(selector_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_rotate(retptr, ptr0, len0, ptr1, len1, val3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v4 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {Uint8Array | number[]} input
 * @param {string} ranges_json
 * @param {string} page_selector_json
 * @returns {string}
 */
export function pdf_split(input, ranges_json, page_selector_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(ranges_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(page_selector_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.pdf_split(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr4 = r0;
        var len4 = r1;
        if (r3) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred5_0, deferred5_1, 1);
    }
}

/**
 * 只读探测。
 * @param {Uint8Array | number[]} input
 * @returns {string}
 */
export function probe_image_meta(input) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
        const len0 = WASM_VECTOR_LEN;
        wasm.probe_image_meta(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr2 = r0;
        var len2 = r1;
        if (r3) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
    }
}

/**
 * 完整处理（一步到位）。进度回调签名：`(done: number, total: number, phase: string) => void`。
 * @param {Uint8Array | number[]} input
 * @param {string} params_json
 * @param {string} encode_json
 * @param {Function | null} [on_progress]
 * @returns {Uint8Array}
 */
export function process_image(input, params_json, encode_json, on_progress) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(encode_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.process_image(retptr, ptr0, len0, ptr1, len1, ptr2, len2, isLikeNone(on_progress) ? 0 : addToExternrefTable0(on_progress));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v4 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 处理并返回完整结果 JSON（含尺寸、体积、哈希），供 UI 展示「体积节省」。
 * @param {Uint8Array | number[]} input
 * @param {string} params_json
 * @param {string} encode_json
 * @param {Function | null} [on_progress]
 * @returns {string}
 */
export function process_image_with_meta(input, params_json, encode_json, on_progress) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(encode_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.process_image_with_meta(retptr, ptr0, len0, ptr1, len1, ptr2, len2, isLikeNone(on_progress) ? 0 : addToExternrefTable0(on_progress));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr4 = r0;
        var len4 = r1;
        if (r3) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred5_0, deferred5_1, 1);
    }
}

/**
 * 两阶段处理的第 2 阶段：把上一步的中间图重编码为目标格式。
 * @param {Uint8Array | number[]} intermediate
 * @param {string} encode_json
 * @param {string | null} [background_json]
 * @returns {Uint8Array}
 */
export function process_stage_encode(intermediate, encode_json, background_json) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passArray8ToWasm0(intermediate, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(encode_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = isLikeNone(background_json) ? 0 : passStringToWasm0(background_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.process_stage_encode(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v4 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 两阶段处理的第 1 阶段：解码 + 全部变换，返回 PNG 编码的中间结果。
 *
 * 为什么中间结果用 PNG：无损、能保留 alpha，且浏览器能直接 `createImageBitmap` 用于预览。
 * 代价是一次额外编码（10-20 MP 约 200–600ms），但换来「可取消」与「可预览」。
 * @param {Uint8Array | number[]} input
 * @param {string} params_json
 * @param {Function | null} [on_progress]
 * @returns {Uint8Array}
 */
export function process_stage_transform(input, params_json, on_progress) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export5);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.process_stage_transform(retptr, ptr0, len0, ptr1, len1, isLikeNone(on_progress) ? 0 : addToExternrefTable0(on_progress));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeFromExternrefTable0(r2);
        }
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 体积变化文案：只计算元数据，不重新运行图片流水线。
 * @param {number} input_bytes
 * @param {number} output_bytes
 * @returns {string}
 */
export function savings_text(input_bytes, output_bytes) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.savings_text(retptr, input_bytes, output_bytes);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 归一化后的采样表（与 resize 内部用的完全同一份逻辑），用于定位「权重归一化」差异。
 * @param {string} filter_name
 * @param {number} src
 * @param {number} dst
 * @returns {Float32Array}
 */
export function tap_samples(filter_name, src, dst) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const val2 = +src;
        const val3 = +dst;
        const ptr0 = passStringToWasm0(filter_name, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
        const len0 = WASM_VECTOR_LEN;
        wasm.tap_samples(retptr, ptr0, len0, val2, val3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v4 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * core 版本（含 git 短哈希，构建时注入）。
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {string} params_json
 * @param {string} input
 * @param {string} output
 * @returns {string}
 */
export function video_build_args(params_json, input, output) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(input, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(output, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_export3(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_export3(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_export3(ptr0, len0 * 1, 1); }
            throw e;
        }
        wasm.video_build_args(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr4 = r0;
        var len4 = r1;
        if (r3) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred5_0, deferred5_1, 1);
    }
}

/**
 * @param {number} total_sec
 * @param {string} line
 * @returns {string}
 */
export function video_parse_progress(total_sec, line) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
        const val2 = +total_sec;
        const ptr0 = passStringToWasm0(line, wasm.__wbindgen_export5, wasm.__wbindgen_export6);
        const len0 = WASM_VECTOR_LEN;
        wasm.video_parse_progress(retptr, val2, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr3 = r0;
        var len3 = r1;
        if (r3) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(r2);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred4_0, deferred4_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_apply_bfe2b07b146427e2: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.apply(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_byteLength_c5f3c188d5252e5b: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_getRandomValues_8b6f1f663e6f188d: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_get_d7176cfb76d71114: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Uint8Array_d7aeb0dcb3108fea: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_186163212ffe79c3: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_b03a0fabb109b1e9: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_37eb45aaf5eeb820: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_now_463ac581d2fc7ea3: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_prototypesetcall_13162965d1fe7aa3: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_c9f4893fc209f768: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./core_doc_bg.js": import0,
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__wbindgen_export2();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
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
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
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

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_export(idx);
    }
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

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
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

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__wbindgen_export4(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
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

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('core_doc_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
