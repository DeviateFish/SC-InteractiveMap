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
 * @typedef {Object} SaveHeader
 * @property {Number} headerVersion The version of the save header
 * @property {Number} saveVersion The version of the save game itself
 * @property {Number} buildVersion The build version the save was generated from
 * @property {String} mapName The name of the map
 * @property {String} mapOptions Map options (?)
 * @property {String} sessionName The name of the session
 * @property {Number} playDurationSeconds How long, in seconds, the player has played
 * @property {Number|Array<Number>} saveDateTime The date/time the save was generated
 * @property {Number} sessionVisibility A flag indicating whether or not this is a public session
 * @property {Number} [fEditorObjectVersion] What version objects are being used.  Only appears in header versions 7 or greater
 * @property {String} [modMetadata] Mod metadata.  Only appears in header versions 8 or greater
 * @property {Number} [isModdedSave] Whether or not this is a modded save.  Only appears in versions 8 or greater
 * @property {Number} headerSize The byte length of the header
 */

/**
 * This class reads and parses the header portion of a save file.  Assumes it will be given a reference to the whole save file.
 * After reading the header, the save file version can then be used to figure out what to do with the rest of the contents
 */
export default class HeaderReader {
    constructor(arrayBuffer) {
        this._buf = arrayBuffer;
        // We don't care about the length here since this doesn't really allocate any more
        // memory.  We're also always starting from offset 0, so that doesn't matter, either.
        this._view = new DataView(this._buf);
        this._offset = 0;
        this.headerVersion = null;
    }

    /**
     * Read the header version, or return it if it has already been read.
     * This should be safe to call multiple times, and in any order with `read`
     * @returns Number
     */
    readHeaderVersion() {
        if (!this.headerVersion) {
            this.headerVersion = this.readInt();
        }
        return this.headerVersion;
    }

    /**
     * Read the header of the save file.  Returns a SaveHeader object
     * @returns SaveHeader
     */
    read() {
        const header = {};

        header.saveHeaderType = this.readHeaderVersion();
        header.saveVersion = this.readInt();
        header.buildVersion = this.readInt();
        header.mapName = this.readString();
        header.mapOptions = this.readString();
        header.sessionName = this.readString();
        header.playDurationSeconds = this.readInt();
        header.saveDateTime = this.readLong();
        header.sessionVisibility = this.readByte();

        if(header.saveHeaderType >= 7)
        {
            header.fEditorObjectVersion = this.readInt();
        }
        if(header.saveHeaderType >= 8)
        {
            header.modMetadata      = this.readString();
            header.isModdedSave     = this.readInt();
        }
        header.headerSize = this._offset;

        return header;
    }

    readInt() {
        const val = readInt32(this._view, this._offset);
        this._offset += 4;
        return val;
    }

    readByte() {
        const val = readUint8(this._view, this._offset);
        this._offset += 1;
        return val;
    }

    readLong() {
        const low = this.readInt();
        const high = this.readInt();

        if (high === 0) {
            return low;
        } else {
            return [low, high];
        }
    }

    readString() {
        const length = this.readInt();

        if (length === 0) {
            return '';
        }

        if (length < 0) {
            // UTF-16
            const realLen = -length;
            const val = readUTF16String(this._view, this._offset, realLen);
            this._offset += realLen;
            return val;
        } else {
            // UTF-8
            const val = readUTF8String(this._view, this._offset, length);
            this._offset += length;
            return val;
        }
    }
}