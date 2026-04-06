# Node MQTT mTLS client

Reference Node.js MQTT client using TLS client certificate + key (mqtts://), aligned with the same broker and topic contract as statsmqtt / firmware.

## Documentation (start here)

[MQTT_CLIENT_IMPLEMENTATION_GUIDE.md](./MQTT_CLIENT_IMPLEMENTATION_GUIDE.md) — single guide for operators, backend, and firmware (env vars, certs, EMQX / self-hosted / tunnels, topics, troubleshooting).

## Setup

```bash
cd node-mqtt-client
## npm install
Run
If Desktop/statsmqtt/.env exists (relative to this package), the client loads it and can fill empty MQTT_* from there; node-mqtt-client/.env overrides.

bash
cp .env.example .env
# edit .env, then:
npm start
Or override directly:

bash
MQTT_URL="mqtts://your-broker.com:8883" npm start
PEM bundle
Default: src/certs/client.crt + client.key; optional broker-ca.crt. See the implementation guide and src/certs/README.txt.

Optional (advanced)
USE_CRT_DIR=0 + DEVICE_KEYS_H: load from ESP-style device_keys.h instead of src/certs/.

How it works
Every device gets a unique X.509 certificate signed by our Root CA. That cert is your device's identity — no username or password needed. The broker verifies it on every connection (mTLS).

First time setup
Clone the mtlsclient repo (or use this package).

Go to the device provisioning dashboard and get your provisioning token:
👉 https://statsnapp.vercel.app/68d3753f9f99d6b73ae2d991/devices/provision

Copy .env.example to .env and fill in:

ini
MQTT_URL=mqtts://switchback.proxy.rlwy.net:12359
PROVISIONING_SERVER_URL=<ask backend team>
PROVISIONING_TOKEN=<token from dashboard>
DEVICE_ID=<your device id e.g. ESP32-132ABC>
USE_CUSTOM_CA=1
Run npm start

On first run it automatically generates a key pair, submits a CSR to the server, writes the signed certs to src/crts/, and connects to the broker — all in one go.

Already provisioned?
Just run npm start — it reuses existing certs in src/crts/ and connects directly. No token needed.

Need to re-provision? (fresh start)
Delete the entire src/crts/ directory

Go to the dashboard and get a new provisioning token

Update PROVISIONING_TOKEN in .env

Run npm start

Something broken?
Error	Fix
Device ID not found in CSR	DEVICE_ID in .env doesn't match the dashboard — fix and retry
unable to get local issuer certificate	Make sure USE_CUSTOM_CA=1 is in .env
ERR_TLS_CERT_ALTNAME_INVALID	Add MQTT_TLS_VERIFY_HOST=nanomq-broker to .env
Token expired / already used	Get a fresh token from the dashboard
Questions? Share the exact error line from the terminal with the backend team.

text

The original content is kept at the top, followed by the detailed onboarding under a clear `---` separator. The structure is consistent and easy to scan.
