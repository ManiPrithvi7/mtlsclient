# MQTT client — connection checklist

Use this with `node src/client.js` / `npm start` and the current `src/client.js` behavior.

## 1. Broker address and tunnel

- [ ] **`MQTT_URL`** uses **`mqtts://`** (TLS). **`mqtt://`** is plain TCP — **client certs in `src/crts/` are not used**; the client auto-upgrades `mqtt://` → `mqtts://` with a warning.
- [ ] **`MQTT_URL`** matches how you reach the broker:
  - **EMQX Dedicated** (example): `mqtts://<deployment>.ala.dedicated.aws.emqxcloud.com:8883`.
  - **Fly Mosquitto:** `mqtts://proof-mqtt.fly.dev:8883`.
  - **Bore:** `mqtts://bore.pub:<port>` — copy the **current** port from bore each session.
- [ ] Tunnel is **running** if you use bore (otherwise `ECONNREFUSED`).
- [ ] If connect fails with **hostname / SAN** errors against a tunnel, the client uses a **custom TLS stream** for `bore.pub` with **`MQTT_TLS_VERIFY_HOST`** defaulting to **`proof-mqtt.fly.dev`** (override with env if needed).

## 2. Trust the server (client → broker TLS)

- [ ] **`deploy/fly/broker-ca.crt`** for **self-hosted / Fly Mosquitto** (default path is skipped automatically for **`*.emqxcloud.com`** — those use the system CA store unless **`MQTT_BROKER_CA`** is set).
- [ ] Set **`MQTT_BROKER_CA`** to the PEM that signs the **server** cert if it is not publicly trusted.
- [ ] **`MQTT_BROKER_CA=`** (empty) forces system trust only.
- [ ] Legacy / extra roots: **`USE_CUSTOM_CA=1`** merges system roots + `src/crts/root_certifacite.txt` (not a substitute for `broker-ca.crt` when the server is signed by your deploy CA).

## 3. Device identity (mTLS — broker must trust your client cert)

- [ ] **`src/crts/`** contains the expected files (see `src/device_keys_from_header.js`):
  - `root_certifacite.txt` — device-side root material (optional for server trust path),
  - `device certificate CA signed.txt` — **client certificate PEM**,
  - `privatekey_protect.txt` — **client private key PEM**.
- [ ] **Issuer of the client cert** is in Mosquitto’s **`cafile`** (e.g. `/data/ca/root-ca.crt` in Docker). If not → **`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`**. Re-issue the device cert from the **same** CA the broker trusts, or add your device CA to the broker.
- [ ] **`clientId`** comes from cert **CN** (or **`DEVICE_ID_OVERRIDE`**).

## 4. MQTT application layer (default: none)

- [ ] **Default:** **no** MQTT username or password — identity is **only** TLS client certificate + key from **`src/crts/`** (X.509 / mTLS). Configure **EMQX** for certificate-based authentication, not password auth, on this listener.
- [ ] **Optional:** **`MQTT_PEER_CN_AS_MQTT_USERNAME=1`** — also send CONNECT **username = cert CN** (still no password) if your EMQX rule set expects it.
- [ ] **Legacy password broker:** **`MQTT_USERNAME`** / **`MQTT_PASSWORD`**.

## 5. TCP / DNS (bore / strict networks)

- [ ] For **`bore.pub`**, **`MQTT_IP_FAMILY`** defaults to **`4`** (IPv4-first). Use **`MQTT_IP_FAMILY=`** (empty) or **`6`** if you need different behavior.

## 6. Topics and contract (unchanged)

- [ ] Topic root default: **`proof.mqtt`** (`MQTT_TOPIC_ROOT` to override).
- [ ] Subscribes / publishes / LWT match your server contract (`proof.mqtt/{deviceId}/…`).

## 7. Quick verification commands

```bash
# From node-mqtt-client/
openssl x509 -in "src/crts/device certificate CA signed.txt" -noout -subject -issuer
# Issuer CN must match a CA trusted by Mosquitto's cafile.

# Run (example bore)
MQTT_URL=mqtts://bore.pub:YOUR_PORT npm start
```

## 8. Symptom → check

| Symptom | Check |
|--------|--------|
| `ECONNREFUSED` | Bore running; **`MQTT_URL`** port = current bore port |
| `AggregateError` | Sub-errors in log; same as network + try **`tcpFamily`** / tunnel |
| Cert hostname / SAN mismatch | **`MQTT_TLS_VERIFY_HOST`**, bore + `proof-mqtt.fly.dev` |
| `unable to verify …` (server) | **`broker-ca.crt`** / **`MQTT_BROKER_CA`** |
| `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA` | **Client cert issuer** vs broker **`cafile`** — re-issue or fix broker CA list |
| `Bad username or password` / `Not authorized` | EMQX: enable **cert** auth, drop password chain; or opt-in **`MQTT_PEER_CN_AS_MQTT_USERNAME=1`** / **`MQTT_USERNAME`** only if your template requires it |
