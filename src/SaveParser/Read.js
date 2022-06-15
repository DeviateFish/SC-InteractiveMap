/* global Sentry, Intl, self */
import HeaderReader                             from './HeaderReader';
import pako                                     from '../Lib/pako.esm.js';
import StreamReader                             from './StreamReader';
import Building_Conveyor                        from '../Building/Conveyor.js';

export default class SaveParser_Read
{
    constructor(worker, options)
    {
        this.worker             = worker;
        this.objects            = {};

        this.language           = options.language;

        this.arrayBuffer        = options.arrayBuffer;
        // Still used for header try not to shrink it too much as modMetadata can be longer than anticipated...
        this.bufferView         = new DataView(this.arrayBuffer, 0, 102400);
        this.currentByte        = 0;
        this.handledByte        = 0;
        this.maxByte            = this.arrayBuffer.byteLength;
        this.streamReader       = new StreamReader(() => this.inflateNextChunk());

        this.parseSave();
    }

    parseSave()
    {
        const headerReader = new HeaderReader(this.arrayBuffer);
        const saveHeaderType = headerReader.readHeaderVersion();

        if(saveHeaderType <= 99)
        {
            this.header = headerReader.read();
            this.currentByte = this.header.headerSize;
            console.log(this.header);

            this.worker.postMessage({command: 'transferData', data: {header: this.header}});

            // We should now unzip the body!
            if(this.header.saveVersion >= 21)
            {
                // Remove the header...
                this.PACKAGE_FILE_TAG   = null;
                this.maxChunkSize       = null;

                // I don't know why we skip these bytes...
                this.streamReader.skipBytes(4);

                if(this.header.saveVersion >= 29)
                {
                    return this.parseByLevels();
                }
                return this.parseObjects();
            }
            else
            {
                this.worker.postMessage({command: 'alert', message: 'MAP\\SAVEPARSER\\That save version isn\'t supported anymore... Please save it again in the game.'});
            }
        }
        else
        {
            this.worker.postMessage({command: 'alert', message: 'That save version isn\'t supported! Are you sure this is a proper save file???'});
        }
    }

    /**
     * Parse the next gzipped chunk and inflate it, then return it
     * @returns Uint8Array
     */
    inflateNextChunk() {
        if (this.arrayBuffer.byteLength - this.currentByte < 48) {
            throw new Error('Could not read next chunk, insufficient data remaining!');
        }
        // Read chunk info size...
        let chunkHeader     = new DataView(this.arrayBuffer, this.currentByte, 48);
        this.currentByte   += 48;
        this.handledByte   += 48;

        if(this.PACKAGE_FILE_TAG === null)
        {
            //this.PACKAGE_FILE_TAG = chunkHeader.getBigInt64(0, true);
            this.PACKAGE_FILE_TAG = chunkHeader.getUint32(0, true);
            this.worker.postMessage({command: 'transferData', data: {PACKAGE_FILE_TAG: this.PACKAGE_FILE_TAG}});
        }
        if(this.maxChunkSize === null)
        {
            this.maxChunkSize = chunkHeader.getUint32(8, true);
            this.worker.postMessage({command: 'transferData', data: {maxChunkSize: this.maxChunkSize}});
        }

        let currentChunkSize    = chunkHeader.getUint32(16, true);
        let currentChunk        = this.arrayBuffer.slice(this.currentByte, this.currentByte + currentChunkSize);
        this.handledByte       += currentChunkSize;
        this.currentByte       += currentChunkSize;

        // Unzip!
        try {
            // Inflate current chunk
            let currentInflatedChunk    = null;
                currentInflatedChunk    = pako.inflate(currentChunk);

            return currentInflatedChunk;
        }
        catch(err)
        {
            this.worker.postMessage({command: 'alert', message: 'Something went wrong while trying to inflate your savegame. It seems to be related to adblock and we are looking into it.'});
            if(typeof Sentry !== 'undefined')
            {
                Sentry.setContext('pako', pako);
            }

            this.worker.postMessage({command: 'loaderHide'});
            throw err;
        }
    }

