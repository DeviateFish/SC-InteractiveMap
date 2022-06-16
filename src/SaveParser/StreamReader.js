import {
    readUTF8String,
    readUTF16String,
    readUint8,
    readInt8,
    readInt32,
    readFloat32,
    readFloat64,
} from './Readers';

/**
 * @callback ValueGetter
 * @param {DataView} view
 * @param {Number} offset
 * @returns {*}
 */

/**
 * This class implements a bunch of methods for reading from a binary stream.
 * This holds all the mechanisms for reading out the proper types of values, as well
 * as keeping track of where in the stream we're reading from.  This allows us to
 * just provide a clean API to downstream consumers
 */
export default class StreamReader {
    /**
     * @param {ArrayBuffer|null} arrayBuffer
     */
    constructor(arrayBuffer) {
        /**
         * @type ArrayBuffer
         */
        this._buf = arrayBuffer;
        this._offset = 0;
        this._length = 0;
        if (arrayBuffer) {
            this._view = new DataView(this._buf);
        } else {
            this._view = null;
        }
        this.bytesRead = 0;
    }

    /**
     * Read the specified number of bytes from the buffer.  Return value
     * depends on the return value of the getter.
     * @param {Number} bytes Number of bytes to read
     * @param {ValueGetter} getter Function to actually read the bytes from the buffer.
     * @returns {*}
     */
    _read(bytes, getter) {
        const val = getter(this._view, this._offset);
        this._offset += bytes;
        this.bytesRead += bytes;
        return val;
    }

    /**
     * Identical to `_read`, but does not advance the cursor.  Useful for debugging, but should otherwise
     * be avoided.
     * @param {Number} bytes Number of bytes to peek
     * @param {ValueGetter} getter Function to parse the bytes peeked
     * @returns {*}
     */
    _peek(bytes, getter) {
        const val = getter(this._view, this._offset);
        return val;
    }

    /**
     * Read an unsigned 8-bit number from the buffer
     * @returns Number
     */
    readByte() {
        return this._read(1, readUint8);
    }

    /**
     * Read a signed 8-bit number from the buffer
     * @returns Number
     */
    readInt8() {
        return this._read(1, readInt8);
    }

    /**
     * Read a signed 32-bit number from the buffer
     * @returns Number
     */
    readInt() {
        return this._read(4, readInt32);
    }

    /**
     * Try to read a signed 64-bit number from the buffer.  If the high-order
     * bits are 0, return just the low-order bits.  Otherwise, return an array
     * consisting of [low, high]
     * @returns Number|Array<Number>
     */
    readLong() {
        const low = this.readInt();
        const high = this.readInt();

        if (high === 0) {
            return low;
        } else {
            return [low, high];
        }
    }

    /**
     * Read a signed 32-bit float from the buffer
     * @returns Number
     */
    readFloat() {
        return this._read(4, readFloat32);
    }

    /**
     * Read a signed 64-bit float from the buffer
     * @returns Number
     */
    readDouble() {
        return this._read(8, readFloat64);
    }

    /**
     * Attempt to read a string from the buffer.  Strings are assumed to be encoded with
     * a 32-bit signed number indicating length, followed by that many bytes representing
     * a 0-terminated string.  If the length is negative, this indicates the characters are
     * encoded as UTF-16.  If the length is positive, it's UTF-8.
     * @returns String
     */
    readString() {
        const length = this.readInt();

        if (length === 0) {
            return '';
        }

        if (length < 0) {
            // UTF-16
            const realLen = (-length) * 2;
            return this._read(realLen, (buf, offset) => readUTF16String(buf, offset, -length));
        } else {
            // UTF-8
            return this._read(length, (buf, offset) => readUTF8String(buf, offset, length));
        }
    }

    /**
     * Attempts to read a fixed number of bytes as a utf-8 string
     * @param {Number} length
     * @returns String
     */
    readRaw(length) {
        return this._read(length, (buf, offset) => readUTF8String(buf, offset, length));
    }

    /**
     * Attempts to read a fixed number of bytes as a utf-8 string WITHOUT advancing
     * the current offset
     * @param {Number} length Number of bytes to peek
     * @returns
     */
    peekRaw(length) {
        return this._peek(length, (buf, offset) => readUTF8String(buf, offset, length));
    }

    /**
     * Skip an arbitrary number of bytes
     * @param {Number} [bytes=1] Number of bytes to skip (1 if not specified)
     * @returns void
     */
    skipBytes(bytes = 1) {
        this.readRaw(bytes);
    }
}