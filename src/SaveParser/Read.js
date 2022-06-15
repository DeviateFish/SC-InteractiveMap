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
        this.streamReader       = new StreamReader(async () => this.inflateNextChunk());

        this.parseSave();
    }

    async parseSave()
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
                await this.streamReader.skipBytes(4);

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

    async parseByLevels() {
        let collectables    = [];
        let nbLevels        = await this.streamReader.readInt();
        let levels          = [];

        for(let j = 0; j <= nbLevels; j++)
        {
            let levelName           = (j === nbLevels) ? 'Level Persistent_Level' : await this.streamReader.readString();
                levels.push(levelName);
                await this.streamReader.readInt();//let objectsLength       = await this.streamReader.readInt();
            let countObjects        = await this.streamReader.readInt();
            let entitiesToObjects   = [];

            for(let i = 0; i < countObjects; i++)
            {
                let objectType = await this.streamReader.readInt();
                    switch(objectType)
                    {
                        case 0:
                            let object                          = await this.readObject();
                                this.objects[object.pathName]   = object;
                                entitiesToObjects[i]            = object.pathName;
                            break;
                        case 1:
                            let actor                           = await this.readActor();
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

            let countCollected = await this.streamReader.readInt();
                if(countCollected > 0)
                {
                    for(let i = 0; i < countCollected; i++)
                    {
                        let collectable = await this.readObjectProperty({});
                            collectables.push(collectable);
                            //console.log(collectable, this.objects[collectable.pathName])
                    }
                }

                await this.streamReader.readInt();//let entitiesLength      = await this.streamReader.readInt();
            let countEntities       = await this.streamReader.readInt();
            let objectsToFlush      = {};

            //console.log(levelName, countObjects, entitiesLength);

            for(let i = 0; i < countEntities; i++)
            {
                await this.readEntity(entitiesToObjects[i]);

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
            countCollected = await this.streamReader.readInt();
            if(countCollected > 0)
            {
                for(let i = 0; i < countCollected; i++)
                {
                    await this.readObjectProperty({});
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
    async parseObjects()
    {
        let countObjects                = await this.streamReader.readInt();
        let entitiesToObjects           = [];
            console.log('Parsing: ' + countObjects + ' objects...');
            this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s objects (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countObjects), 0]});
            this.worker.postMessage({command: 'loaderProgress', percentage: 30});

            for(let i = 0; i < countObjects; i++)
            {
                let objectType = await this.streamReader.readInt();
                    switch(objectType)
                    {
                        case 0:
                            let object                          = await this.readObject();
                                this.objects[object.pathName]   = object;
                                entitiesToObjects[i]            = object.pathName;
                            break;
                        case 1:
                            let actor                           = await this.readActor();
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

        return this.parseEntities(entitiesToObjects, 0, await this.streamReader.readInt());
    }

    /*
     * Progress bar from 45 to 60%
     */
    async parseEntities(entitiesToObjects, i, countEntities)
    {
        console.log('Parsing: ' + countEntities + ' entities...');
        this.worker.postMessage({command: 'loaderMessage', message: 'MAP\\SAVEPARSER\\Parsing %1$s entities (%2$s%)...', replace: [new Intl.NumberFormat(this.language).format(countEntities), 0]});
        this.worker.postMessage({command: 'loaderProgress', percentage: 40});

        let objectsToFlush = {};

        for(i; i < countEntities; i++)
        {
            await this.readEntity(entitiesToObjects[i]);

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

    async parseCollectables()
    {
        let collectables    = [];
        let countCollected  = await this.streamReader.readInt();
            for(let i = 0; i < countCollected; i++)
            {
                collectables.push(await this.readObjectProperty({}));
            }

        this.worker.postMessage({command: 'transferData', data: {collectables: collectables}});

        delete this.bufferView;
        this.worker.postMessage({command: 'endSaveLoading'});
    }

    /*
     * Main objects
     */
    async readObject()
    {
        let object                  = {type : 0};
            object.className        = await this.streamReader.readString();
            object                  = await this.readObjectProperty(object);
            object.outerPathName    = await this.streamReader.readString();

        return object;
    }

    async readActor()
    {
        let actor               = {type : 1};
            actor.className     = await this.streamReader.readString();
            actor               = await this.readObjectProperty(actor);

        let needTransform       = await this.streamReader.readInt();
            if(needTransform !== 0)
            {
                actor.needTransform = needTransform;
            }

            // {rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale3d: [1, 1, 1]}
            actor.transform     = {
                rotation            : [await this.streamReader.readFloat(), await this.streamReader.readFloat(), await this.streamReader.readFloat(), await this.streamReader.readFloat()],
                translation         : [await this.streamReader.readFloat(), await this.streamReader.readFloat(), await this.streamReader.readFloat()]
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

            let scale3d = [await this.streamReader.readFloat(), await this.streamReader.readFloat(), await this.streamReader.readFloat()];
                if(scale3d[0] !== 1 || scale3d[1] !== 1 || scale3d[2] !== 1)
                {
                    actor.transform.scale3d = scale3d
                }

        let wasPlacedInLevel       = await this.streamReader.readInt();
            if(wasPlacedInLevel !== 0) //TODO: Switch to 1?
            {
                actor.wasPlacedInLevel = wasPlacedInLevel;
            }

        return actor;
    }

    async readEntity(objectKey)
    {
        let entityLength                            = await this.streamReader.readInt();
        let startByte                               = this.streamReader.totalOffset;

        if(this.objects[objectKey].type === 1)
        {
            this.objects[objectKey].entity = await this.readObjectProperty({});

            let countChild  = await this.streamReader.readInt();
            if(countChild > 0)
            {
                this.objects[objectKey].children = [];

                for(let i = 0; i < countChild; i++)
                {
                    this.objects[objectKey].children.push(await this.readObjectProperty({}));
                }
            }
        }

        if((this.streamReader.totalOffset - startByte) === entityLength)
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
            this.objects[objectKey].extra   = {count: await this.streamReader.readInt(), items: []};
            let itemsLength                 = await this.streamReader.readInt();
            for(let i = 0; i < itemsLength; i++)
            {
                let currentItem             = {};
                let currentItemLength       = await this.streamReader.readInt();
                    if(currentItemLength !== 0)
                    {
                        currentItem.length  = currentItemLength;
                    }
                    currentItem.name        = await this.streamReader.readString();
                    await this.streamReader.readString(); //currentItem.levelName   = await this.streamReader.readString();
                    await this.streamReader.readString(); //currentItem.pathName    = await this.streamReader.readString();
                    currentItem.position    = await this.streamReader.readFloat();

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
                    this.objects[objectKey].extra   = {count: await this.streamReader.readInt(), game: []};
                    let gameLength                  = await this.streamReader.readInt();

                    for(let i = 0; i < gameLength; i++)
                    {
                        this.objects[objectKey].extra.game.push(await this.readObjectProperty({}));

                        if(i === 0 && this.objects[objectKey].className === '/Game/FactoryGame/-Shared/Blueprint/BP_GameState.BP_GameState_C')
                        {
                            this.worker.postMessage({command: 'transferData', data: {playerHostPathName: this.objects[objectKey].extra.game[0].pathName}});
                        }
                    }

                    break;
                case '/Game/FactoryGame/Character/Player/BP_PlayerState.BP_PlayerState_C':
                    let missingPlayerState                  = (startByte + entityLength) - this.streamReader.totalOffset;
                    this.objects[objectKey].missing         = await this.streamReader.peekRaw(missingPlayerState);

                    if(missingPlayerState > 0)
                    {
                        await this.streamReader.readInt(); // Skip count
                        let playerType = await this.streamReader.readByte();
                            switch(playerType)
                            {
                                case 248: // EOS
                                    await this.streamReader.readString();
                                    let eosStr                          = (await this.streamReader.readString()).split('|');
                                    this.objects[objectKey].eosId       = eosStr[0];
                                    break;
                                case 249: // EOS
                                    await this.streamReader.readString(); // EOS, then follow 17
                                case 17: // Old EOS
                                    let epicHexLength   = await this.streamReader.readByte();
                                    let epicHex         = '';
                                    for(let i = 0; i < epicHexLength; i++)
                                    {
                                        epicHex += (await this.streamReader.readByte()).toString(16).padStart(2, '0');
                                    }

                                    this.objects[objectKey].eosId       = epicHex.replace(/^0+/, '');
                                    break;
                                case 25: // Steam
                                    let steamHexLength  = await this.streamReader.readByte();
                                    let steamHex        = '';
                                    for(let i = 0; i < steamHexLength; i++)
                                    {
                                        steamHex += (await this.streamReader.readByte()).toString(16).padStart(2, '0');
                                    }

                                    this.objects[objectKey].steamId     = steamHex.replace(/^0+/, '');
                                    break;
                                case 8: // ???
                                    this.objects[objectKey].platformId  = await this.streamReader.readString();
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
                    let missingDrone                    = (startByte + entityLength) - this.streamReader.totalOffset;
                    this.objects[objectKey].missing     = await this.streamReader.readRaw(missingDrone);

                    break;
                case '/Game/FactoryGame/-Shared/Blueprint/BP_CircuitSubsystem.BP_CircuitSubsystem_C':
                    this.objects[objectKey].extra   = {count: await this.streamReader.readInt(), circuits: []};
                    let circuitsLength              = await this.streamReader.readInt();

                    for(let i = 0; i < circuitsLength; i++)
                    {
                        this.objects[objectKey].extra.circuits.push({
                            circuitId   : await this.streamReader.readInt(),
                            levelName   : await this.streamReader.readString(),
                            pathName    : await this.streamReader.readString()
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
                        count   : await this.streamReader.readInt(),
                        source  : await this.readObjectProperty({}),
                        target  : await this.readObjectProperty({})
                    };

                    break;
                case '/Game/FactoryGame/Buildable/Vehicle/Train/Locomotive/BP_Locomotive.BP_Locomotive_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Train/Wagon/BP_FreightWagon.BP_FreightWagon_C':
                    this.objects[objectKey].extra   = {count: await this.streamReader.readInt(), objects: []};
                    let trainLength                 = await this.streamReader.readInt();
                    for(let i = 0; i < trainLength; i++)
                    {
                        this.objects[objectKey].extra.objects.push({
                            name   : await this.streamReader.readString(),
                            unk    : await this.streamReader.readRaw(53)
                        });
                    }

                    this.objects[objectKey].extra.previous  = await this.readObjectProperty({});
                    this.objects[objectKey].extra.next      = await this.readObjectProperty({});
                    break;
                case '/Game/FactoryGame/Buildable/Vehicle/Tractor/BP_Tractor.BP_Tractor_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Truck/BP_Truck.BP_Truck_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Explorer/BP_Explorer.BP_Explorer_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Cyberwagon/Testa_BP_WB.Testa_BP_WB_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Golfcart/BP_Golfcart.BP_Golfcart_C':
                case '/Game/FactoryGame/Buildable/Vehicle/Golfcart/BP_GolfcartGold.BP_GolfcartGold_C':
                    this.objects[objectKey].extra   = {count: await this.streamReader.readInt(), objects: []};
                    let vehicleLength                   = await this.streamReader.readInt();
                    for(let i = 0; i < vehicleLength; i++)
                    {
                        this.objects[objectKey].extra.objects.push({
                            name   : await this.streamReader.readString(),
                            unk    : await this.streamReader.readRaw(53)
                        });
                    }

                    break;
                default:
                    let missingBytes = (startByte + entityLength) - this.streamReader.totalOffset;
                    if(missingBytes > 4)
                    {
                        this.objects[objectKey].missing = await this.streamReader.readRaw(missingBytes); // TODO
                        console.log('MISSING ' + missingBytes + '  BYTES', this.objects[objectKey]);
                    }
                    else
                    {
                        await this.streamReader.skipBytes(4);
                    }

                    break;
            }
        }
    }

    /*
     * Properties types
     */
    async readProperty(parentType = null)
    {
        let currentProperty         = {};
            currentProperty.name    = await this.streamReader.readString();

        if(currentProperty.name === 'None')
        {
            return null;
        }

        currentProperty.type    = await this.streamReader.readString();

        await this.streamReader.skipBytes(4); // Length of the property, this is calculated when writing back ;)

        let index = await this.streamReader.readInt();
            if(index !== 0)
            {
                currentProperty.index = index;
            }

        switch(currentProperty.type)
        {
            case 'BoolProperty':
                currentProperty.value = await this.streamReader.readByte();

                let unkBoolByte = await this.streamReader.readByte();
                    if(unkBoolByte === 1)
                    {
                        currentProperty.unkBool = await this.streamReader.readRaw(16);
                    }

                break;

            case 'Int8Property':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.streamReader.readInt8();

                break;

            case 'IntProperty':
            case 'UInt32Property': // Mod?
                let unkIntByte = await this.streamReader.readByte();
                    if(unkIntByte === 1)
                    {
                        currentProperty.unkInt = await this.streamReader.readRaw(16);
                    }
                currentProperty.value = await this.streamReader.readInt();

                break;

            case 'Int64Property':
            case 'UInt64Property':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.streamReader.readLong();

                break;

            case 'FloatProperty':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.streamReader.readFloat();

                break;

            case 'DoubleProperty':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.streamReader.readDouble();

                break;

            case 'StrProperty':
            case 'NameProperty':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.streamReader.readString();

                break;

            case 'ObjectProperty':
            case 'InterfaceProperty':
                await this.streamReader.skipBytes();
                currentProperty.value = await this.readObjectProperty({});
                break;

            case 'EnumProperty':
                let enumPropertyName = await this.streamReader.readString();
                await this.streamReader.skipBytes();
                currentProperty.value = {
                    name: enumPropertyName,
                    value: await this.streamReader.readString()
                };

                break;

            case 'ByteProperty':
                let enumName = await this.streamReader.readString(); //TODO
                await this.streamReader.skipBytes();

                if(enumName === 'None')
                {
                    currentProperty.value = {
                        enumName: enumName,
                        value: await this.streamReader.readByte()
                    };
                }
                else
                {
                    currentProperty.value = {
                        enumName: enumName,
                        valueName: await this.streamReader.readString()
                    };
                }

                break;

            case 'TextProperty':
                await this.streamReader.skipBytes();
                currentProperty             = await this.readTextProperty(currentProperty);

                break;

            case 'ArrayProperty':
                    currentProperty.value       = {type    : await this.streamReader.readString(), values  : []};
                    await this.streamReader.skipBytes();
                let currentArrayPropertyCount   = await this.streamReader.readInt();

                switch(currentProperty.value.type)
                {
                    case 'ByteProperty':
                        switch(currentProperty.name)
                        {
                            case 'mFogOfWarRawData':
                                for(let i = 0; i < (currentArrayPropertyCount / 4); i++)
                                {
                                    await this.streamReader.readByte(); // 0
                                    await this.streamReader.readByte(); // 0
                                    currentProperty.value.values.push(await this.streamReader.readByte());
                                    await this.streamReader.readByte(); // 255
                                }
                                break;
                            default:
                                for(let i = 0; i < currentArrayPropertyCount; i++)
                                {
                                    currentProperty.value.values.push(await this.streamReader.readByte());
                                }
                        }
                        break;

                    case 'BoolProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.streamReader.readByte());
                        }

                    case 'IntProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.streamReader.readInt());
                        }
                        break;

                    case 'FloatProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.streamReader.readFloat());
                        }
                        break;

                    case 'EnumProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push({name: await this.streamReader.readString()});
                        }
                        break;
                    case 'StrProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.streamReader.readString());
                        }
                        break;
                    case 'TextProperty': // ???
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.readTextProperty({}));
                        }
                        break;

                    case 'ObjectProperty':
                    case 'InterfaceProperty':
                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            currentProperty.value.values.push(await this.readObjectProperty({}));
                        }
                        break;

                    case 'StructProperty':
                        currentProperty.structureName       = await this.streamReader.readString();
                        currentProperty.structureType       = await this.streamReader.readString();

                        await this.streamReader.readInt(); // structureSize
                        await this.streamReader.readInt(); // 0

                        currentProperty.structureSubType    = await this.streamReader.readString();

                        let propertyGuid1 = await this.streamReader.readInt();
                        let propertyGuid2 = await this.streamReader.readInt();
                        let propertyGuid3 = await this.streamReader.readInt();
                        let propertyGuid4 = await this.streamReader.readInt();
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

                        await this.streamReader.skipBytes(1);

                        for(let i = 0; i < currentArrayPropertyCount; i++)
                        {
                            switch(currentProperty.structureSubType)
                            {
                                case 'InventoryItem': // MOD: FicsItNetworks
                                    currentProperty.value.values.push({
                                        unk1          : await this.streamReader.readInt(),
                                        itemName      : await this.streamReader.readString(),
                                        levelName     : await this.streamReader.readString(),
                                        pathName      : await this.streamReader.readString()
                                    });
                                    break;

                                case 'Guid':
                                    currentProperty.value.values.push(await this.streamReader.readRaw(16));
                                    break;

                                case 'FINNetworkTrace': // MOD: FicsIt-Networks
                                    currentProperty.value.values.push(await this.readFINNetworkTrace());
                                    break;

                                case 'Vector':
                                    currentProperty.value.values.push({
                                        x           : await this.streamReader.readFloat(),
                                        y           : await this.streamReader.readFloat(),
                                        z           : await this.streamReader.readFloat()
                                    });
                                    break;

                                case 'LinearColor':
                                    currentProperty.value.values.push({
                                        r : await this.streamReader.readFloat(),
                                        g : await this.streamReader.readFloat(),
                                        b : await this.streamReader.readFloat(),
                                        a : await this.streamReader.readFloat()
                                    });
                                    break;

                                // MOD: FicsIt-Networks
                                // See: https://github.com/CoderDE/FicsIt-Networks/blob/3472a437bcd684deb7096ede8f03a7e338b4a43d/Source/FicsItNetworks/Computer/FINComputerGPUT1.h#L42
                                case 'FINGPUT1BufferPixel':
                                    currentProperty.value.values.push(await this.readFINGPUT1BufferPixel());
                                    break;

                                default: // Try normalised structure, then throw Error if not working...
                                    try
                                    {
                                        let subStructProperties = [];
                                            while(true)
                                            {
                                                let subStructProperty = await this.readProperty();

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
                    keyType         : await this.streamReader.readString(),
                    valueType       : await this.streamReader.readString(),
                    values          : []
                };

                    await this.streamReader.skipBytes(1);
                    currentProperty.value.modeType = await this.streamReader.readInt();

                    if(currentProperty.value.modeType === 2)
                    {
                        currentProperty.value.modeUnk2 = await this.streamReader.readString();
                        currentProperty.value.modeUnk3 = await this.streamReader.readString();
                    }
                    if(currentProperty.value.modeType === 3)
                    {
                        currentProperty.value.modeUnk1 = await this.streamReader.readRaw(9);
                        currentProperty.value.modeUnk2 = await this.streamReader.readString();
                        currentProperty.value.modeUnk3 = await this.streamReader.readString();
                    }

                let currentMapPropertyCount = await this.streamReader.readInt();
                    for(let iMapProperty = 0; iMapProperty < currentMapPropertyCount; iMapProperty++)
                    {
                        let mapPropertyKey;
                        let mapPropertySubProperties    = [];

                            switch(currentProperty.value.keyType)
                            {
                                case 'IntProperty':
                                    mapPropertyKey = await this.streamReader.readInt();
                                    break;
                                case 'Int64Property':
                                    mapPropertyKey = await this.streamReader.readLong();
                                    break;
                                case 'NameProperty':
                                case 'StrProperty':
                                    mapPropertyKey = await this.streamReader.readString();
                                    break;
                                case 'ObjectProperty':
                                    mapPropertyKey = await this.readObjectProperty({});
                                    break;
                                case 'EnumProperty':
                                    mapPropertyKey = {
                                        name        : await this.streamReader.readString()
                                    };
                                    break;
                                case 'StructProperty':
                                    mapPropertyKey = [];
                                    while(true)
                                    {
                                        let subMapPropertyValue = await this.readProperty();
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
                                        mapPropertySubProperties = await this.streamReader.readString();
                                    }
                                    else
                                    {
                                        mapPropertySubProperties = await this.streamReader.readByte();
                                    }
                                    break;
                                case 'BoolProperty':
                                    mapPropertySubProperties = await this.streamReader.readByte();
                                    break;
                                case 'IntProperty':
                                    mapPropertySubProperties = await this.streamReader.readInt();
                                    break;
                                case 'StrProperty':
                                    mapPropertySubProperties = await this.streamReader.readString();
                                    break;
                                case 'ObjectProperty':
                                    mapPropertySubProperties = await this.readObjectProperty({});
                                    break;
                                case 'StructProperty':
                                    if(parentType === 'LBBalancerData')
                                    {
                                        mapPropertySubProperties.mNormalIndex   = await this.streamReader.readInt();
                                        mapPropertySubProperties.mOverflowIndex = await this.streamReader.readInt();
                                        mapPropertySubProperties.mFilterIndex   = await this.streamReader.readInt();
                                    }
                                    else
                                    {
                                        while(true)
                                        {
                                            let subMapProperty = await this.readProperty();
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
                currentProperty.value = {type: await this.streamReader.readString()};
                await this.streamReader.skipBytes(17); // 0 0 0 0 + skipByte(1)

                switch(currentProperty.value.type)
                {
                    case 'Color':
                        currentProperty.value.values = {
                            b           : await this.streamReader.readByte(),
                            g           : await this.streamReader.readByte(),
                            r           : await this.streamReader.readByte(),
                            a           : await this.streamReader.readByte()
                        };

                        break;

                    case 'LinearColor':
                        currentProperty.value.values ={
                            r           : await this.streamReader.readFloat(),
                            g           : await this.streamReader.readFloat(),
                            b           : await this.streamReader.readFloat(),
                            a           : await this.streamReader.readFloat()
                        };
                        break;

                    case 'Vector':
                    case 'Rotator':
                        currentProperty.value.values = {
                            x           : await this.streamReader.readFloat(),
                            y           : await this.streamReader.readFloat(),
                            z           : await this.streamReader.readFloat()
                        };

                        break;

                    case 'Vector2D': // Mod?
                        currentProperty.value.values = {
                            x           : await this.streamReader.readFloat(),
                            y           : await this.streamReader.readFloat()
                        };

                        break;

                    case 'Quat':
                    case 'Vector4':
                        currentProperty.value.values = {
                            a           : await this.streamReader.readFloat(),
                            b           : await this.streamReader.readFloat(),
                            c           : await this.streamReader.readFloat(),
                            d           : await this.streamReader.readFloat()
                        };

                        break;

                    case 'Box':
                        currentProperty.value.min = {
                            x           : await this.streamReader.readFloat(),
                            y           : await this.streamReader.readFloat(),
                            z           : await this.streamReader.readFloat()
                        };
                        currentProperty.value.max = {
                            x           : await this.streamReader.readFloat(),
                            y           : await this.streamReader.readFloat(),
                            z           : await this.streamReader.readFloat()
                        };
                        currentProperty.value.isValid = await this.streamReader.readByte();

                        break;

                    case 'RailroadTrackPosition':
                        currentProperty.value               = await this.readObjectProperty(currentProperty.value);
                        currentProperty.value.offset        = await this.streamReader.readFloat();
                        currentProperty.value.forward       = await this.streamReader.readFloat();

                        break;

                    case 'TimerHandle':
                        currentProperty.value.handle        = await this.streamReader.readString();

                        break;

                    case 'Guid': // MOD?
                        currentProperty.value.guid          = await this.streamReader.readRaw(16);
                        break;

                    case 'InventoryItem':
                        currentProperty.value.unk1          = await this.streamReader.readInt();
                        currentProperty.value.itemName      = await this.streamReader.readString();
                        currentProperty.value               = await this.readObjectProperty(currentProperty.value);
                        currentProperty.value.properties    = [];
                        currentProperty.value.properties.push(await this.readProperty());
                        break;

                    case 'FluidBox':
                        currentProperty.value.value         = await this.streamReader.readFloat();
                        break;

                    case 'SlateBrush': // MOD?
                        currentProperty.value.unk1          = await this.streamReader.readString();
                        break;

                    case 'DateTime': // MOD: Power Suit
                        currentProperty.value.dateTime      = await this.streamReader.readLong();
                        break;

                    case 'FINNetworkTrace': // MOD: FicsIt-Networks
                        currentProperty.value.values        = await this.readFINNetworkTrace();
                        break;
                    case 'FINLuaProcessorStateStorage': // MOD: FicsIt-Networks
                        currentProperty.value.values        = await this.readFINLuaProcessorStateStorage();
                        break;
                    case 'FICFrameRange': // https://github.com/Panakotta00/FicsIt-Cam/blob/c55e254a84722c56e1badabcfaef1159cd7d2ef1/Source/FicsItCam/Public/Data/FICTypes.h#L34
                        currentProperty.value.begin         = await this.streamReader.readLong();
                        currentProperty.value.end           = await this.streamReader.readLong();
                        break;

                    default: // Try normalised structure, then throw Error if not working...
                        try
                        {
                            currentProperty.value.values = [];
                            while(true)
                            {
                                let subStructProperty = await this.readProperty(currentProperty.value.type);
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
                currentProperty.value = {type: await this.streamReader.readString(), values: []};
                await this.streamReader.skipBytes(5); // skipByte(1) + 0

                let setPropertyLength = await this.streamReader.readInt();
                for(let iSetProperty = 0; iSetProperty < setPropertyLength; iSetProperty++)
                {
                    switch(currentProperty.value.type)
                    {
                        case 'ObjectProperty':
                            currentProperty.value.values.push(await this.readObjectProperty({}));
                            break;
                        case 'StructProperty':
                            if(this.header.saveVersion >= 29 && parentType === '/Script/FactoryGame.FGFoliageRemoval')
                            {
                                currentProperty.value.values.push({
                                    x: await this.streamReader.readFloat(),
                                    y: await this.streamReader.readFloat(),
                                    z: await this.streamReader.readFloat()
                                });
                                break;
                            }
                            // MOD: FicsIt-Networks
                            currentProperty.value.values.push(await this.readFINNetworkTrace());
                            break;
                        case 'NameProperty':  // MOD: Sweet Transportal
                            currentProperty.value.values.push({name: await this.streamReader.readString()});
                            break;
                        case 'IntProperty':  // MOD: ???
                            currentProperty.value.values.push({int: await this.streamReader.readInt()});
                            break;
                        default:
                           this.worker.postMessage({command: 'alertParsing'});
                            if(typeof Sentry !== 'undefined')
                            {
                                Sentry.setContext('currentProperty', currentProperty);
                            }
                            throw new Error('Unimplemented type `' + currentProperty.value.type + '` in SetProperty `' + currentProperty.name + '` (' + this.streamReader.totalOffset + ')');
                    }
                }

                break;

            default:
                this.worker.postMessage({command: 'alertParsing'});
                if(typeof Sentry !== 'undefined')
                {
                    Sentry.setContext('currentProperty', currentProperty);
                }
                throw new Error('Unimplemented type `' + currentProperty.type + '` in Property `' + currentProperty.name + '` (' + this.streamReader.totalOffset + ')');
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
    async readTextProperty(currentProperty)
    {
        currentProperty.flags       = await this.streamReader.readInt();
        currentProperty.historyType = await this.streamReader.readByte();

        switch(currentProperty.historyType)
        {
            // HISTORYTYPE_BASE
            case 0:
                currentProperty.namespace       = await this.streamReader.readString();
                currentProperty.key             = await this.streamReader.readString();
                currentProperty.value           = await this.streamReader.readString();
                break;
            // HISTORYTYPE_NAMEDFORMAT
            case 1:
            // HISTORYTYPE_ARGUMENTFORMAT
            case 3:
                currentProperty.sourceFmt       = await this.readTextProperty({});

                currentProperty.argumentsCount  = await this.streamReader.readInt();
                currentProperty.arguments       = [];

                for(let i = 0; i < currentProperty.argumentsCount; i++)
                {
                    let currentArgumentsData                = {};
                        currentArgumentsData.name           = await this.streamReader.readString();
                        currentArgumentsData.valueType      = await this.streamReader.readByte();

                        switch(currentArgumentsData.valueType)
                        {
                            case 4:
                                currentArgumentsData.argumentValue    = await this.readTextProperty({});
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
                currentProperty.sourceText          = await this.readTextProperty({});
                currentProperty.transformType       = await this.streamReader.readByte();
                break;
            // HISTORYTYPE_NONE
            case 255:
                // See: https://github.com/EpicGames/UnrealEngine/blob/4.25/Engine/Source/Runtime/Core/Private/Internationalization/Text.cpp#L894
                if(this.header.buildVersion >= 140822)
                {
                    currentProperty.hasCultureInvariantString   = await this.streamReader.readInt();

                    if(currentProperty.hasCultureInvariantString === 1)
                    {
                        currentProperty.value = await this.streamReader.readString();
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

    async readObjectProperty(currentProperty)
    {
        let levelName   = await this.streamReader.readString();
            if(levelName !== 'Persistent_Level')
            {
                currentProperty.levelName = levelName;
            }
        currentProperty.pathName  = await this.streamReader.readString();

        return currentProperty;
    }

    /*
     * FicsIt-Networks properties
     */
    async readFINGPUT1BufferPixel()
    {
        return {
            character           : await this.streamReader.readRaw(2),
            foregroundColor     : {
                r : await this.streamReader.readFloat(),
                g : await this.streamReader.readFloat(),
                b : await this.streamReader.readFloat(),
                a : await this.streamReader.readFloat()
            },
            backgroundColor     : {
                r : await this.streamReader.readFloat(),
                g : await this.streamReader.readFloat(),
                b : await this.streamReader.readFloat(),
                a : await this.streamReader.readFloat()
            }
        };
    }

    // https://github.com/CoderDE/FicsIt-Networks/blob/ab918a81a8a7527aec0cf6cd35270edfc5a1ddfe/Source/FicsItNetworks/Network/FINNetworkTrace.cpp#L154
    async readFINNetworkTrace()
    {
        let data            = {};
            data.levelName  = await this.streamReader.readString();
            data.pathName   = await this.streamReader.readString();

            let hasPrev = await this.streamReader.readInt();
                if(hasPrev === 1)
                {
                    data.prev  = await this.readFINNetworkTrace();
                }
            let hasStep = await this.streamReader.readInt();
                if(hasStep === 1)
                {
                    data.step  = await this.streamReader.readString();
                }

        return data;
    }

    // https://github.com/CoderDE/FicsIt-Networks/blob/master/Source/FicsItNetworks/FicsItKernel/Processor/Lua/LuaProcessorStateStorage.cpp#L6
    async readFINLuaProcessorStateStorage()
    {
        let data            = {trace: [], reference: [], structs: []};
        let countTrace      = await this.streamReader.readInt();
            for(let i = 0; i < countTrace; i++)
            {
                data.trace.push(await this.readFINNetworkTrace());
            }

        let countReference  = await this.streamReader.readInt();
            for(let i = 0; i < countReference; i++)
            {
                data.reference.push({
                    levelName: await this.streamReader.readString(),
                    pathName: await this.streamReader.readString()
                });
            }

        data.thread         = await this.streamReader.readString();
        data.globals        = await this.streamReader.readString();

        let countStructs    = await this.streamReader.readInt();
            data.structs    = [];

            for(let i = 0; i < countStructs; i++)
            {
                let structure = {};
                    structure.unk1  = await this.streamReader.readInt();
                    structure.unk2  = await this.streamReader.readString();

                    switch(structure.unk2)
                    {
                        case '/Script/CoreUObject.Vector':
                            structure.x         = await this.streamReader.readFloat();
                            structure.y         = await this.streamReader.readFloat();
                            structure.z         = await this.streamReader.readFloat();
                            break;
                        case '/Script/CoreUObject.LinearColor':
                            structure.r         = await this.streamReader.readFloat();
                            structure.g         = await this.streamReader.readFloat();
                            structure.b         = await this.streamReader.readFloat();
                            structure.a         = await this.streamReader.readFloat();
                            break;
                        case '/Script/FactoryGame.InventoryStack':
                            structure.unk3      = await this.streamReader.readInt();
                            structure.unk4      = await this.streamReader.readString();
                            structure.unk5      = await this.streamReader.readInt();
                            structure.unk6      = await this.streamReader.readInt();
                            structure.unk7      = await this.streamReader.readInt();
                            break;
                        case '/Script/FactoryGame.ItemAmount':
                            structure.unk3      = await this.streamReader.readInt();
                            structure.unk4      = await this.streamReader.readString();
                            structure.unk5      = await this.streamReader.readInt();
                            break;
                        case '/Script/FicsItNetworks.FINTrackGraph':
                            structure.trace     = await this.readFINNetworkTrace();
                            structure.trackId   = await this.streamReader.readInt();
                            break;
                        case '/Script/FicsItNetworks.FINInternetCardHttpRequestFuture': // Skip!
                        case '/Script/FactoryGame.InventoryItem': // Skip!
                            break;
                        case '/Script/FicsItNetworks.FINGPUT1Buffer':
                            structure.x         = await this.streamReader.readInt();
                            structure.y         = await this.streamReader.readInt();
                            structure.size      = await this.streamReader.readInt();
                            structure.name      = await this.streamReader.readString();
                            structure.type      = await this.streamReader.readString();
                            structure.length    = await this.streamReader.readInt();
                            structure.buffer    = [];
                                for(let size = 0; size < structure.size; size++)
                                {
                                    structure.buffer.push(await this.readFINGPUT1BufferPixel());
                                }
                            structure.unk3      = await this.streamReader.readRaw(45); //TODO: Not sure at all!
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