    parseByLevels() {
        let collectables    = [];
        let nbLevels        = this.streamReader.readInt();
        let levels          = [];

        for(let j = 0; j <= nbLevels; j++)
        {
            let levelName           = (j === nbLevels) ? 'Level Persistent_Level' : this.streamReader.readString();
                levels.push(levelName);
                this.streamReader.readInt();//let objectsLength       = this.streamReader.readInt();
            let countObjects        = this.streamReader.readInt();
            let entitiesToObjects   = [];

            for(let i = 0; i < countObjects; i++)
            {
                let objectType = this.streamReader.readInt();
                    switch(objectType)
                    {
                        case 0:
                            let object                          = this.readObject();
                                this.objects[object.pathName]   = object;
                                entitiesToObjects[i]            = object.pathName;
                            break;
                        case 1:
                            let actor                           = this.readActor();
                                this.objects[actor.pathName]    = actor;
                                entitiesToObjects[i]            = actor.pathName;

                                if(actor.className === '/Game/FactoryGame/-Shared/Blueprint/BP_GameState.BP_GameState_C')
                                {
                                    this.worker.postMessage({command: 'transferData', data: {gameStatePathName: actor.pathName}});
                                }
                            break;
                        default:
                            console.log('Unknown object type', objectType);
                            break;
                    }

                // Only show progress for the main level
                if(i % 2500 === 0 && levelName === 'Level Persistent_Level')
                {
                    this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s objects (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countObjects), Math.round(i / countObjects * 100)]});
                    this.worker.postMessage({command: 'loaderProgress', percentage: (30 + (i / countObjects * 15))});
                }
            }

            let countCollected = this.streamReader.readInt();
                if(countCollected > 0)
                {
                    for(let i = 0; i < countCollected; i++)
                    {
                        let collectable = this.readObjectProperty({});
                            collectables.push(collectable);
                            //console.log(collectable, this.objects[collectable.pathName])
                    }
                }

                this.streamReader.readInt();//let entitiesLength      = this.streamReader.readInt();
            let countEntities       = this.streamReader.readInt();
            let objectsToFlush      = {};

            //console.log(levelName, countObjects, entitiesLength);

            for(let i = 0; i < countEntities; i++)
            {
                this.readEntity(entitiesToObjects[i]);

                // Avoid memory error on very large save!
                objectsToFlush[entitiesToObjects[i]] = this.objects[entitiesToObjects[i]];
                delete this.objects[entitiesToObjects[i]];

                if(i % 5000 === 0)
                {
                    this.worker.postMessage({command: 'transferData', key: 'objects', data: objectsToFlush});
                    objectsToFlush = {};
                }

                // Only show progress for the main level
                if(i % 2500 === 0 && levelName === 'Level Persistent_Level')
                {
                    this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s entities (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countEntities), Math.round(i / countEntities * 100)]});
                    this.worker.postMessage({command: 'loaderProgress', percentage: (45 + (i / countEntities * 15))});
                }
            }

            // Twice but we need to handle them in order to fetch the next level...
            countCollected = this.streamReader.readInt();
            if(countCollected > 0)
            {
                for(let i = 0; i < countCollected; i++)
                {
                    this.readObjectProperty({});
                }
            }

            this.worker.postMessage({command: 'transferData', key: 'objects', data: objectsToFlush});
        }

        this.worker.postMessage({command: 'transferData', data: {collectables: collectables}});
        this.worker.postMessage({command: 'transferData', data: {levels: levels}});
        this.worker.postMessage({command: 'endSaveLoading'});
        return;
    }

    /*
     * Progress bar from 30 to 45%
     */
    parseObjects()
    {
        let countObjects                = this.streamReader.readInt();
        let entitiesToObjects           = [];
            console.log('Parsing: ' + countObjects + ' objects...');
            this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s objects (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countObjects), 0]});
            this.worker.postMessage({command: 'loaderProgress', percentage: 30});

            for(let i = 0; i < countObjects; i++)
            {
                let objectType = this.streamReader.readInt();
                    switch(objectType)
                    {
                        case 0:
                            let object                          = this.readObject();
                                this.objects[object.pathName]   = object;
                                entitiesToObjects[i]            = object.pathName;
                            break;
                        case 1:
                            let actor                           = this.readActor();
                                this.objects[actor.pathName]    = actor;
                                entitiesToObjects[i]            = actor.pathName;

                                if(actor.className === '/Game/FactoryGame/-Shared/Blueprint/BP_GameState.BP_GameState_C')
                                {
                                    this.worker.postMessage({command: 'transferData', data: {gameStatePathName: actor.pathName}});
                                }
                            break;
                        default:
                            console.log('Unknown object type', objectType);
                            break;
                    }

                if(i % 2500 === 0)
                {
                    this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s objects (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countObjects), Math.round(i / countObjects * 100)]});
                    this.worker.postMessage({command: 'loaderProgress', percentage: (30 + (i / countObjects * 15))});
                }
            }

        return this.parseEntities(entitiesToObjects, 0, this.streamReader.readInt());
    }

    /*
     * Progress bar from 45 to 60%
     */
    parseEntities(entitiesToObjects, i, countEntities)
    {
        console.log('Parsing: ' + countEntities + ' entities...');
        this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s entities (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countEntities), 0]});
        this.worker.postMessage({command: 'loaderProgress', percentage: 40});

        let objectsToFlush = {};

        for(i; i < countEntities; i++)
        {
            this.readEntity(entitiesToObjects[i]);

            // Avoid memory error on very large save!
            objectsToFlush[entitiesToObjects[i]] = this.objects[entitiesToObjects[i]];
            delete this.objects[entitiesToObjects[i]];

            if(i % 5000 === 0)
            {
                this.worker.postMessage({command: 'transferData', key: 'objects', data: objectsToFlush});
                objectsToFlush = {};
            }
            if(i % 2500 === 0)
            {
                this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s entities (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countEntities), Math.round(i / countEntities * 100)]});
                this.worker.postMessage({command: 'loaderProgress', percentage: (45 + (i / countEntities * 15))});
            }
        }

        this.worker.postMessage({command: 'transferData', key: 'objects', data: objectsToFlush});

        return this.parseCollectables();
    }

    parseCollectables()
    {
        let collectables    = [];
        let countCollected  = this.streamReader.readInt();
            for(let i = 0; i < countCollected; i++)
            {
                collectables.push(this.readObjectProperty({}));
            }

        this.worker.postMessage({command: 'transferData', data: {collectables: collectables}});

        delete this.bufferView;
        this.worker.postMessage({command: 'endSaveLoading'});
    }

    /*
     * Main objects
     */
    readObject()
    {
        let object                  = {type : 0};
            object.className        = this.streamReader.readString();
            object                  = this.readObjectProperty(object);
            object.outerPathName    = this.streamReader.readString();

        return object;
    }

    readActor()
    {
        let actor               = {type : 1};
            actor.className     = this.streamReader.readString();
            actor               = this.readObjectProperty(actor);

        let needTransform       = this.streamReader.readInt();
            if(needTransform !== 0)
            {
                actor.needTransform = needTransform;
            }

            // {rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale3d: [1, 1, 1]}
            actor.transform     = {
                rotation            : [this.streamReader.readFloat(), this.streamReader.readFloat(), this.streamReader.readFloat(), this.streamReader.readFloat()],
                translation         : [this.streamReader.readFloat(), this.streamReader.readFloat(), this.streamReader.readFloat()]
            };

            // Enforce bounding on the map to avoid the game from skipping physics!
            if(actor.transform.translation[0] < -500000 || actor.transform.translation[0] > 500000 || actor.transform.translation[1] < -500000 || actor.transform.translation[1] > 500000 || actor.transform.translation[1] < -500000 || actor.transform.translation[1] > 500000)
            {
                actor.transform.translation = [0, 0, 2000];
                console.log('Out of bounds translation', actor.pathName);
            }
            // Avoid lost vehicles in the game!
            if(isNaN(actor.transform.translation[0]) || isNaN(actor.transform.translation[1]) || isNaN(actor.transform.translation[2]))
            {
                actor.transform.translation = [0, 0, 2000];
                console.log('NaN translation', actor.pathName);
            }

            let scale3d = [this.streamReader.readFloat(), this.streamReader.readFloat(), this.streamReader.readFloat()];
                if(scale3d[0] !== 1 || scale3d[1] !== 1 || scale3d[2] !== 1)
                {
                    actor.transform.scale3d = scale3d
                }

        let wasPlacedInLevel       = this.streamReader.readInt();
            if(wasPlacedInLevel !== 0) //TODO: Switch to 1?
            {
                actor.wasPlacedInLevel = wasPlacedInLevel;
            }

        return actor;
    }

    readEntity(objectKey)
    {
        let entityLength                            = this.streamReader.readInt();
        let startByte                               = this.streamReader.bytesRead;

        if(this.objects[objectKey].type === 1)
        {
            this.objects[objectKey].entity = this.readObjectProperty({});

            let countChild  = this.streamReader.readInt();
            if(countChild > 0)
            {
                this.objects[objectKey].children = [];

                for(let i = 0; i < countChild; i++)
                {
                    this.objects[objectKey].children.push(this.readObjectProperty({}));
                }
            }
        }

        if((this.streamReader.bytesRead - startByte) === entityLength)
        {
            this.objects[objectKey].shouldBeNulled = true;
            return;
        }

        // Read properties
        this.objects[objectKey].properties       = [];
        while(true)
        {
            let property = this.readProperty(this.objects[objectKey].className);
                if(property === null)
                {
                    break;
                }

                this.objects[objectKey].properties.push(property);
        }

        // Read Conveyor missing bytes
        if(
                Building_Conveyor.isConveyorBelt(this.objects[objectKey])
             || this.objects[objectKey].className.includes('/Build_ConveyorLiftMk')
             // MODS (Also have lifts)
             || this.objects[objectKey].className.startsWith('/Game/Conveyors_Mod/Build_LiftMk')
             || this.objects[objectKey].className.startsWith('/Conveyors_Mod/Build_LiftMk')
             || this.objects[objectKey].className.startsWith('/Game/CoveredConveyor')
             || this.objects[objectKey].className.startsWith('/CoveredConveyor')
        )
        {
            this.objects[objectKey].extra   = {count: this.streamReader.readInt(), items: []};
            let itemsLength                 = this.streamReader.readInt();
            for(let i = 0; i < itemsLength; i++)
            {
                let currentItem             = {};
                let currentItemLength       = this.streamReader.readInt();
                    if(currentItemLength !== 0)
                    {
                        currentItem.length  = currentItemLength;
                    }
                    currentItem.name        = this.streamReader.readString();
                    this.streamReader.readString(); //currentItem.levelName   = this.streamReader.readString();
                    this.streamReader.readString(); //currentItem.pathName    = this.streamReader.readString();
                    currentItem.position    = this.streamReader.readFloat();

                this.objects[objectKey].extra.items.push(currentItem);
            }
        }
        else
        {
            // Extra processing
            switch(this.objects[objectKey].className)
            {
                case '/Game/FactoryGame/-Shared/Blueprint/BP_GameState.BP_GameState_C':
                case '/Game/FactoryGame/-Shared/Blueprint/BP_GameMode.BP_GameMode_C':
                    this.objects[objectKey].extra   = {count: this.streamReader.readInt(), game: []};
                    let gameLength                  = this.streamReader.readInt();

                    for(let i = 0; i < gameLength; i++)
                    {
                        this.objects[objectKey].extra.game.push(this.readObjectProperty({}));

                        if(i === 0 && this.objects[objectKey].className === '/Game/FactoryGame/-Shared/Blueprint/BP_GameState.BP_GameState_C')
                        {
                            this.worker.postMessage({command: 'transferData', data: {playerHostPathName: this.objects[objectKey].extra.game[0].pathName}});
                        }
                    }

                    break;
                case '/Game/FactoryGame/Character/Player/BP_PlayerState.BP_PlayerState_C':
                    let missingPlayerState                  = (startByte + entityLength) - this.streamReader.bytesRead;
                    this.objects[objectKey].missing         = this.streamReader.peekRaw(missingPlayerState);

                    if(missingPlayerState > 0)
                    {
                        this.streamReader.readInt(); // Skip count
                        let playerType = this.streamReader.readByte();
                            switch(playerType)
                            {
                                case 248: // EOS
                                    this.streamReader.readString();
                                    let eosStr                          = this.streamReader.readString().split('|');
                                    this.objects[objectKey].eosId       = eosStr[0];
                                    break;
                                case 249: // EOS
                                    this.streamReader.readString(); // EOS, then follow 17
                                case 17: // Old EOS
                                    let epicHexLength   = this.streamReader.readByte();
                                    let epicHex         = '';
                                    for(let i = 0; i < epicHexLength; i++)
                                    {
                                        epicHex += this.streamReader.readByte().toString(16).padStart(2, '0');
                                    }

                                    this.objects[objectKey].eosId       = epicHex.replace(/^0+/, '');
                                    break;
                                case 25: // Steam
                                    let steamHexLength  = this.streamReader.readByte();
                                    let steamHex        = '';
                                    for(let i = 0; i < steamHexLength; i++)
                                    {
                                        steamHex += this.streamReader.readByte().toString(16).padStart(2, '0');
                                    }

                                    this.objects[objectKey].steamId     = steamHex.replace(/^0+/, '');
                                    break;
                                case 8: // ???
                                    this.objects[objectKey].platformId  = this.streamReader.readString();
                                    break;
                                case 3: // Offline
                                    break;
                                default:
                                    this.worker.postMessage({command: 'alertParsing'});
                                    if(typeof Sentry !== 'undefined')
                                    {
                                        Sentry.setContext('BP_PlayerState_C', this.objects[objectKey]);
                                        Sentry.setContext('playerType', playerType);
                                    }
                                    console.log(playerType, this.objects[objectKey]);
                                    //throw new Error('Unimplemented BP_PlayerState_C type: ' + playerType);

                                    // By pass, and hope that the user will still continue to send us the save!
                                    this.currentByte += missingPlayerState - 5;
                            }
                    }
                    break;
                //TODO: Not 0 here so bypass those special cases, but why? We mainly do not want to get warned here...
                case '/Game/FactoryGame/Buildable/Factory/DroneStation/BP_DroneTransport.BP_DroneTransport_C':
                    let missingDrone                    = (startByte + entityLength) - this.streamReader.bytesRead;
                    this.objects[objectKey].missing     = this.streamReader.readRaw(missingDrone);

                    break;
                case '/Game/FactoryGame/-Shared/Blueprint/BP_CircuitSubsystem.BP_CircuitSubsystem_C':
                    this.objects[objectKey].extra   = {count: this.streamReader.readInt(), circuits: []};
                    let circuitsLength              = this.streamReader.readInt();

                    for(let i = 0; i < circuitsLength; i++)
                    {
                        this.objects[objectKey].extra.circuits.push({
                            circuitId   : this.streamReader.readInt(),
                            levelName   : this.streamReader.readString(),
                            pathName    : this.streamReader.readString()
                        });
                    }

                    break;
                case '/Game/FactoryGame/Buildable/Factory/PowerLine/Build_PowerLine.Build_PowerLine_C':
                case '/Game/FactoryGame/Events/Christmas/Buildings/PowerLineLights/Build_XmassLightsLine.Build_XmassLightsLine_C':
                case '/FlexSplines/PowerLine/Build_FlexPowerline.Build_FlexPowerline_C':
                case '/AB_CableMod/Visuals1/Build_AB-PLCopper.Build_AB-PLCopper_C':
                case '/AB_CableMod/Visuals1/Build_AB-PLCaterium.Build_AB-PLCaterium_C':
                case '/AB_CableMod/Visuals3/Build_AB-PLHeavy.Build_AB-PLHeavy_C':
                case '/AB_CableMod/Visuals4/Build_AB-SPLight.Build_AB-SPLight_C':
                case '/AB_CableMod/Visuals3/Build_AB-PLPaintable.Build_AB-PLPaintable_C':
                    this.objects[objectKey].extra       = {
                        count   : this.streamReader.readInt(),
                        source  : this.readObjectProperty({}),
                        target  : this.readObjectProperty({})
                    };

                    break;
                case '/Game/FactoryGame/Buildable/Vehicle/Train/Locomotive/BP_Locomotive.BP_Locomotive_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Train/Wagon/BP_FreightWagon.BP_FreightWagon_C':
                    this.objects[objectKey].extra   = {count: this.streamReader.readInt(), objects: []};
                    let trainLength                 = this.streamReader.readInt();
                    for(let i = 0; i < trainLength; i++)
                    {
                        this.objects[objectKey].extra.objects.push({
                            name   : this.streamReader.readString(),
                            unk    : this.streamReader.readRaw(53)
                        });
                    }

                    this.objects[objectKey].extra.previous  = this.readObjectProperty({});
                    this.objects[objectKey].extra.next      = this.readObjectProperty({});
                    break;
                case '/Game/FactoryGame/Buildable/Vehicle/Tractor/BP_Tractor.BP_Tractor_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Truck/BP_Truck.BP_Truck_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Explorer/BP_Explorer.BP_Explorer_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Cyberwagon/Testa_BP_WB.Testa_BP_WB_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Golfcart/BP_Golfcart.BP_Golfcart_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Golfcart/BP_GolfcartGold.BP_GolfcartGold_C':
                    this.objects[objectKey].extra   = {count: this.streamReader.readInt(), objects: []};
                    let vehicleLength                   = this.streamReader.readInt();
                    for(let i = 0; i < vehicleLength; i++)
                    {
                        this.objects[objectKey].extra.objects.push({
                            name   : this.streamReader.readString(),
                            unk    : this.streamReader.readRaw(53)
                        });
                    }

                    break;
                default:
                    let missingBytes = (startByte + entityLength) - this.streamReader.bytesRead;
                    if(missingBytes > 4)
                    {
                        this.objects[objectKey].missing = this.streamReader.readRaw(missingBytes); // TODO
                        console.log('MISSING ' + missingBytes + '  BYTES', this.objects[objectKey]);
                    }
                    else
                    {
                        this.streamReader.skipBytes(4);
                    }

                    break;
            }
        }
    }

    /*
     * Properties types
     */
    readProperty(parentType = null)
    {
        let currentProperty         = {};
            currentProperty.name    = this.streamReader.readString();

        if(currentProperty.name === 'None')
        {
            return null;
        }

        currentProperty.type    = this.streamReader.readString();

        this.streamReader.skipBytes(4); // Length of the property, this is calculated when writing back ;)

        let index = this.streamReader.readInt();
            if(index !== 0)
            {
                currentProperty.index = index;
            }

        switch(currentProperty.type)
        {
            case 'BoolProperty':
                currentProperty.value = this.streamReader.readByte();

                let unkBoolByte = this.streamReader.readByte();
                    if(unkBoolByte === 1)
                    {
                        currentProperty.unkBool = this.streamReader.readRaw(16);
                    }

                break;

            case 'Int8Property':
                this.streamReader.skipBytes();
                currentProperty.value = this.streamReader.readInt8();

                break;

            case 'IntProperty':
            case 'UInt32Property': // Mod?
                let unkIntByte = this.streamReader.readByte();
                    if(unkIntByte === 1)
                    {
                        currentProperty.unkInt = this.streamReader.readRaw(16);
                    }
                currentProperty.value = this.streamReader.readInt();

                break;

            case 'Int64Property':
            case 'UInt64Property':
                this.streamReader.skipBytes();
                currentProperty.value = this.streamReader.readLong();

                break;

            case 'FloatProperty':
                this.streamReader.skipBytes();
                currentProperty.value = this.streamReader.readFloat();

                break;

            case 'DoubleProperty':
                this.streamReader.skipBytes();
                currentProperty.value = this.streamReader.readDouble();

                break;

            case 'StrProperty':
            case 'NameProperty':
                this.streamReader.skipBytes();
                currentProperty.value = this.streamReader.readString();

                break;

            case 'ObjectProperty':
            case 'InterfaceProperty':
                this.streamReader.skipBytes();
                currentProperty.value = this.readObjectProperty({});
                break;

            case 'EnumProperty':
                let enumPropertyName = this.streamReader.readString();
                this.streamReader.skipBytes();
                currentProperty.value = {
                    name: enumPropertyName,
                    value: this.streamReader.readString()
                };

                break;

            case 'ByteProperty':
                let enumName = this.streamReader.readString(); //TODO
                this.streamReader.skipBytes();

                if(enumName === 'None')
                {
                    currentProperty.value = {
                        enumName: enumName,
                        value: this.streamReader.readByte()
                    };
                }
                else
                {
                    currentProperty.value = {
                        enumName: enumName,
                        valueName: this.streamReader.readString()
                    };
                }

                break;

            case 'TextProperty':
                this.streamReader.skipBytes();
                currentProperty             = this.readTextProperty(currentProperty);

                break;

            case 'ArrayProperty':
                    currentProperty.value       = {type    : this.streamReader.readString(), values  : []};
                    this.streamReader.skipBytes();
                let currentArrayPropertyCount   = this.streamReader.readInt();

                switch(currentProperty.value.type)
                {
                    case 'ByteProperty':
                        switch(currentProperty.name)
                        {
                            case 'mFogOfWarRawData':
                                for(let i = 0; i < (currentArrayPropertyCount / 4); i++)
                                {
                                    this.streamReader.readByte(); // 0
                                    this.streamReader.readByte(); // 0
                                    currentProperty.value.values.pushthis.streamReader.readByte();
                                    this.streamReader.readByte(); // 255
                                }
                                break;
                            default:
                                for(let i = 0; i < currentArrayPropertyCount; i++)
                                {
                                    currentProperty.value.values.pushthis.streamReader.readByte();
                                }
                        }
                        break;

                    case 'BoolProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.streamReader.readByte());
                        }

                    case 'IntProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.streamReader.readInt());
                        }
                        break;

                    case 'FloatProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.streamReader.readFloat());
                        }
                        break;

                    case 'EnumProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push({name: this.streamReader.readString()});
                        }
                        break;
                    case 'StrProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.streamReader.readString());
                        }
                        break;
                    case 'TextProperty': // ???
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.readTextProperty({}));
                        }
                        break;

                    case 'ObjectProperty':
                    case 'InterfaceProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(this.readObjectProperty({}));
                        }
                        break;

                    case 'StructProperty':
                        currentProperty.structureName       = this.streamReader.readString();
                        currentProperty.structureType       = this.streamReader.readString();

                        this.streamReader.readInt(); // structureSize
                        this.streamReader.readInt(); // 0

                        currentProperty.structureSubType    = this.streamReader.readString();

                        let propertyGuid1 = this.streamReader.readInt();
                        let propertyGuid2 = this.streamReader.readInt();
                        let propertyGuid3 = this.streamReader.readInt();
                        let propertyGuid4 = this.streamReader.readInt();
                            if(propertyGuid1 !== 0)
                            {
                                currentProperty.propertyGuid1 = propertyGuid1;
                            }
                            if(propertyGuid2 !== 0)
                            {
                                currentProperty.propertyGuid2 = propertyGuid2;
                            }
                            if(propertyGuid3 !== 0)
                            {
                                currentProperty.propertyGuid3 = propertyGuid3;
                            }
                            if(propertyGuid4 !== 0)
                            {
                                currentProperty.propertyGuid4 = propertyGuid4;
                            }

                        this.streamReader.skipBytes(1);

                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            switch(currentProperty.structureSubType)
                            {
                                case 'InventoryItem': // MOD: FicsItNetworks
                                    currentProperty.value.values.push({
                                        unk1          : this.streamReader.readInt(),
                                        itemName      : this.streamReader.readString(),
                                        levelName     : this.streamReader.readString(),
                                        pathName      : this.streamReader.readString()
                                    });
                                    break;

                                case 'Guid':
                                    currentProperty.value.values.push(this.streamReader.readRaw(16));
                                    break;

                                case 'FINNetworkTrace': // MOD: FicsIt-Networks
                                    currentProperty.value.values.push(this.readFINNetworkTrace());
                                    break;

                                case 'Vector':
                                    currentProperty.value.values.push({
                                        x           : this.streamReader.readFloat(),
                                        y           : this.streamReader.readFloat(),
                                        z           : this.streamReader.readFloat()
                                    });
                                    break;

                                case 'LinearColor':
                                    currentProperty.value.values.push({
                                        r : this.streamReader.readFloat(),
                                        g : this.streamReader.readFloat(),
                                        b : this.streamReader.readFloat(),
                                        a : this.streamReader.readFloat()
                                    });
                                    break;

                                // MOD: FicsIt-Networks
                                // See: https://github.com/CoderDE/FicsIt-Networks/blob/3472a437bcd684deb7096ede8f03a7e338b4a43d/Source/FicsItNetworks/Computer/FINComputerGPUT1.h#L42
                                case 'FINGPUT1BufferPixel':
                                    currentProperty.value.values.push(this.readFINGPUT1BufferPixel());
                                    break;

                                default: // Try normalised structure, then throw Error if not working...
                                    try
                                    {
                                        let subStructProperties = [];
                                            while(true)
                                            {
                                                let subStructProperty = this.readProperty();

                                                    if(subStructProperty === null)
                                                    {
                                                        break;
                                                    }

                                                subStructProperties.push(subStructProperty);
                                            }
                                        currentProperty.value.values.push(subStructProperties);
                                    }
                                    catch(error)
                                    {
                                        this.worker.postMessage({command: 'alertParsing'});
                                        if(typeof Sentry !== 'undefined')
                                        {
                                            Sentry.setContext('currentProperty', currentProperty);
                                        }
                                        throw new Error('Unimplemented key structureSubType `' + currentProperty.structureSubType + '` in ArrayProperty `' + currentProperty.name + '`');
                                    }
                            }
                        }

                        break;

                    default:
                        this.worker.postMessage({command: 'alertParsing'});
                        if(typeof Sentry !== 'undefined')
                        {
                            Sentry.setContext('currentProperty', currentProperty);
                        }
                        throw new Error('Unimplemented type `' + currentProperty.value.type + '` in ArrayProperty `' + currentProperty.name + '`');
                }

                break;

            case 'MapProperty':
                currentProperty.value = {
                    keyType         : this.streamReader.readString(),
                    valueType       : this.streamReader.readString(),
                    values          : []
                };

                    this.streamReader.skipBytes(1);
                    currentProperty.value.modeType = this.streamReader.readInt();

                    if(currentProperty.value.modeType === 2)
                    {
                        currentProperty.value.modeUnk2 = this.streamReader.readString();
                        currentProperty.value.modeUnk3 = this.streamReader.readString();
                    }
                    if(currentProperty.value.modeType === 3)
                    {
                        currentProperty.value.modeUnk1 = this.streamReader.readRaw(9);
                        currentProperty.value.modeUnk2 = this.streamReader.readString();
                        currentProperty.value.modeUnk3 = this.streamReader.readString();
                    }

                let currentMapPropertyCount = this.streamReader.readInt();
                    for(let iMapProperty = 0; iMapProperty < currentMapPropertyCount; iMapProperty++)
                    {
                        let mapPropertyKey;
                        let mapPropertySubProperties    = [];

                            switch(currentProperty.value.keyType)
                            {
                                case 'IntProperty':
                                    mapPropertyKey = this.streamReader.readInt();
                                    break;
                                case 'Int64Property':
                                    mapPropertyKey = this.streamReader.readLong();
                                    break;
                                case 'NameProperty':
                                case 'StrProperty':
                                    mapPropertyKey = this.streamReader.readString();
                                    break;
                                case 'ObjectProperty':
                                    mapPropertyKey = this.readObjectProperty({});
                                    break;
                                case 'EnumProperty':
                                    mapPropertyKey = {
                                        name        : this.streamReader.readString()
                                    };
                                    break;
                                case 'StructProperty':
                                    mapPropertyKey = [];
                                    while(true)
                                    {
                                        let subMapPropertyValue = this.readProperty();
                                            if(subMapPropertyValue === null)
                                            {
                                                break;
                                            }

                                        mapPropertyKey.push(subMapPropertyValue);
                                    }
                                    break;
                                default:
                                    this.worker.postMessage({command: 'alertParsing'});
                                    if(typeof Sentry !== 'undefined')
                                    {
                                        Sentry.setContext('currentProperty', currentProperty);
                                    }
                                    throw new Error('Unimplemented key type `' + currentProperty.value.keyType + '` in MapProperty `' + currentProperty.name + '`');
                            }

                            switch(currentProperty.value.valueType)
                            {
                                case 'ByteProperty':
                                    if(currentProperty.value.keyType === 'StrProperty')
                                    {
                                        mapPropertySubProperties = this.streamReader.readString();
                                    }
                                    else
                                    {
                                        mapPropertySubProperties = this.streamReader.readByte();
                                    }
                                    break;
                                case 'BoolProperty':
                                    mapPropertySubProperties = this.streamReader.readByte();
                                    break;
                                case 'IntProperty':
                                    mapPropertySubProperties = this.streamReader.readInt();
                                    break;
                                case 'StrProperty':
                                    mapPropertySubProperties = this.streamReader.readString();
                                    break;
                                case 'ObjectProperty':
                                    mapPropertySubProperties = this.readObjectProperty({});
                                    break;
                                case 'StructProperty':
                                    if(parentType === 'LBBalancerData')
                                    {
                                        mapPropertySubProperties.mNormalIndex   = this.streamReader.readInt();
                                        mapPropertySubProperties.mOverflowIndex = this.streamReader.readInt();
                                        mapPropertySubProperties.mFilterIndex   = this.streamReader.readInt();
                                    }
                                    else
                                    {
                                        while(true)
                                        {
                                            let subMapProperty = this.readProperty();
                                                if(subMapProperty === null)
                                                {
                                                    break;
                                                }

                                            mapPropertySubProperties.push(subMapProperty);
                                        }
                                    }
                                    break;
                                default:
                                    this.worker.postMessage({command: 'alertParsing'});
                                    if(typeof Sentry !== 'undefined')
                                    {
                                        Sentry.setContext('currentProperty', currentProperty);
                                    }
                                    throw new Error('Unimplemented value type `' + currentProperty.value.valueType + '` in MapProperty `' + currentProperty.name + '`');
                            }

                        currentProperty.value.values[iMapProperty]    = {
                            key     : mapPropertyKey,
                            value   : mapPropertySubProperties
                        };
                    }
                break;

            case 'StructProperty':
                currentProperty.value = {type: this.streamReader.readString()};
                this.streamReader.skipBytes(17); // 0 0 0 0 + skipByte(1)

                switch(currentProperty.value.type)
                {
                    case 'Color':
                        currentProperty.value.values = {
                            b           : this.streamReader.readByte(),
                            g           : this.streamReader.readByte(),
                            r           : this.streamReader.readByte(),
                            a           : this.streamReader.readByte()
                        };

                        break;

                    case 'LinearColor':
                        currentProperty.value.values ={
                            r           : this.streamReader.readFloat(),
                            g           : this.streamReader.readFloat(),
                            b           : this.streamReader.readFloat(),
                            a           : this.streamReader.readFloat()
                        };
                        break;

                    case 'Vector':
                    case 'Rotator':
                        currentProperty.value.values = {
                            x           : this.streamReader.readFloat(),
                            y           : this.streamReader.readFloat(),
                            z           : this.streamReader.readFloat()
                        };

                        break;

                    case 'Vector2D': // Mod?
                        currentProperty.value.values = {
                            x           : this.streamReader.readFloat(),
                            y           : this.streamReader.readFloat()
                        };

                        break;

                    case 'Quat':
                    case 'Vector4':
                        currentProperty.value.values = {
                            a           : this.streamReader.readFloat(),
                            b           : this.streamReader.readFloat(),
                            c           : this.streamReader.readFloat(),
                            d           : this.streamReader.readFloat()
                        };

                        break;

                    case 'Box':
                        currentProperty.value.min = {
                            x           : this.streamReader.readFloat(),
                            y           : this.streamReader.readFloat(),
                            z           : this.streamReader.readFloat()
                        };
                        currentProperty.value.max = {
                            x           : this.streamReader.readFloat(),
                            y           : this.streamReader.readFloat(),
                            z           : this.streamReader.readFloat()
                        };
                        currentProperty.value.isValid = this.streamReader.readByte();

                        break;

                    case 'RailroadTrackPosition':
                        currentProperty.value               = this.readObjectProperty(currentProperty.value);
                        currentProperty.value.offset        = this.streamReader.readFloat();
                        currentProperty.value.forward       = this.streamReader.readFloat();

                        break;

                    case 'TimerHandle':
                        currentProperty.value.handle        = this.streamReader.readString();

                        break;

                    case 'Guid': // MOD?
                        currentProperty.value.guid          = this.streamReader.readRaw(16);
                        break;

                    case 'InventoryItem':
                        currentProperty.value.unk1          = this.streamReader.readInt();
                        currentProperty.value.itemName      = this.streamReader.readString();
                        currentProperty.value               = this.readObjectProperty(currentProperty.value);
                        currentProperty.value.properties    = [];
                        currentProperty.value.properties.push(this.readProperty());
                        break;

                    case 'FluidBox':
                        currentProperty.value.value         = this.streamReader.readFloat();
                        break;

                    case 'SlateBrush': // MOD?
                        currentProperty.value.unk1          = this.streamReader.readString();
                        break;

                    case 'DateTime': // MOD: Power Suit
                        currentProperty.value.dateTime      = this.streamReader.readLong();
                        break;

                    case 'FINNetworkTrace': // MOD: FicsIt-Networks
                        currentProperty.value.values        = this.readFINNetworkTrace();
                        break;
                    case 'FINLuaProcessorStateStorage': // MOD: FicsIt-Networks
                        currentProperty.value.values        = this.readFINLuaProcessorStateStorage();
                        break;
                    case 'FICFrameRange': // https://github.com/Panakotta00/FicsIt-Cam/blob/c55e254a84722c56e1badabcfaef1159cd7d2ef1/Source/FicsItCam/Public/Data/FICTypes.h#L34
                        currentProperty.value.begin         = this.streamReader.readLong();
                        currentProperty.value.end           = this.streamReader.readLong();
                        break;

                    default: // Try normalised structure, then throw Error if not working...
                        try
                        {
                            currentProperty.value.values = [];
                            while(true)
                            {
                                let subStructProperty = this.readProperty(currentProperty.value.type);
                                    if(subStructProperty === null)
                                    {
                                        break;
                                    }

                                currentProperty.value.values.push(subStructProperty);

                                if(subStructProperty.value !== undefined && subStructProperty.value.properties !== undefined && subStructProperty.value.properties.length === 1 && subStructProperty.value.properties[0] === null)
                                {
                                    break;
                                }
                            }
                        }
                        catch(error)
                        {
                            this.worker.postMessage({command: 'alertParsing'});
                            if(typeof Sentry !== 'undefined')
                            {
                                Sentry.setContext('currentProperty', currentProperty);
                            }
                            throw new Error('Unimplemented type `' + currentProperty.value.type + '` in StructProperty `' + currentProperty.name + '`');
                        }
                }

                break;

            case 'SetProperty':
                currentProperty.value = {type: this.streamReader.readString(), values: []};
                this.streamReader.skipBytes(5); // skipByte(1) + 0

                let setPropertyLength = this.streamReader.readInt();
                for(let iSetProperty = 0; iSetProperty < setPropertyLength; iSetProperty++)
                {
                    switch(currentProperty.value.type)
                    {
                        case 'ObjectProperty':
                            currentProperty.value.values.push(this.readObjectProperty({}));
                            break;
                        case 'StructProperty':
                            if(this.header.saveVersion >= 29 && parentType === '/Script/FactoryGame.FGFoliageRemoval')
                            {
                                currentProperty.value.values.push({
                                    x: this.streamReader.readFloat(),
                                    y: this.streamReader.readFloat(),
                                    z: this.streamReader.readFloat()
                                });
                                break;
                            }
                            // MOD: FicsIt-Networks
                            currentProperty.value.values.push(this.readFINNetworkTrace());
                            break;
                        case 'NameProperty':  // MOD: Sweet Transportal
                            currentProperty.value.values.push({name: this.streamReader.readString()});
                            break;
                        case 'IntProperty':  // MOD: ???
                            currentProperty.value.values.push({int: this.streamReader.readInt()});
                            break;
                        default:
                           this.worker.postMessage({command: 'alertParsing'});
                            if(typeof Sentry !== 'undefined')
                            {
                                Sentry.setContext('currentProperty', currentProperty);
                            }
                            throw new Error('Unimplemented type `' + currentProperty.value.type + '` in SetProperty `' + currentProperty.name + '` (' + this.streamReader.bytesRead + ')');
                    }
                }

                break;

            default:
                this.worker.postMessage({command: 'alertParsing'});
                if(typeof Sentry !== 'undefined')
                {
                    Sentry.setContext('currentProperty', currentProperty);
                }
                throw new Error('Unimplemented type `' + currentProperty.type + '` in Property `' + currentProperty.name + '` (' + this.streamReader.bytesRead + ')');
        }

        return currentProperty;
    }


    /*
    // ETextHistoryType
    const HISTORYTYPE_BASE = 0;
    const HISTORYTYPE_NAMEDFORMAT = 1;
    const HISTORYTYPE_ORDEREDFORMAT = 2;
    const HISTORYTYPE_ARGUMENTFORMAT = 3;
    const HISTORYTYPE_ASNUMBER = 4;
    const HISTORYTYPE_ASPERCENT = 5;
    const HISTORYTYPE_ASCURRENCY = 6;
    const HISTORYTYPE_ASDATE = 7;
    const HISTORYTYPE_ASTIME = 8;
    const HISTORYTYPE_ASDATETIME = 9;
    const HISTORYTYPE_TRANSFORM = 10;
    const HISTORYTYPE_STRINGTABLEENTRY = 11;
    const HISTORYTYPE_NONE = 255; // -1
    // EFormatArgumentType
    const FORMATARGUMENTTYPE_INT = 0;
    const FORMATARGUMENTTYPE_UINT = 1;
    const FORMATARGUMENTTYPE_FLOAT = 2;
    const FORMATARGUMENTTYPE_DOUBLE = 3;
    const FORMATARGUMENTTYPE_TEXT = 4;
    const FORMATARGUMENTTYPE_GENDER = 5;
    */
    readTextProperty(currentProperty)
    {
        currentProperty.flags       = this.streamReader.readInt();
        currentProperty.historyType = this.streamReader.readByte();

        switch(currentProperty.historyType)
        {
            // HISTORYTYPE_BASE
            case 0:
                currentProperty.namespace       = this.streamReader.readString();
                currentProperty.key             = this.streamReader.readString();
                currentProperty.value           = this.streamReader.readString();
                break;
            // HISTORYTYPE_NAMEDFORMAT
            case 1:
            // HISTORYTYPE_ARGUMENTFORMAT
            case 3:
                currentProperty.sourceFmt       = this.readTextProperty({});

                currentProperty.argumentsCount  = this.streamReader.readInt();
                currentProperty.arguments       = [];

                for(let i = 0; i < currentProperty.argumentsCount; i++)
                {
                    let currentArgumentsData                = {};
                        currentArgumentsData.name           = this.streamReader.readString();
                        currentArgumentsData.valueType      = this.streamReader.readByte();

                        switch(currentArgumentsData.valueType)
                        {
                            case 4:
                                currentArgumentsData.argumentValue    = this.readTextProperty({});
                                break;
                            default:
                                this.worker.postMessage({command: 'alertParsing'});
                                if(typeof Sentry !== 'undefined')
                                {
                                    Sentry.setContext('currentProperty', currentProperty);
                                    Sentry.setContext('currentArgumentsData', currentArgumentsData);
                                }
                                throw new Error('Unimplemented FormatArgumentType `' + currentArgumentsData.valueType + '` in TextProperty `' + currentProperty.name + '`');
                        }

                    currentProperty.arguments.push(currentArgumentsData);
                }
                break;
            // See: https://github.com/EpicGames/UnrealEngine/blob/4.25/Engine/Source/Runtime/Core/Private/Internationalization/TextHistory.cpp#L2268
            // HISTORYTYPE_TRANSFORM
            case 10:
                currentProperty.sourceText          = this.readTextProperty({});
                currentProperty.transformType       = this.streamReader.readByte();
                break;
            // HISTORYTYPE_NONE
            case 255:
                // See: https://github.com/EpicGames/UnrealEngine/blob/4.25/Engine/Source/Runtime/Core/Private/Internationalization/Text.cpp#L894
                if(this.header.buildVersion >= 140822)
                {
                    currentProperty.hasCultureInvariantString   = this.streamReader.readInt();

                    if(currentProperty.hasCultureInvariantString === 1)
                    {
                        currentProperty.value = this.streamReader.readString();
                    }
                }
                break;
            default:
                this.worker.postMessage({command: 'alertParsing'});
                if(typeof Sentry !== 'undefined')
                {
                    Sentry.setContext('currentProperty', currentProperty);
                }
                throw new Error('Unimplemented historyType `' + currentProperty.historyType + '` in TextProperty `' + currentProperty.name + '`');
        }

        return currentProperty;
    }

    readObjectProperty(currentProperty)
    {
        let levelName   = this.streamReader.readString();
            if(levelName !== 'Persistent_Level')
            {
                currentProperty.levelName = levelName;
            }
        currentProperty.pathName  = this.streamReader.readString();

        return currentProperty;
    }

    /*
     * FicsIt-Networks properties
     */
    readFINGPUT1BufferPixel()
    {
        return {
            character           : this.streamReader.readRaw(2),
            foregroundColor     : {
                r : this.streamReader.readFloat(),
                g : this.streamReader.readFloat(),
                b : this.streamReader.readFloat(),
                a : this.streamReader.readFloat()
            },
            backgroundColor     : {
                r : this.streamReader.readFloat(),
                g : this.streamReader.readFloat(),
                b : this.streamReader.readFloat(),
                a : this.streamReader.readFloat()
            }
        };
    }

    // https://github.com/CoderDE/FicsIt-Networks/blob/ab918a81a8a7527aec0cf6cd35270edfc5a1ddfe/Source/FicsItNetworks/Network/FINNetworkTrace.cpp#L154
    readFINNetworkTrace()
    {
        let data            = {};
            data.levelName  = this.streamReader.readString();
            data.pathName   = this.streamReader.readString();

            let hasPrev = this.streamReader.readInt();
                if(hasPrev === 1)
                {
                    data.prev  = this.readFINNetworkTrace();
                }
            let hasStep = this.streamReader.readInt();
                if(hasStep === 1)
                {
                    data.step  = this.streamReader.readString();
                }

        return data;
    }

    // https://github.com/CoderDE/FicsIt-Networks/blob/master/Source/FicsItNetworks/FicsItKernel/Processor/Lua/LuaProcessorStateStorage.cpp#L6
    readFINLuaProcessorStateStorage()
    {
        let data            = {trace: [], reference: [], structs: []};
        let countTrace      = this.streamReader.readInt();
            for(let i = 0; i < countTrace; i++)
            {
                data.trace.push(this.readFINNetworkTrace());
            }

        let countReference  = this.streamReader.readInt();
            for(let i = 0; i < countReference; i++)
            {
                data.reference.push({
                    levelName: this.streamReader.readString(),
                    pathName: this.streamReader.readString()
                });
            }

        data.thread         = this.streamReader.readString();
        data.globals        = this.streamReader.readString();

        let countStructs    = this.streamReader.readInt();
            data.structs    = [];

            for(let i = 0; i < countStructs; i++)
            {
                let structure = {};
                    structure.unk1  = this.streamReader.readInt();
                    structure.unk2  = this.streamReader.readString();

                    switch(structure.unk2)
                    {
                        case '/Script/CoreUObject.Vector':
                            structure.x         = this.streamReader.readFloat();
                            structure.y         = this.streamReader.readFloat();
                            structure.z         = this.streamReader.readFloat();
                            break;
                        case '/Script/CoreUObject.LinearColor':
                            structure.r         = this.streamReader.readFloat();
                            structure.g         = this.streamReader.readFloat();
                            structure.b         = this.streamReader.readFloat();
                            structure.a         = this.streamReader.readFloat();
                            break;
                        case '/Script/FactoryGame.InventoryStack':
                            structure.unk3      = this.streamReader.readInt();
                            structure.unk4      = this.streamReader.readString();
                            structure.unk5      = this.streamReader.readInt();
                            structure.unk6      = this.streamReader.readInt();
                            structure.unk7      = this.streamReader.readInt();
                            break;
                        case '/Script/FactoryGame.ItemAmount':
                            structure.unk3      = this.streamReader.readInt();
                            structure.unk4      = this.streamReader.readString();
                            structure.unk5      = this.streamReader.readInt();
                            break;
                        case '/Script/FicsItNetworks.FINTrackGraph':
                            structure.trace     = this.readFINNetworkTrace();
                            structure.trackId   = this.streamReader.readInt();
                            break;
                        case '/Script/FicsItNetworks.FINInternetCardHttpRequestFuture': // Skip!
                        case '/Script/FactoryGame.InventoryItem': // Skip!
                            break;
                        case '/Script/FicsItNetworks.FINGPUT1Buffer':
                            structure.x         = this.streamReader.readInt();
                            structure.y         = this.streamReader.readInt();
                            structure.size      = this.streamReader.readInt();
                            structure.name      = this.streamReader.readString();
                            structure.type      = this.streamReader.readString();
                            structure.length    = this.streamReader.readInt();
                            structure.buffer    = [];
                                for(let size = 0; size < structure.size; size++)
                                {
                                    structure.buffer.push(this.readFINGPUT1BufferPixel());
                                }
                            structure.unk3      = this.streamReader.readRaw(45); //TODO: Not sure at all!
                            break;
                        default:
                            this.worker.postMessage({command: 'alertParsing'});
                            if(typeof Sentry !== 'undefined')
                            {
                                Sentry.setContext('currentData', data);
                            }
                            throw new Error('Unimplemented `' + structure.unk2 + '` in readFINLuaProcessorStateStorage');
                            break;
                    }

                    data.structs.push(structure);
            }

        return data;
    }
};

self.onmessage = function(e){
    return new SaveParser_Read(self, e.data);
};