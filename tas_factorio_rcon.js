

const mqtt = require('mqtt');
const { nanoid } = require('nanoid');
const { Rcon } = require('rcon-client');
const axios = require('axios');
const conf = require('./conf');

const FACTORIO_RCON = {
    host: process.env.FACTORIO_RCON_HOST || '114.71.219.156',
    port: Number(process.env.FACTORIO_RCON_PORT) || 27015,
    password: process.env.FACTORIO_RCON_PASSWORD || 'ubicomp407',
    command: process.env.FACTORIO_SNAPSHOT_COMMAND || '/sc rcon.print(remote.call("device_scanner", "get_snapshot_json"))',
};

const SNAPSHOT_COMMAND = FACTORIO_RCON.command;
const POLL_INTERVAL_MS = Number(process.env.FACTORIO_RCON_POLL_MS) || 1000; // 기본 5초

let rconClient = null;
let pollTimer = null;

const tas = JSON.parse(JSON.stringify(conf.tas));
tas.connection.clientId = process.env.FACTORIO_TAS_CLIENT_ID || ('factorio_tas_' + nanoid(15));
tas.client = {
    connected: false,
};

const FACTORY_CNT = process.env.FACTORY_CNT || 'factory_car';
const mobiusAePath = `/${conf.cse.name}/${conf.ae.name}`;
const sendDataTopicBase = `${mobiusAePath}/${FACTORY_CNT}`;
const mobiusFactoryPath = `${mobiusAePath}/${FACTORY_CNT}`;
const MOBIUS_BASE_URL = `${conf.usesecure === 'enable' ? 'https' : 'http'}://${conf.cse.host}:${conf.cse.port}`;
const MOBIUS_ORIGIN = process.env.MOBIUS_ORIGIN || 'SM';
const ensuredContainers = new Set();
const containerPromises = new Map();
const ensuredSubs = new Set();
const allowedBaseLabels = new Set([
    'offshore_pumps',
    'steam_engines',
    'electric_furnaces',
    'electric_mining_drills',
    'boilers',
    'assemblers',
]);
const UNIT_CNT_REGEX = /^(.*)_([0-9]+)$/;



function createMqttConnection() {
    if (tas.client.connected) {
        console.log('[MQTT] Already connected → destroyConnection');
        destroyMqttConnection();
    }

    if (!tas.client.connected) {
        tas.client.loading = true;
        const { host, port, endpoint = '', ...options } = tas.connection;
        const connectUrl = `mqtt://${host}:${port}${endpoint}`;

        try {
            tas.client = mqtt.connect(connectUrl, options);

            tas.client.on('connect', () => {
                console.log('[MQTT]', host, 'Connection succeeded!');
                tas.client.connected = true;
                tas.client.loading = false;
            });

            tas.client.on('error', (error) => {
                console.log('[MQTT] Connection failed:', error.message);
                destroyMqttConnection();
            });

            tas.client.on('close', () => {
                console.log('[MQTT] Connection closed');
                destroyMqttConnection();
            });
        } catch (error) {
            console.log('[MQTT] mqtt.connect error', error);
            tas.client.connected = false;
        }
    }
}

function doPublish(topic, payload) {
    if (tas.client.connected) {
        tas.client.publish(topic, payload, { qos: 0 }, (error) => {
            if (error) {
                console.log('[MQTT] Publish error', error);
            } else {
                console.log('[MQTT] published →', topic);
            }
        });
    }
}

function destroyMqttConnection() {
    if (tas.client.connected) {
        try {
            if (Object.hasOwnProperty.call(tas.client, '__ob__')) {
                tas.client.end();
            }
            tas.client = {
                connected: false,
                loading: false,
            };
            console.log('[MQTT] Successfully disconnected!');
        } catch (error) {
            console.log('[MQTT] Disconnect failed', error.toString());
        }
    }
}



