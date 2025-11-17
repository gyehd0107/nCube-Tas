/**
 * Created by Il Yeup, Ahn in KETI on 2017-02-23.
 */

/**
 * Copyright (c) 2018, OCEAN
 * All rights reserved.
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 * 3. The name of the author may not be used to endorse or promote products derived from this software without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const ip = require("ip");
const { nanoid } = require("nanoid");
const fs = require('fs');
const path = require('path');

let conf = {};
let cse = {};
let ae = {};
let cnt_arr = [];
let sub_arr = [];
let acp = {};
const AEI_STORE_PATH = path.join(__dirname, 'aei.json');
function loadStoredAeId() {
    try {
        const raw = fs.readFileSync(AEI_STORE_PATH);
        const parsed = JSON.parse(raw.toString());
        if (parsed && parsed.ae && parsed.ae.id) {
            return parsed.ae.id;
        }
    } catch (e) {
    }
    return null;
}

conf.useprotocol = 'http'; // 'http' or 'mqtt' or 'coap' or 'ws'

conf.sim = 'disable'; // enable or disable simulator

// build cse (Mobius4 defaults in this workspace)
cse = {
    host    : 'localhost',
    port    : '7599',
    name    : 'Mobius',
    id      : '/Mobius4',
    mqttport: '1883',
    wsport  : '7577',
};

// build ae (matches existing /Mobius/ae1 AE on Mobius4)
let ae_name = 'ae1';

ae = {
    name    : ae_name,
    id      : 'CAE1',
    parent  : '/' + cse.name,
    appid   : 'Nfactory_app',
    port    : '9727',
    bodytype: 'json',
    tasport : '3105',
};
const storedAeId = loadStoredAeId();
if (storedAeId) {
    ae.id = storedAeId;
}

// build cnt (Factorio bridge root container)
cnt_arr = [
    {
        parent: '/' + cse.name + '/' + ae.name,
        name  : 'factory_car',
    },
];

// build sub (monitor factory_car hierarchy cin events via MQTT notification)
sub_arr = [
    // {
    //     parent: '/' + cse.name + '/' + ae.name + '/factory_car',
    //     name  : 'sub-factory',
    //     nu    : 'mqtt://' + cse.host + ':' + cse.mqttport + '/' + ae.id + '?ct=json',
    // },
];

// for tas
let tas = {
    client: {
        connected: false,
    },

    connection: {
        host: 'localhost',
        port: 1883,
        endpoint: '',
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 4000,
        clientId: 'thyme_' + nanoid(15),
        username: 'keti_thyme',
        password: 'keti_thyme',
    },
};

// build acp: allow tas access to AE scope
acp.parent = '/' + cse.name + '/' + ae.name;
acp.name = 'acp-' + ae.name;
acp.id = ae.id;

conf.usesecure  = 'disable';

if(conf.usesecure === 'enable') {
    cse.mqttport = '8883';
}

conf.cse = cse;
conf.ae = ae;
conf.cnt = cnt_arr;
conf.sub = sub_arr;
conf.acp = acp;
conf.tas = tas;

module.exports = conf;
