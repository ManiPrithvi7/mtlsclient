# Node MQTT mTLS client

Reference Node.js MQTT client using **TLS client certificate + key** (`mqtts://`), aligned with the same broker and topic contract as **statsmqtt** / firmware.

## Documentation (start here)

**[MQTT_CLIENT_IMPLEMENTATION_GUIDE.md](./MQTT_CLIENT_IMPLEMENTATION_GUIDE.md)** — single guide for operators, backend, and **firmware** (env vars, certs, EMQX / self-hosted / tunnels, topics, troubleshooting).

## Setup

```bash
cd node-mqtt-client
npm install
```

## Run

If **`Desktop/statsmqtt/.env`** exists (relative to this package), the client loads it and can fill empty **`MQTT_*`** from there; **`node-mqtt-client/.env`** overrides.

```bash
cp .env.example .env
# edit .env, then:
npm start
```

```bash
MQTT_URL="mqtts://your-broker.com:8883" npm start
```

### PEM bundle

Default: **`src/certs/client.crt`** + **`client.key`**; optional **`broker-ca.crt`**. See the implementation guide and **`src/certs/README.txt`**.

### Optional (advanced)

- **`USE_CRT_DIR=0`** + **`DEVICE_KEYS_H`**: load from ESP-style `device_keys.h` instead of `src/certs/`.
