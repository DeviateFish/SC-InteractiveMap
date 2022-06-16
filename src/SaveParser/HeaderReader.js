import StreamReader from './StreamReader';

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
export default class HeaderReader extends StreamReader {
    constructor(arrayBuffer) {
        super(arrayBuffer);

        /**
         * @type Number
         */
        this.headerVersion = null;

        /**
         * @type SaveHeader
         */
        this.header = null;
    }

    /**
     * Read the header version, or return it if it has already been read.
     * This should be safe to call multiple times, and in any order with `read`
     * @returns Number
     */
    readHeaderVersion() {
        if (!this.headerVersion) {
            if (this._offset !== 0) {
                throw new Error('HeaderReader.read must be the first thing called!');
            }

            this.headerVersion = this.readInt();
        }
        return this.headerVersion;
    }

    /**
     * Read the header of the save file.  Returns a SaveHeader object
     * @returns SaveHeader
     */
    readHeader() {
        if (!this.header) {
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

            this.header = header;
        }

        return this.header;
    }
}