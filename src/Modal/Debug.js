import SubSystem_Circuit                        from '../SubSystem/Circuit.js';

export default class Modal_Debug
{
    static getHTML(marker)
    {
        let baseLayout          = marker.baseLayout;
        let currentObject       = baseLayout.saveGameParser.getTargetObject(marker.relatedTarget.options.pathName);
        let html                = [];
        let htmlChildren        = [];
        let childrenPathName    = [];
        let extraPathName       = [];

        //html.push('<div class="alert alert-danger">Be aware that manually editing the save can lead to unexpected errors.</div>');

        if(currentObject.children !== undefined)
        {
            for(let i = 0; i < currentObject.children.length; i++)
            {
                childrenPathName.push(currentObject.children[i].pathName);
            }
        }

        if(currentObject.className === '/Game/FactoryGame/Buildable/Factory/SpaceElevator/Build_SpaceElevator.Build_SpaceElevator_C')
        {
            extraPathName.push('Persistent_Level:PersistentLevel.GamePhaseManager');
        }

        let extraProperties = ['mOwningSpawner', 'mInfo', 'mStationDrone', 'mCurrentAction', 'mActionsToExecute', 'mOwnedPawn', 'mTargetNodeLinkedList', 'mTargetList', 'mSignPoles', 'mBottomSnappedConnection', 'mTopSnappedConnection'];
            for(let i = 0; i < extraProperties.length; i++)
            {
                let extraProperty = baseLayout.getObjectProperty(currentObject, extraProperties[i]);
                    if(extraProperty !== null)
                    {
                        if(['mSignPoles', 'mActionsToExecute'].includes(extraProperties[i]))
                        {
                            for(let j = 0; j < extraProperty.values.length; j++)
                            {
                                extraPathName.push(extraProperty.values[j].pathName);
                            }
                        }
                        else
                        {
                            extraPathName.push(extraProperty.pathName);
                        }
                    }
            }

        let circuitSubSystem    = new SubSystem_Circuit({baseLayout: baseLayout});
            if(currentObject.className === '/Game/FactoryGame/Buildable/Factory/PowerSwitch/Build_PowerSwitch.Build_PowerSwitch_C')
            {
                let objectCircuitA       = circuitSubSystem.getObjectCircuit(currentObject, 'PowerConnection1');
                    if(objectCircuitA !== null)
                    {
                        extraPathName.push(objectCircuitA.pathName);
                    }
                let objectCircuitB       = circuitSubSystem.getObjectCircuit(currentObject, 'PowerConnection2');
                    if(objectCircuitB !== null)
                    {
                        extraPathName.push(objectCircuitB.pathName);
                    }
            }
            else
            {
                let objectCircuit       = circuitSubSystem.getObjectCircuit(currentObject);
                    if(objectCircuit !== null)
                    {
                        extraPathName.push(objectCircuit.pathName);
                    }
            }

            html.push('<ul class="nav nav-tabs nav-fill">');
            html.push('<li class="nav-item"><span class="nav-link active" data-toggle="tab" href="#advancedDebugObject-MAIN" style="cursor:pointer;">Main object</span></li>');

            if(currentObject.children !== undefined)
            {
                for(let i = 0; i < currentObject.children.length; i++)
                {
                    html.push('<li class="nav-item"><span class="nav-link" style="text-transform: none;cursor:pointer;" data-toggle="tab" href="#advancedDebugObject-' + currentObject.children[i].pathName.split('.').pop() + '">.' + currentObject.children[i].pathName.split('.').pop() + '</span></li>');

                    let currentChildren = baseLayout.saveGameParser.getTargetObject(currentObject.children[i].pathName);
                        if(currentChildren !== null)
                        {
                            htmlChildren.push('<div class="tab-pane fade" id="advancedDebugObject-' + currentObject.children[i].pathName.split('.').pop() + '">');
                            htmlChildren.push(Modal_Debug.getJsonViewer(currentChildren));
                            htmlChildren.push('</div>');

                            let mHiddenConnections = baseLayout.getObjectProperty(currentChildren, 'mHiddenConnections');
                                if(mHiddenConnections !== null)
                                {
                                    for(let j = 0; j < mHiddenConnections.values.length; j++)
                                    {
                                        if(childrenPathName.includes(mHiddenConnections.values[j].pathName) === false && extraPathName.includes(mHiddenConnections.values[j].pathName) === false)
                                        {
                                            extraPathName.push(mHiddenConnections.values[j].pathName);
                                        }
                                    }
                                }
                        }
                        else
                        {
                            console.log('Missing children: ' + currentObject.children[i].pathName);
                        }
                }
            }

            let currentObjectPipeNetworkPathName = baseLayout.getObjectPipeNetwork(currentObject);
                if(currentObjectPipeNetworkPathName !== null)
                {
                    extraPathName.push(currentObjectPipeNetworkPathName.pathName);
                }

            for(let j = 0; j < extraPathName.length; j++)
            {
                html.push('<li class="nav-item"><span class="nav-link" style="text-transform: none;cursor:pointer;" data-toggle="tab" href="#advancedDebugObject-' + extraPathName[j].replace(':', '-').replace('.', '-').replace('.', '-') + '">' + extraPathName[j].replace('Persistent_Level:', '') + '</span></li>');
            }

            html.push('</ul>');

            html.push('<div class="tab-content">');
            html.push('<div class="tab-pane fade show active" id="advancedDebugObject-MAIN">');
            html.push(Modal_Debug.getJsonViewer(currentObject));
            html.push('</div>');
            html.push(htmlChildren.join(''));

            for(let j = 0; j < extraPathName.length; j++)
            {
                let currentExtraObject = baseLayout.saveGameParser.getTargetObject(extraPathName[j]);
                    html.push('<div class="tab-pane fade" id="advancedDebugObject-' + extraPathName[j].replace(':', '-').replace('.', '-').replace('.', '-') + '">');
                    html.push(Modal_Debug.getJsonViewer(currentExtraObject));
                    html.push('</div>');
            }

            html.push('</div>');

        $('#genericModal .modal-title').empty().html('Advanced Debug - ' + marker.relatedTarget.options.pathName);
        $('#genericModal .modal-body').empty().html(html.join(''));

        $('#genericModal .modal-body .json-document').find('.json-toggle').click(function(){
            let target = $(this).toggleClass('collapsed').siblings('ul.json-dict, ol.json-array');
                target.toggle();

            if(target.is(':visible'))
            {
                target.siblings('.json-placeholder').remove();
            }
            else
            {
                let count       = target.children('li').length;
                let placeholder = count + (count > 1 ? ' items' : ' item');
                let name        = $(this).attr('data-name');
                    if(name !== undefined)
                    {
                        placeholder = name + ' (' + placeholder + ')';
                    }

                    target.after('<span class="json-placeholder">' + placeholder + '</span>');
            }
            return false;
        });
        $('#genericModal .modal-body .json-document').on('click', '.json-placeholder', function(){
            $(this).siblings('.json-toggle').click();
            return false;
        });
        $('#genericModal .modal-body').find('.json-toggle').click();

        setTimeout(function(){
            $('#genericModal').modal('show').modal('handleUpdate');
        }, 250);
    }

