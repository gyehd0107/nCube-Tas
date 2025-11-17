
global.socket_arr = {};

let tas_buffer = {};
exports.buffer = tas_buffer;



const conf = require('./conf');
let mqtt = require('mqtt');
const axios = require('axios');
const FACTORY_CNT = process.env.FACTORY_CNT || 'factory_car';
const factorioTopicBase = `/${conf.cse.name}/${conf.ae.name}/${FACTORY_CNT}`;
const factorioBaseSegments = factorioTopicBase.split('/').filter(Boolean);
const factorioWildcardTopic = `${factorioTopicBase}/#`;
const MOBIUS_BASE_URL = `${conf.usesecure === 'enable' ? 'https' : 'http'}://${conf.cse.host}:${conf.cse.port}`;
const MOBIUS_ADMIN_ORIGIN = process.env.MOBIUS_ADMIN_ORIGIN || 'SM';

let getDataTopic = {
    factorio: factorioWildcardTopic,
};

let setDataTopic = {
    led: '/led/set',
};


let createConnection = () => {
    if (conf.tas.client.connected) {
        console.log('Already connected --> destroyConnection')
        destroyConnection();
    }

    if (!conf.tas.client.connected) {
        conf.tas.client.loading = true;
        const {host, port, endpoint, ...options} = conf.tas.connection;
        const connectUrl = `mqtt://${host}:${port}${endpoint}`
        try {
            conf.tas.client = mqtt.connect(connectUrl, options);

            conf.tas.client.on('connect', () => {
                console.log(host, 'Connection succeeded!');

                conf.tas.client.connected = true;
                conf.tas.client.loading = false;

                for (let topicName in getDataTopic) {
                    if (getDataTopic.hasOwnProperty(topicName)) {
                        doSubscribe(getDataTopic[topicName]);
                    }
                }
            });

            conf.tas.client.on('error', (error) => {
                console.log('Connection failed', error);

                destroyConnection();
            });

            conf.tas.client.on('close', () => {
                console.log('Connection closed');

                destroyConnection();
            });

            conf.tas.client.on('message', (topic, message) => {
                let content = null;
                let parent = null;

    
                if (topic.startsWith(factorioTopicBase + '/')) {
                    const parts = topic.split('/').filter(Boolean);
                    const relative = parts.slice(factorioBaseSegments.length);
                    const [labelSegment, unitSegment] = relative;
                    if (relative.length !== 2 || !labelSegment || !unitSegment || !unitSegment.startsWith(labelSegment + '_')) {
                        console.log('[TAS] skip publish (invalid factorio topic structure)', topic);
                        return;
                    }
                    parent = topic;
                    try {
                        content = JSON.parse(message.toString());
                    } catch (err) {
                        console.log('[TAS] JSON parse error on factorio payload:', err.message);
                        return;
                    }
                }
                /* */

                if (content) {
                    onem2m_client.create_cin(parent, 1, content, this, (status, res_body, to, socket) => {
                        console.log('x-m2m-rsc : ' + status + ' <----');
                        if (String(status) === '4103') {
                            createCinFallback(parent, content);
                        }
                    });
                }
            });
        }
        catch (error) {
            console.log('mqtt.connect error', error);
            conf.tas.client.connected = false;
        }
    }
};

let doSubscribe = (topic) => {
    if (conf.tas.client.connected) {
        const qos = 0;
        conf.tas.client.subscribe(topic, {qos}, (error) => {
            if (error) {
                console.log('Subscribe to topics error', error)
                return;
            }

            console.log('Subscribe to topics (', topic, ')');
        });
    }
};

let doUnSubscribe = (topic) => {
    if (conf.tas.client.connected) {
        conf.tas.client.unsubscribe(topic, error => {
            if (error) {
                console.log('Unsubscribe error', error)
            }

            console.log('Unsubscribe to topics (', topic, ')');
        });
    }
};

let doPublish = (topic, payload) => {
    if (conf.tas.client.connected) {
        conf.tas.client.publish(topic, payload, 0, error => {
            if (error) {
                console.log('Publish error', error)
            }
        });
    }
};

let destroyConnection = () => {
    if (conf.tas.client.connected) {
        try {
            if (Object.hasOwnProperty.call(conf.tas.client, '__ob__')) {
                conf.tas.client.end();
            }
            conf.tas.client = {
                connected: false,
                loading: false
            }
            console.log('Successfully disconnected!');
        }
        catch (error) {
            console.log('Disconnect failed', error.toString())
        }
    }
};


exports.ready_for_tas = function ready_for_tas() {
    createConnection();


};

exports.send_to_tas = function send_to_tas(topicName, message) {
    if (setDataTopic.hasOwnProperty(topicName)) {
        conf.tas.client.publish(setDataTopic[topicName], message.toString())
    }
};

async function createCinFallback(parent, payload) {
    const url = `${MOBIUS_BASE_URL}${parent}`;
    const headers = {
        'X-M2M-Origin': MOBIUS_ADMIN_ORIGIN,
        'X-M2M-RI': `fallback-${Date.now()}`,
        'Content-Type': 'application/json;ty=4',
        'Accept': 'application/json',
    };
    const body = {
        'm2m:cin': {
            con: payload,
        },
    };

    try {
        await axios.post(url, body, { headers });
        console.log('[fallback] created cin via admin →', parent);
    } catch (err) {
        const status = err.response?.status;
        const dbg = err.response?.data?.['m2m:dbg'] || err.message;
        console.log('[fallback] failed to create cin', parent, status || '', dbg);
    }
}
