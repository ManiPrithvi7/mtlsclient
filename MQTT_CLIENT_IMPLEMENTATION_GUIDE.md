# MQTT client — implementation guide (Node + firmware)

**Single reference** for operators, backend, and **firmware** developers. Authoritative behavior is in **`src/client.js`** and **`src/device_keys_from_header.js`**.

---

## 1. Purpose

- The **Node** client (`npm start`) is the **reference implementation** for how to reach the broker with **mTLS** and use the **same topic contract** as your server.
- **Firmware** should mirror: broker URL, TLS trust, SNI/hostname verification rules, client cert/key, optional MQTT user/pass, keepalive, and topic prefixes.

---

## 2. Node vs firmware — what must match

| Area | Requirement |
|------|-------------|
| Transport | **`mqtts://`** (TLS). Plain `mqtt://` does not use client certs until the client auto-upgrades (with a warning). |
| Broker endpoint | Same host/port (or tunnel URL) as production. |
| Trust **server** TLS | Trust store must include the CA that signed the **broker’s TLS certificate** as presented on the wire (after proxies). This is **`MQTT_BROKER_CA` / `broker-ca.crt`**, not necessarily the same PEM as the device-issuing CA. |
| TLS name vs TCP host | If TCP goes to a proxy (e.g. Railway) but the cert is issued for another name (e.g. `nanomq-broker`), match Node: set **`MQTT_TLS_VERIFY_HOST`** to the **name on the cert** and **`MQTT_TLS_SERVERNAME`** if SNI must differ from the TCP hostname. |
| Client mTLS | Client cert + key; issuer must be trusted by the broker (`cafile` / EMQX client CA). |
| `clientId` | Certificate **CN**, unless **`DEVICE_ID_OVERRIDE`** is set (Node). Firmware should use the **same** logical id for topics. |
| MQTT user/pass | Optional. Required for many **EMQX Cloud** built-in DB setups; omit only if the listener uses pure cert auth. |
| Topics | Same root and `{deviceId}` segment as below. |

**Common mistake:** Using a **`broker-ca.crt`** that does not match the **issuer** of the server cert (e.g. Fly “broker CA” vs NanoMQ server signed by **`Proof-CA`**) causes **`UNABLE_TO_VERIFY_LEAF_SIGNATURE`** / `unable to verify the first certificate`. Fix: PEM for the **actual** issuing CA of the served certificate.

---

## 3. Environment loading (Node only)

1. Loads **`../../statsmqtt/.env`** (if present).
2. Then **`node-mqtt-client/.env`** (overrides).
3. For these keys, if still empty in the client `.env`, values are copied from statsmqtt when defined there:  
   `MQTT_URL`, `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_PEER_CN_AS_MQTT_USERNAME`.

Firmware: embed the equivalent settings in provisioning / secure storage (no merge).

---

## 4. Environment variables (reference)

| Variable | Default / notes |
|----------|------------------|
| **`MQTT_URL`** | Full URL; prefer **`mqtts://host:port`**. |
| **`MQTT_BROKER`** | Used with **`MQTT_PORT`** if **`MQTT_URL`** empty; builds **`mqtts://…`**. |
| **`MQTT_PORT`** | Default **8883** when omitted from URL. |
| **`MQTT_BROKER_CA`** | Path to PEM for **server** cert chain trust. Empty string → **system CAs only**. |
| **`MQTT_TLS_VERIFY_HOST`** | Hostname for **certificate verification** when it must differ from URL host (tunnels, proxies). |
| **`MQTT_TLS_SERVERNAME`** | Explicit **SNI**; also used for bore-style defaults in code. |
| **`CRT_DIR`** | PEM directory; default **`src/certs/`** (resolved from `src/`). |
| **`USE_CRT_DIR`** | **`1`** (default): load PEMs from **`CRT_DIR`**. **`0`**: use **`DEVICE_KEYS_H`**. |
| **`DEVICE_KEYS_H`** | Path under repo root to ESP-style header (default **`main/device_keys.h`**). |
| **`USE_CUSTOM_CA`** | **`1`**: merge system roots + device-side CA from **`ca.crt`**, **`root-ca.crt`**, or legacy **`root_certifacite.txt`** in **`CRT_DIR`**. **Not** a substitute for **`MQTT_BROKER_CA` / `broker-ca.crt`** for verifying the **server**. |
| **`MQTT_USERNAME`**, **`MQTT_PASSWORD`** | Optional MQTT layer auth. |
| **`MQTT_PEER_CN_AS_MQTT_USERNAME`** | **`1`**: CONNECT username = cert CN. Often conflicts with EMQX password auth if misused. |
| **`DEVICE_ID_OVERRIDE`** | Overrides **`clientId`** / topic device segment from cert CN. |
| **`MQTT_TOPIC_ROOT`** | Default **`proof.mqtt`**. |
| **`TOPIC_PREFIX`** | Default **`{MQTT_TOPIC_ROOT}/{deviceId}`**. |
| **`SUBSCRIBE_ALL`** | Default **`1`** → subscribe to **`{prefix}/#`** plus named topics. |
| **`MQTT_KEEPALIVE`** | Default **60** (seconds). |
| **`MQTT_IP_FAMILY`** | **`4`** / **`6`** / empty; bore defaults to IPv4 in client code. |
| **`REG_TOPIC`** | Default **`{TOPIC_PREFIX}/active`**. |
| **`STATUS_TOPIC`** | Default **`{TOPIC_PREFIX}/status`**. |
| **`USER_ID`**, **`DEVICE_TYPE`**, **`DEVICE_OS`**, **`APP_VERSION`**, **`IP_ADDRESS`**, **`USER_AGENT`** | Registration / metadata payloads. |