    static getJsonViewer(json)
    {
        let html = [];
            html.push('<div class="json-document" style="height: 75vh;overflow-y: scroll;">');
            html.push(Modal_Debug.jsonToHTML(json));
            html.push('</div>');

            return html.join('');
    }

    static jsonToHTML(json)
    {
        switch(typeof json)
        {
            case 'string':
                // Escape tags and quotes
                json = json
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/'/g, '&apos;')
                        .replace(/"/g, '&quot;');
                json = json.replace(/&quot;/g, '\\&quot;');
                return '<span class="json-string" style="user-select: text;">"' + json + '"</span>';
            case 'number':
            case 'boolean':
            case null:
                return '<span class="json-literal" style="user-select: text;">' + json + '</span>';
        }

        if(json instanceof Array)
        {
            if(json.length > 0)
            {
                let html = [];
                    for(let i = 0; i < json.length; ++i)
                    {
                        html.push('<li>');
                        if(json[i] instanceof Object && Object.keys(json[i]).length > 0)
                        {
                            if(json[i].name !== undefined)
                            {
                                html.push('<span class="json-toggle" data-name="' + json[i].name + '"></span>');
                            }
                            else
                            {
                                html.push('<span class="json-toggle"></span>');
                            }
                        }
                        html.push(Modal_Debug.jsonToHTML(json[i]));

                        if(i < (json.length - 1))
                        {
                            html.push(',');
                        }
                        html.push('</li>');
                    }

                return '[<ol class="json-array">' + html.join('') + '</ol>]';
            }

            return '[]';
        }

        if(typeof json === 'object')
        {
            let keyCount = Object.keys(json).length;
                if(keyCount > 0)
                {
                    let html = [];
                        for(let key in json)
                        {
                            if(Object.prototype.hasOwnProperty.call(json, key))
                            {
                                html.push('<li>');
                                let keyRepr = '<span class="json-string">"' + key + '"</span>';
                                    if(json[key] instanceof Object && Object.keys(json[key]).length > 0)
                                    {
                                        if(json[key].name !== undefined)
                                        {
                                            html.push('<span class="json-toggle" data-name="' + json[key].name + '">' + keyRepr + '</span>');
                                        }
                                        else
                                        {
                                            html.push('<span class="json-toggle">' + keyRepr + '</span>');
                                        }
                                    }
                                    else
                                    {
                                        html.push(keyRepr);
                                    }
                                html.push(': ' + Modal_Debug.jsonToHTML(json[key]));

                                if(--keyCount > 0)
                                {
                                    html.push(',');
                                }
                                html.push('</li>');
                            }
                        }

                    return '{<ul class="json-dict">' + html.join('') + '</ul>}';
                }

            return '{}';
        }

        return '';
    }
}