async function createRconConnection() {
    try {
        rconClient = await Rcon.connect({
            host: FACTORIO_RCON.host,
            port: FACTORIO_RCON.port,
            password: FACTORIO_RCON.password,
        });

        console.log('[RCON] Connected!');
        startPolling();
        rconClient.on('end', () => {
            console.log('[RCON] Disconnected');
            rconClient = null;
        });
        rconClient.on('error', (err) => {
            console.log('[RCON] Error:', err.message);
        });
    } catch (err) {
        console.log('[RCON] Connect failed:', err.message);
        // 실패하면 5초 뒤 재시도
        setTimeout(createRconConnection, 5000);
    }
}

function startPolling() {
    if (pollTimer) {
        return;
    }
    pollTimer = setInterval(pollSnapshot, POLL_INTERVAL_MS);
    console.log(`[RCON] polling started (interval: ${POLL_INTERVAL_MS} ms)`);
}

async function pollSnapshot() {
    if (!rconClient) {
        console.log('[RCON] skip poll (no client)');
        return;
    }

    try {
        const result = await rconClient.send(SNAPSHOT_COMMAND);
        await handleSnapshot(result);
    } catch (err) {
        console.log('[RCON] snapshot error:', err.message);
    }
}


async function handleSnapshot(raw) {
    let data;
    try {
        // Factorio에서 오는 문자열이 JSON만 오도록 device_scanner에서 맞춰줬다는 전제
        data = JSON.parse(raw);
    } catch (e) {
        console.log('[TAS] JSON parse error:', e.message);
        // 디버깅용으로 앞부분만 보기
        console.log('[TAS] raw snapshot head:', String(raw).slice(0, 200));
        return;
    }

    if (!data || !Array.isArray(data.targets)) {
        console.log('[TAS] snapshot format invalid (no targets)');
        return;
    }

    const tick = data.tick;

    for (const target of data.targets) {
        const baseLabel = target.label || 'unknown';
        if (!Array.isArray(target.entities)) {
            continue;
        }

        for (const entity of target.entities) {
            const unit = entity.unit_number || entity.unit || 'unknown';
            const { label, recipe } = deriveLabelAndRecipe(baseLabel, entity);

            const topic = `${sendDataTopicBase}/${label}/${label}_${unit}`;

            const payloadObj = {
                tick,
                label,
                recipe: recipe || null,
                entity_name: entity.name,
                ...entity,
            };

            try {
                if (isLabelAllowed(label)) {
                    await ensureContainerHierarchy(label, `${label}_${unit}`);
                    await ensureSubscription(`${mobiusFactoryPath}/${label}/${label}_${unit}`);
                    const payload = JSON.stringify(payloadObj);
                    doPublish(topic, payload);
                }
            } catch (err) {
                console.log('[Mobius] ensure container failed:', err.message);
            }
        }
    }
}

function deriveLabelAndRecipe(label, entity) {
    if (!label) {
        return { label: 'unknown', recipe: null };
    }

    if (label.includes('assemblers')) {
        const recipeValue = entity.recipe || entity.recipe_name || entity.current_recipe || entity.current_recipe_name || null;
        const normalized = normalizeRecipe(recipeValue);
        if (normalized) {
            return { label: `${normalized}_assemblers`, recipe: recipeValue };
        }
        return { label, recipe: recipeValue };
    }

    if (label.includes('electric_furnaces')) {
        const recipeValue = entity.recipe || entity.recipe_name || entity.current_recipe || entity.current_recipe_name || null;
        const normalized = normalizeRecipe(recipeValue);
        if (normalized) {
            return { label: `${normalized}_electric_furnaces`, recipe: recipeValue };
        }
        return { label, recipe: recipeValue };
    }

    return { label, recipe: null };
}

function normalizeRecipe(recipe) {
    if (!recipe || typeof recipe !== 'string') {
        return null;
    }

    const normalized = recipe.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    return normalized.length > 0 ? normalized : null;
}

function isLabelAllowed(label) {
    if (!label) {
        return false;
    }

    if (allowedBaseLabels.has(label)) {
        return true;
    }

    if (label.endsWith('_assemblers')) {
        return true;
    }

    if (label.endsWith('_electric_furnaces')) {
        return true;
    }

    return false;
}

