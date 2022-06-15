/**
 * This is a collection of dataview reader functions for reusability.
 * We need them in async and sync contexts, so this is helpful for sharing across both contexts
 */

/**
 * Read a utf8 string from a given dataview
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading from
 * @param {Number} length How many bytes to read
 * @returns String
 */
export const readUTF8String = (view, offset, length) => {
    const str = [];
    for (let i = 0; i < length; i++) {
        str.push(String.fromCharCode(view.getUint8(offset + i)));
    }
    return str.join('');
};

/**
 * Read a utf16 string from a given dataview
 * I'm not sure this is correct, since we're trying to read a series of uint16 one byte at a time...
 * @param {DataView} view
 * @param {Number} offset
 * @param {Number} length
 * @returns
 */
export const readUTF16String = (view, offset, length) => {
    const str = [];
    for (let i = 0; i < length; i++) {
        str.push(String.fromCharCode(view.getUint16(offset + i, true)));
    }
    return str.join('');
};

/**
 * Read an unsigned byte from the view
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading
 * @returns Number
 */
export const readUint8 = (view, offset) => view.getUint8(offset);

/**
 * Read a signed byte from the view
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading
 * @returns Number
 */
export const readInt8 = (view, offset) => view.getInt8(offset);

/**
 * Read a signed 32-bit integer from the view
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading
 * @returns Number
 */
export const readInt32 = (view, offset) => view.getInt32(offset, true);

/**
 * Read a signed 32-bit float from the view
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading
 * @returns Number
 */
export const readFloat32 = (view, offset) => view.getFloat32(offset, true);

/**
 * Read a signed 64-bit float from the view
 * @param {DataView} view The view to read from
 * @param {Number} offset The offset to start reading
 * @returns Number
 */
 export const readFloat64 = (view, offset) => view.getFloat64(offset, true);