# Node MQTT mTLS client (uses `main/device_keys.h`)

This is a small Node.js MQTT client that reads the **same** certificates/keys from `main/device_keys.h` and connects using **mTLS**.

## Setup

```bash
cd node-mqtt-client
npm install
```

## Run

If **`Desktop/statsmqtt/.env`** exists, the client loads it automatically and fills empty **`MQTT_*`** fields (so a local `.env` with blank `MQTT_USERNAME=` still picks up `proof` from the server). You can override in **`node-mqtt-client/.env`**. Or set everything inline:

```bash
cp .env.example .env
# edit .env, then:
npm start
```

```bash
MQTT_URL="mqtts://your-broker.com:8883" npm start
```

### Optional environment variables

- `DEVICE_KEYS_H`: path relative to repo root (default: `main/device_keys.h`)
- `TOPIC_PREFIX`: default `statsnapp/<DEVICE_ID>`
- `REG_TOPIC`: default `<TOPIC_PREFIX>/registration`

