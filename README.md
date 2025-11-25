# Factorio → oneM2M Bridge (nCube-Thyme)

This workspace customizes [nCube-Thyme](https://github.com/IoTKETI/nCube-Thyme-Nodejs) so that a Factorio server can stream live factory telemetry into a oneM2M CSE (Mobius) and receive control commands. Two Node.js processes cooperate:

1. **`thyme.js` / `app.js` / `thyme_tas.js`** – run the standard nCube-Thyme AE that creates containers, subscribes to change notifications, and forwards MQTT messages between Mobius and a TAS broker.
2. **`tas_factorio_rcon.js`** – connects to Factorio through RCON, polls structured JSON snapshots, publishes them onto the TAS MQTT broker, and makes sure matching Mobius containers/subscriptions exist.

The combination yields an automated pipeline:

```
Factorio (device_scanner mod)
        │  RCON
        ▼
tas_factorio_rcon.js ── MQTT publish ──▶ TAS Broker ──▶ thyme_tas.js ── onem2m_client ─▶ Mobius CSE
                                               ▲                                           │
                                               └── MQTT notification (ex. led) ────────────┘
```

## Prerequisites

- Node.js 14+ (uses modern syntax plus `nanoid`, `axios`, `mqtt`, etc.).
- Access to a Mobius (oneM2M) CSE with HTTP + MQTT endpoints.
- MQTT broker reachable by both the TAS component and any consumers (defaults to localhost:1883).
- Factorio server with RCON enabled and the `device_scanner` mod (or equivalent) returning JSON from `remote.call("device_scanner", "get_snapshot_json")`.
- If HTTPS/MQTTS is needed, provide appropriate certificates referenced by `conf.js` / `server-*.pem`.

Install dependencies once after cloning:

```bash
npm install
```

## Configuration (`conf.js`)

Edit `conf.js` to match your Mobius deployment and TAS broker. Important blocks:

- `conf.cse` – CSE host/IP, HTTP port, MQTT port, CSE-ID.
- `conf.ae` – AE resource name/ID/appId and HTTP listen port (used for notifications when `http` protocol).
- `conf.cnt` – list of top-level containers to create under the AE. Defaults to `factory_car` and more paths are added automatically by the Factorio bridge.
- `conf.sub` – optional static subscriptions (left empty by default; `tas_factorio_rcon.js` creates dynamic subs under each entity container).
- `conf.tas` – MQTT broker connection used by `thyme_tas.js` (host/port, username/password, clientId seed).

AE-ID persistence lives in `aei.json`; once Mobius assigns an AE-ID it will be reused on restart.

## Environment Variables

`tas_factorio_rcon.js` and `thyme_tas.js` recognize these overrides (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `FACTORIO_RCON_HOST` | `114.71.219.156` | Factorio RCON host/IP |
| `FACTORIO_RCON_PORT` | `27015` | RCON TCP port |
| `FACTORIO_RCON_PASSWORD` | `ubicomp407` | RCON password |
| `FACTORIO_SNAPSHOT_COMMAND` | `/sc rcon.print(remote.call("device_scanner", "get_snapshot_json"))` | Command executed every poll |
| `FACTORIO_RCON_POLL_MS` | `1000` | Poll interval in milliseconds |
| `FACTORIO_TAS_CLIENT_ID` | `factorio_tas_<random>` | MQTT clientId for the RCON bridge |
| `FACTORY_CNT` | `factory_car` | Root container/topic name under the AE |
| `MOBIUS_ORIGIN` | `SM` | Origin used when Factorio bridge creates containers/subscriptions via HTTP |
| `MOBIUS_ADMIN_ORIGIN` | `SM` | Origin used by `thyme_tas` fallback HTTP cin creation |

Set them inline when starting a process, e.g.:

```bash
FACTORIO_RCON_HOST=10.0.0.5 FACTORIO_RCON_PASSWORD=secret node tas_factorio_rcon.js
```

## Running the stack

1. **Start the AE/TAS core** (creates AE, containers, cleans up subscriptions, opens MQTT connection, waits for TAS data):
   ```bash
   node thyme.js
   ```
2. **Start the Factorio RCON bridge** (polls Factorio and publishes MQTT payloads):
   ```bash
   node tas_factorio_rcon.js
   ```

The bridge can run on a different host as long as it can reach both the Factorio RCON port and the TAS MQTT broker defined in `conf.js`.

## Data model & automation

- Each Factorio snapshot target becomes nested Mobius containers using the pattern:
  `/{cseName}/{aeName}/{FACTORY_CNT}/{label}/{label}_{unit}`.
- Allowed base labels are enforced (`offshore_pumps`, `steam_engines`, `electric_furnaces`, `electric_mining_drills`, `boilers`, `assemblers`, plus recipe-specific `_assemblers`/`_electric_furnaces`).
- Before publishing MQTT data, `tas_factorio_rcon.js` ensures the required container hierarchy exists by POSTing `m2m:cnt` resources (HTTP ty=3). Duplicate creation attempts are tolerated (409/4105 treated as success).
- After a container appears, the script creates `sub1` subscriptions (ty=23) that point to `mqtt://{cse.host}:{cse.mqttport}/{ae.id}?ct=json` so the AE can receive control commands.
- `thyme_tas.js` listens on the TAS MQTT broker (wildcard `/{cse}/{ae}/{FACTORY_CNT}/#`). Any JSON payload received is submitted as `m2m:cin` via `onem2m_client`. If the regular origin lacks permission (HTTP 4103), it falls back to an admin origin using REST (`MOBIUS_ADMIN_ORIGIN`).

## Control path (Mobius → Factorio)

`app.js` registers for MQTT notifications per `conf.sub`. When Mobius writes to a container such as `/led`, `thyme_tas.send_to_tas()` republishes the content to the TAS broker (`/led/set`). Factorio-side automation can subscribe to those topics to actuate machines.

## Troubleshooting

- **AE creation fails** – confirm `conf.cse` matches the Mobius instance and that AE names are unique. Logs show oneM2M response codes.
- **MQTT not receiving data** – check TAS broker credentials, verify `thyme_tas.js` printed "Connection succeeded!" and that `tas_factorio_rcon.js` logs `published → <topic>`.
- **HTTP 4103/Access denied** – adjust `MOBIUS_ORIGIN`/`MOBIUS_ADMIN_ORIGIN` to accounts allowed to create containers/cins.
- **Factorio snapshot errors** – ensure the RCON command returns clean JSON; logs will include the first 200 chars of the raw payload when parsing fails.

## Extending

- Add more static containers/subscriptions by editing `conf.cnt`/`conf.sub`.
- Expand `allowedBaseLabels` in `tas_factorio_rcon.js` to mirror new device categories.
- Replace the TAS MQTT broker with a managed service by updating `conf.tas.connection` (supports username/password, TLS once certificates are provided).

## License & Credits

Original project &Cube-Thyme (Il Yeup Ahn, KETI) is BSD 3-Clause licensed. This repository keeps that license while tailoring the runtime for Factorio telemetry workflows.
