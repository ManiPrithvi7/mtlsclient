# Node MQTT client — EMQX setup (summary)

This file is the **EMQX-only** excerpt of the client behavior. For Mosquitto/bore/Fly, see `IMPLEMENTATION_SUMMARY.md` and `MQTT_CONNECTION_CHECKLIST.md`.

---

## Broker address (EMQX Cloud)

- Set **`MQTT_URL=mqtts://q0901f1e.ala.dedicated.aws.emqxcloud.com:8883`**  
  **or** **`MQTT_BROKER`** + **`MQTT_PORT=8883`** (client builds `mqtts://…`).
- **`mqtt://`** is auto-upgraded to **`mqtts://`** so client certificates are used.

---

## TLS / certificates

- **Client identity (mTLS):** **`cert`** + **`key`** from **`CRT_DIR`** (default **`src/certs/`**: `client.crt`, `client.key`; see `device_keys_from_header.js` for legacy filenames).
- **Trust the EMQX server cert:** If **`CRT_DIR/broker-ca.crt`** exists, it is merged with the system CA store. **`MQTT_BROKER_CA=`** (empty) forces system trust only. **`MQTT_BROKER_CA=/path`** points at a specific PEM.
- For **`*.emqxcloud.com`**, if there is no bundled broker CA file, the client uses **system trust** (typical for public-CA server certs).

---

## MQTT username and password (EMQX Cloud)

**mTLS is always used on `mqtts://` with PEM keys from `CRT_DIR` (default `src/certs/`).** MQTT-layer credentials are **optional** and depend on how **EMQX** is configured:

| Configuration | CONNECT `username` | CONNECT `password` |
|----------------|-------------------|-------------------|
| Default (`MQTT_PEER_CN_AS_MQTT_USERNAME` unset or `0`, empty `MQTT_USERNAME`) | omitted | omitted |
| **`MQTT_USERNAME` / `MQTT_PASSWORD`** set (`.env` or merged **`statsmqtt/.env`**) | set | set if non-empty |
| **`MQTT_PEER_CN_AS_MQTT_USERNAME=1`** | cert **CN** (`deviceId`) | omitted unless **`MQTT_PASSWORD`** is set |

- **Built-in DB + mTLS (common on EMQX Cloud):** set **`MQTT_USERNAME`** and **`MQTT_PASSWORD`** to match the EMQX console (often same as **statsmqtt** `.env`). Keep **`MQTT_PEER_CN_AS_MQTT_USERNAME=0`** unless your deployment maps cert CN without a password.
- **Pure X.509 at MQTT layer:** leave user/pass empty; configure EMQX for **certificate authentication** and remove password-only authenticators on that listener.

---

## Environment loading

- Loads **`../../statsmqtt/.env`** first, then **`node-mqtt-client/.env`** (client overrides).
- Empty **`MQTT_USERNAME` / `MQTT_PASSWORD`** in the client repo can be filled from **statsmqtt** if defined there.

---

## After CONNECT

- **`clientId`** = certificate **CN** (or **`DEVICE_ID_OVERRIDE`**).
- **LWT:** `{topicRoot}/{deviceId}/lwt`.
- **Topics:** under **`proof.mqtt/{deviceId}/…`** (registration, status, screen channels — see main summary / checklist).

---

## EMQX-specific troubleshooting

| Symptom | What to check |
|--------|----------------|
| **`Bad username or password` / `Not authorized` (connack 4/5)** | User/pass vs console; auth chain order; or pure cert auth + no password DB on this listener. |
| **`EAI_AGAIN` / DNS errors** | Network, VPN, DNS; **`MQTT_BROKER`** / **`MQTT_URL`** hostname correct and current. |
| **`unable to verify …` (server cert)** | **`src/certs/broker-ca.crt`** (or **`CRT_DIR`**) or **`MQTT_BROKER_CA`**. |
| **`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA` (alert 48)** | Broker does not trust **client** cert issuer — fix device cert CA in EMQX / provisioning (Mosquitto-style deployments; same TLS concept on EMQX if client cert verification is enabled). |

---

## Files to touch for EMQX day-to-day

| File | Purpose |
|------|---------|
| **`node-mqtt-client/.env`** | `MQTT_BROKER` / `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, optional flags |
| **`src/certs/`** | **`client.crt`**, **`client.key`**, optional **`broker-ca.crt`** |
| **`src/client.js`** | Implementation (hints and connection logic) |