function extractLabelFromUnitCnt(rn) {
    if (!rn) {
        return null;
    }
    const match = rn.match(UNIT_CNT_REGEX);
    if (!match) {
        return null;
    }
    const candidate = match[1];
    if (!candidate) {
        return null;
    }
    return candidate;
}

async function ensureContainerHierarchy(label, unitCntName) {
    await ensureContainer(mobiusAePath, FACTORY_CNT);
    await ensureContainer(mobiusFactoryPath, label);
    await ensureContainer(`${mobiusFactoryPath}/${label}`, unitCntName);
}

async function ensureContainer(parentPath, rn) {
    const normalizedParent = parentPath.replace(/\/+$/, '');
    if (normalizedParent === mobiusFactoryPath) {
        const derivedLabel = extractLabelFromUnitCnt(rn);
        if (derivedLabel && isLabelAllowed(derivedLabel)) {
            const correctedParent = `${mobiusFactoryPath}/${derivedLabel}`;
            await ensureContainer(mobiusFactoryPath, derivedLabel);
            return ensureContainer(correctedParent, rn);
        }
    }

    const resourcePath = `${parentPath}/${rn}`;
    if (ensuredContainers.has(resourcePath)) {
        return;
    }
    if (containerPromises.has(resourcePath)) {
        return containerPromises.get(resourcePath);
    }

    const promise = createContainer(parentPath, rn)
        .then(() => {
            ensuredContainers.add(resourcePath);
        })
        .catch((err) => {
            throw err;
        })
        .finally(() => {
            containerPromises.delete(resourcePath);
        });

    containerPromises.set(resourcePath, promise);
    return promise;
}

async function createContainer(parentPath, rn) {
    const url = `${MOBIUS_BASE_URL}${parentPath}`;
    const headers = {
        'X-M2M-Origin': MOBIUS_ORIGIN,
        'X-M2M-RI': `cnt-${rn}-${Date.now()}`,
        'Content-Type': 'application/json;ty=3',
    };
    const body = {
        'm2m:cnt': {
            rn,
        },
    };

    try {
        await axios.post(url, body, { headers });
        console.log('[Mobius] created container', `${parentPath}/${rn}`);
    } catch (err) {
        const status = err.response?.status;
        if (status === 409 || status === 4105) {
            ensuredContainers.add(`${parentPath}/${rn}`);
            console.log('[Mobius] container already exists', `${parentPath}/${rn}`);
            return;
        }
        const dbg = err.response?.data?.['m2m:dbg'] || err.message;
        throw new Error(`cnt ${parentPath}/${rn} -> ${status || ''} ${dbg}`);
    }
}

async function ensureSubscription(resourcePath) {
    const subKey = `${resourcePath}/sub1`;
    if (ensuredSubs.has(subKey)) {
        return;
    }

    try {
        await axios.post(`${MOBIUS_BASE_URL}${resourcePath}`, {
            'm2m:sub': {
                rn: 'sub1',
                enc: { net: [3] },
                nu: [`mqtt://${conf.cse.host}:${conf.cse.mqttport}/${conf.ae.id}?ct=json`],
                nct: 2,
            },
        }, {
            headers: {
                'X-M2M-Origin': MOBIUS_ORIGIN,
                'X-M2M-RI': `sub-${Date.now()}`,
                'Content-Type': 'application/json;ty=23',
            },
        });
        ensuredSubs.add(subKey);
        console.log('[Mobius] created sub1 for', resourcePath);
    } catch (err) {
        const status = err.response?.status;
        if (status === 409 || status === 4105) {
            ensuredSubs.add(subKey);
            console.log('[Mobius] sub1 already exists for', resourcePath);
            return;
        }
        const dbg = err.response?.data?.['m2m:dbg'] || err.message;
        console.log('[Mobius] failed to create sub1', resourcePath, status || '', dbg);
    }
}

createMqttConnection();
createRconConnection();
