# Node MQTT client — implementation summary

## Does it use MQTT username and password?

**Only if you configure them.** The client always sends **TLS client certificate + private key** (`src/crts/`) for **mTLS**. The MQTT **CONNECT** packet includes:

| Configuration | CONNECT `username` | CONNECT `password` |
|----------------|------------------|---------------------|
| Default (`MQTT_PEER_CN_AS_MQTT_USERNAME` unset or `0`, empty `MQTT_USERNAME`) | omitted | omitted |
| `MQTT_USERNAME` / `MQTT_PASSWORD` set (e.g. in `.env` or merged from `statsmqtt/.env`) | set | set if non-empty |
| `MQTT_PEER_CN_AS_MQTT_USERNAME=1` | cert **CN** (`deviceId`, e.g. `ADMIN-1`) | omitted unless you also set `MQTT_PASSWORD` |

So: **mTLS is always on** when using `mqtts://` and `src/crts/` keys. **Username/password are optional MQTT-layer credentials** for brokers (especially **EMQX Cloud** built-in users) that require them **in addition to** the client cert.

---

## How the client connects to the broker (end-to-end)

1. **Env** — Loads `../../statsmqtt/.env` first, then `node-mqtt-client/.env` (overrides). Empty client keys can inherit `MQTT_USERNAME`, `MQTT_PASSWORD`, etc. from statsmqtt.
2. **Broker address** — `MQTT_URL=mqtts://host:port` **or** `MQTT_BROKER` + `MQTT_PORT` (builds `mqtts://…`). `mqtt://` is upgraded to `mqtts://` so certs are used.
3. **TLS** — `mqtt.connect` / custom `MqttClient` + `tls.connect` with:
   - **`cert` / `key`** from `src/crts/` (or `device_keys.h` path if `USE_CRT_DIR=0`).
   - **`ca`** — `src/crts/broker-ca.crt` if present (merged with system roots via `tlsBrokerCa.js`), else `MQTT_BROKER_CA`, else `deploy/fly/broker-ca.crt` for non-EMQX hosts, else system trust for `*.emqxcloud.com` when no file.
4. **Bore tunnel** — For `bore.pub`, custom TLS stream sets **SNI / cert verify hostname** to `proof-mqtt.fly.dev`; **IPv4** default (`MQTT_IP_FAMILY`) to reduce `AggregateError`.
5. **MQTT CONNECT** — `clientId` = device id from cert CN (or `DEVICE_ID_OVERRIDE`), optional `username`/`password`, **LWT** on `{topicRoot}/{deviceId}/lwt`.
6. **After connect** — Subscribes to device topics, publishes registration + status.

---

## Repository layout (relevant pieces)

| Piece | Role |
|--------|------|
| `src/client.js` | Entry: env, URL, TLS, MQTT connect, subs, pubs |
| `src/device_keys_from_header.js` | Load PEMs from `src/crts/` filenames or ESP `device_keys.h` |
| `src/tlsBrokerCa.js` | Merge custom broker CA PEM with `tls.rootCertificates` |
| `src/crts/` | Device cert, key, optional `broker-ca.crt`, optional root text files |
| `.env` / `.env.example` | Local broker URL and optional MQTT user/pass |
| `MQTT_CONNECTION_CHECKLIST.md` | Operator checklist |

---

## Topic contract (unchanged)

- Root: `proof.mqtt` (`MQTT_TOPIC_PREFIX` / `TOPIC_PREFIX` can override).
- Per device: `proof.mqtt/{deviceId}/…` — registration, status, LWT, screen topics (`registration_ack`, `test-gmb`, `instagram`, `gmb`, `pos`, `promotion`), optional `#` wildcard.

---

## Practical guidance by broker

- **EMQX Cloud (built-in DB user + mTLS):** set **`MQTT_USERNAME`** and **`MQTT_PASSWORD`** (same as console / statsmqtt). Keep **`MQTT_PEER_CN_AS_MQTT_USERNAME=0`** (default) unless your deployment explicitly maps cert CN without password.
- **Pure X.509 at MQTT layer:** no user/pass; **`MQTT_PEER_CN_AS_MQTT_USERNAME=0`**; EMQX must use certificate authentication and not require password auth on that listener.
- **Self-hosted Mosquitto (Fly/bore):** `broker-ca` + device CA alignment; see checklist and `UNKNOWN_CA` hints in `client.js`.

---

## Your recent log (`EAI_AGAIN`)

That is **DNS failure** (`getaddrinfo EAI_AGAIN`), not auth. Check network, VPN, DNS, and that **`MQTT_BROKER` / `MQTT_URL`** matches the current EMQX hostname.