---

## 5. Certificate files (`CRT_DIR`, default `src/certs/`)

| File | Role |
|------|------|
| **`client.crt`** | Client certificate (mTLS). |
| **`client.key`** | Client private key — protect at rest. |
| **`broker-ca.crt`** | PEM to verify **broker TLS server** cert (merged with system roots in Node). |
| **`ca.crt`** / **`root-ca.crt`** | Device-issuing CA; used when **`USE_CUSTOM_CA=1`** only. |

**Legacy layout** (if **`client.crt` / `client.key`** absent): **`root_certifacite.txt`**, **`device certificate CA signed.txt`**, **`privatekey_protect.txt`** — see `src/device_keys_from_header.js`.

**Broker CA search order (Node):** explicit **`MQTT_BROKER_CA`** → **`CRT_DIR/broker-ca.crt`** → **`deploy/fly/broker-ca.crt`** (skipped for **`*.emqxcloud.com`** unless you set **`MQTT_BROKER_CA`**) → else system trust for public EMQX hostnames.

---

## 6. MQTT CONNECT behavior

**TLS:** Always presents **`cert`** + **`key`** on **`mqtts://`**.

| Configuration | CONNECT `username` | CONNECT `password` |
|---------------|--------------------|--------------------|
| Default | omitted | omitted |
| **`MQTT_USERNAME`** / **`MQTT_PASSWORD`** set | set | set if non-empty |
| **`MQTT_PEER_CN_AS_MQTT_USERNAME=1`** | cert CN (`deviceId`) | omitted unless password also set |

**After connect:** LWT on **`{topicPrefix}/lwt`**; subscribes under device topics; publishes registration + status (see `src/client.js`).

---

## 7. Broker flavors (one checklist)

### 7.1 EMQX Cloud (dedicated / public hostname)

- **`mqtts://<deployment>....emqxcloud.com:8883`**
- Server cert usually **public CA** → often **no** `broker-ca.crt` needed (system trust).
- **Built-in DB:** set **`MQTT_USERNAME`** + **`MQTT_PASSWORD`** (e.g. from statsmqtt `.env`). Keep **`MQTT_PEER_CN_AS_MQTT_USERNAME=0`** unless you intentionally map CN-only auth.

### 7.2 Self-hosted (NanoMQ / Mosquitto on Fly, Docker, etc.)

- **`mqtts://proof-mqtt.fly.dev:8883`** or your hostname.
- **`broker-ca.crt`** (or **`MQTT_BROKER_CA`**) must match the **server cert issuer** you actually serve.

### 7.3 Tunnels (bore, Railway TCP proxy, etc.)

- **`MQTT_URL`** must use the **current** tunnel host:port (bore port changes per session).
- If **cert hostname ≠ TCP host**: set **`MQTT_TLS_VERIFY_HOST`** to the name on the certificate; set **`MQTT_TLS_SERVERNAME`** if the server expects a specific SNI.
- For **`bore.pub`**, the client defaults **`MQTT_IP_FAMILY=4`** and bore-related TLS hostname behavior in code — override with env if your deployment differs.

