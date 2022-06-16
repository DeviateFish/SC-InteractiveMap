import StreamReader from './StreamReader';

/**
 * @callback ChunkReader
 * @returns {Uint8Array}
 */

/**
 * @typedef {import('./StreamReader.js').ValueGetter} ValueGetter
 */

/**
 * This class implements a bunch of methods for reading from a binary stream.
 * This is built with the assumption that it will be getting data streamed to it from an
 * outside source.  This is implemented by passing it a `getChunk` function that will return
 * the next block of data to be appended to the current buffer.
 * Given that this will be used to read a save file that includes a header followed by a large
 * number of gzipped chunks, this allows us to only read/gunzip pieces as we need them.
 * We assume we'll be given Uint8Array chunks, rather than arbitrary array buffer ones,
 * but it should work in either case.
 */
export default class ChunkedReader extends StreamReader {
    constructor(getChunk) {
        super(null);

        /**
         * @type ChunkReader
         */
         this.getChunk = getChunk;
    }

    /**
     * Fetches a new chunk and extends the current buffer with the new data.
     * This can happen asynchronously.  This also resets the internal `_offset` number
     * to 0.
     * @returns Boolean
     */
     extend() {
        const chunk = this.getChunk();
        if (!chunk) {
            return false;
        }

        let offset = 0;
        let remaining = 0;
        let newLen = chunk.length;
        if (this._buf) {
            remaining = this._length - this._offset;
            newLen += remaining;
        }

        const newBuf = new Uint8Array(newLen);

        if (remaining > 0) {
            const remainder = new Uint8Array(this._buf.slice(this._offset));
            newBuf.set(remainder, 0);
            offset += remaining;
        }

        newBuf.set(chunk, offset);

        this._buf = newBuf.buffer;
        this._offset = 0;
        this._length = newLen;
        this._view = new DataView(this._buf);
        return true;
    }

    /**
     * Read the specified number of bytes from the buffer.  Return value
     * depends on the return value of the getter.  Will extend the buffer
     * as necessary.
     * @param {Number} bytes Number of bytes to read
     * @param {ValueGetter} getter Function to actually read the bytes from the buffer.
     * @returns {*}
     */
    _read(bytes, getter) {
        while (this._length - this._offset < bytes) {
            if (!this.extend()) {
                throw new Error(`StreamReader: Could not extend buffer to fetch ${bytes - this._length} additional bytes!`);
            }
        }
        return super._read(bytes, getter);
    }

    /**
     * Identical to `_read`, but does not advance the cursor.  Useful for debugging, but should otherwise
     * be avoided.
     * @param {Number} bytes Number of bytes to peek
     * @param {ValueGetter} getter Function to parse the bytes peeked
     * @returns {*}
     */
    _peek(bytes, getter) {
        while (this._length - this._offset < bytes) {
            if (!this.extend()) {
                throw new Error(`StreamReader: Could not extend buffer to fetch ${bytes - this._length} additional bytes!`);
            }
        }
        return super._peek(bytes, getter);
    }
}