---

## 8. Topic contract (server alignment)

- **Root:** **`proof.mqtt`** (override with **`MQTT_TOPIC_ROOT`**).
- **Per device:** **`proof.mqtt/{deviceId}/…`** where **`deviceId`** = cert CN or **`DEVICE_ID_OVERRIDE`**.
- **LWT:** **`{prefix}/lwt`**
- **Registration publish (Node default):** **`{prefix}/active`** (override **`REG_TOPIC`**).
- **Status publish:** **`{prefix}/status`** (override **`STATUS_TOPIC`**).
- **Subscriptions (defaults):** wildcard **`{prefix}/#`** when **`SUBSCRIBE_ALL=1`**, plus **`registration_ack`**, **`test-gmb`**, **`instagram`**, **`gmb`**, **`pos`**, **`promotion`** under **`{prefix}/…`**.

Firmware should subscribe/publish to the **same** paths your backend expects.

---

## 9. Operator checklist

- [ ] **`mqtts://`** URL or **`MQTT_BROKER`** + **`MQTT_PORT`** correct.
- [ ] Tunnel running and port current (if applicable).
- [ ] **`broker-ca.crt`** or **`MQTT_BROKER_CA`** = CA that signs the **server** cert you receive (not a random other project CA).
- [ ] **`client.crt` / `client.key`** present; client cert issuer trusted by broker.
- [ ] **`clientId`** / CN aligned with provisioning and topic layout.
- [ ] EMQX: user/pass if required; or pure cert auth configured on listener.
- [ ] Proxy setups: **`MQTT_TLS_VERIFY_HOST`** / **`MQTT_TLS_SERVERNAME`** set correctly.

---

## 10. Troubleshooting

| Symptom | Check |
|---------|--------|
| **`ECONNREFUSED`** | Tunnel / broker up; port matches **`MQTT_URL`**. |
| **`EAI_AGAIN`** | DNS / network / VPN. |
| **`AggregateError` (multi-connect)** | IPv4 vs IPv6; **`MQTT_IP_FAMILY`**. |
| **`unable to verify` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`** | Wrong **server** CA PEM; incomplete chain from server — use correct **`Proof-CA`** (or whatever issued the served cert). |
| Cert hostname / SAN mismatch | **`MQTT_TLS_VERIFY_HOST`**, SNI (**`MQTT_TLS_SERVERNAME`**). |
| **`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`** | Broker does not trust **client** cert issuer — re-issue device cert or fix broker `cafile`. |
| **`Bad username or password` / Not authorized** | EMQX auth chain vs **`MQTT_USERNAME`/`PASSWORD`** / cert-only mode. |

### OpenSSL — inspect certificates (correct patterns)

**Client cert from disk (always reliable):**

```bash
cd node-mqtt-client
openssl x509 -in src/certs/client.crt -noout -subject -issuer
# Issuer must be a CA the broker trusts for client verification.
```

**Server cert as seen on the network** (suppress OpenSSL noise on stderr so PEM is the only stdin to `x509`):

```bash
openssl s_client -connect HOST:PORT -servername SERVERNAME </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
```

If you need the **full chain** the server sends:

```bash
openssl s_client -connect HOST:PORT -servername SERVERNAME -showcerts </dev/null 2>/dev/null
```

Do **not** rely on piping raw `s_client` stdout (with stderr mixed in) straight to **`openssl x509`** — you may get `Could not read certificate from <stdin>`.

---

## 11. Repo layout (implementation)

| Path | Role |
|------|------|
| `src/client.js` | Entry: env, URL, TLS, MQTT, subs/pubs |
| `src/device_keys_from_header.js` | PEM loader (`client.crt` / `client.key` + legacy) or header |
| `src/tlsBrokerCa.js` | Merge custom broker CA with system roots |
| `src/certs/` | Default PEM bundle; see `src/certs/README.txt` |
| `.env` / `.env.example` | Local overrides |

---

## 12. Run

```bash
cd node-mqtt-client
npm install
cp .env.example .env   # optional; edit values
npm start
```

---

*Maintainers: edit this file only for cross-team contract; keep `src/client.js` in sync when adding env vars or behavior.*
