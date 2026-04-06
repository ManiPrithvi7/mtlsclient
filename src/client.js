const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const mqtt = require('mqtt');
const dotenv = require('dotenv');

const {
  loadDeviceKeysFromHeader,
  loadDeviceKeysFromCrtFolder,
  readFirstCertificatePemFromFile,
} = require('./device_keys_from_header');
const { provisionDevice } = require('./provisioning');
const { caForBrokerTls } = require('./tlsBrokerCa');

function env(name, fallback) {
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

function nonEmpty(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

/** Expand AggregateError / nested causes so logs show ECONNREFUSED, ETIMEDOUT, etc. */
function formatConnectError(err) {
  if (!err) return String(err);
  const lines = [];
  const top = err.message && String(err.message).trim() ? err.message : String(err);
  lines.push(top);
  if (err.code) lines.push(`code=${err.code}`);
  if (err.syscall) lines.push(`syscall=${err.syscall}`);
  if (err.address) lines.push(`address=${err.address}`);
  if (err.port) lines.push(`port=${err.port}`);
  if (err.cause) lines.push(`cause: ${formatConnectError(err.cause)}`);
  if (typeof AggregateError !== 'undefined' && err instanceof AggregateError && Array.isArray(err.errors)) {
    lines.push('sub-errors:');
    err.errors.forEach((e, i) => {
      lines.push(`  [${i}] ${e && e.message ? e.message : String(e)}${e && e.code ? ` (code=${e.code})` : ''}`);
    });
  }
  return lines.join('\n');
}

/** Hostname from mqtt(s) URL for TLS / logging. */
function mqttUrlHostname(mqttUrl) {
  try {
    const normalized = String(mqttUrl).replace(/^mqtts:/i, 'https:').replace(/^mqtt:/i, 'http:');
    return new URL(normalized).hostname;
  } catch {
    return '';
  }
}

/** TCP host + port from mqtt(s) URL. */
function mqttUrlHostPort(mqttUrl) {
  try {
    const normalized = String(mqttUrl).replace(/^mqtts:/i, 'https:').replace(/^mqtt:/i, 'http:');
    const u = new URL(normalized);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 8883,
    };
  } catch {
    return { host: 'localhost', port: 8883 };
  }
}

/**
 * TLS SNI + certificate hostname check.
 * Tunnels (bore.pub, ngrok, …) use a public hostname that is NOT in the broker cert SAN;
 * our Mosquitto server cert is issued for proof-mqtt.fly.dev (see statsmqtt deploy/fly/start.sh).
 */
function resolveTlsServername(mqttUrl) {
  const explicit = env('MQTT_TLS_SERVERNAME', '');
  if (nonEmpty(explicit)) return String(explicit).trim();
  const host = mqttUrlHostname(mqttUrl);
  if (host === 'bore.pub') return 'proof-mqtt.fly.dev';
  return undefined;
}

/**
 * PEM for verifying the broker TLS server cert.
 * Priority: MQTT_BROKER_CA (path) → crtDir/broker-ca.crt → crtDir/root_certifacite.txt (provisioning root CA)
 * → deploy/fly for non-EMQX hosts.
 * Empty MQTT_BROKER_CA forces system trust only. caForBrokerTls() still merges this PEM with tls.rootCertificates.
 */
function loadBrokerCaPem(repoRoot, mqttUrl, crtDir) {
  const raw = process.env.MQTT_BROKER_CA;
  const host = mqttUrl ? mqttUrlHostname(mqttUrl) : '';

  if (raw !== undefined && String(raw).trim() === '') {
    return { pem: null, resolvedPath: null };
  }

  if (raw !== undefined && String(raw).trim() !== '') {
    const relOrAbs = String(raw).trim();
    const resolvedPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(repoRoot, relOrAbs);
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`[MQTT] broker CA file missing: ${resolvedPath}`);
      return { pem: null, resolvedPath };
    }
    return { pem: fs.readFileSync(resolvedPath, 'utf8'), resolvedPath };
  }

  const bundledBrokerCa = path.join(crtDir, 'broker-ca.crt');
  if (fs.existsSync(bundledBrokerCa)) {
    return { pem: fs.readFileSync(bundledBrokerCa, 'utf8'), resolvedPath: bundledBrokerCa };
  }

  const provisionedRootPath = path.join(crtDir, 'root_certifacite.txt');
  if (fs.existsSync(provisionedRootPath)) {
    try {
      const pem = readFirstCertificatePemFromFile(provisionedRootPath);
      if (pem) {
        return { pem, resolvedPath: provisionedRootPath };
      }
    } catch (e) {
      console.warn(`[MQTT] could not read provisioning root CA from ${provisionedRootPath}: ${e.message}`);
    }
  }

  const defaultFlyCa = !/\.emqxcloud\.com$/i.test(host);
  const relOrAbs = defaultFlyCa ? path.join('deploy', 'fly', 'broker-ca.crt') : null;
  if (!relOrAbs) return { pem: null, resolvedPath: null };
  const resolvedPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(repoRoot, relOrAbs);
  if (!fs.existsSync(resolvedPath)) {
    console.warn(`[MQTT] broker CA file missing (copy broker-ca.crt here): ${resolvedPath}`);
    return { pem: null, resolvedPath };
  }
  return { pem: fs.readFileSync(resolvedPath, 'utf8'), resolvedPath };
}

/** Build mqtts:// URL from MQTT_URL or MQTT_BROKER + MQTT_PORT (statsmqtt-compatible). */
function resolveMqttUrl() {
  let url = env('MQTT_URL', '');
  if (!nonEmpty(url)) {
    const broker = env('MQTT_BROKER', '');
    const port = String(env('MQTT_PORT', '8883')).trim() || '8883';
    if (!nonEmpty(broker)) {
      throw new Error(
        '[MQTT] Set MQTT_URL (mqtts://host:8883) or MQTT_BROKER in .env or the environment. Copy .env.example to .env.',
      );
    }
    url = `mqtts://${String(broker).trim()}:${port}`;
  }

  if (/^mqtt:\/\//i.test(url)) {
    console.warn(
      '[MQTT] URL used mqtt:// (no TLS). Client certificates are ignored on plain MQTT; switching to mqtts:// for mTLS (see src/certs/ or CRT_DIR).',
    );
    url = url.replace(/^mqtt:/i, 'mqtts:');
  }

  if (/^mqtts:\/\//i.test(url) && !/:\d+(\/|$)/.test(url.replace(/^mqtts:\/\//i, ''))) {
    url = url.replace(/^mqtts:\/\//i, (m) => m) + ':8883';
  }

  return url;
}

const MQTT_FALLBACK_KEYS = [
  'MQTT_URL',
  'MQTT_BROKER',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  /** When unset in this repo, inherit from statsmqtt so CN-as-username is not left on by mistake */
  'MQTT_PEER_CN_AS_MQTT_USERNAME',
];

/**
 * Load env: sibling ../../statsmqtt/.env, then node-mqtt-client/.env (overrides).
 * Re-fill MQTT_* from statsmqtt when client .env left keys empty (e.g. MQTT_USERNAME= with no value).
 */
function loadMergedEnv(pkgRoot) {
  const statsmqttEnv = path.resolve(pkgRoot, '..', '..', 'statsmqtt', '.env');
  let statsParsed = null;
  if (fs.existsSync(statsmqttEnv)) {
    dotenv.config({ path: statsmqttEnv, quiet: true });
    try {
      statsParsed = dotenv.parse(fs.readFileSync(statsmqttEnv, 'utf8'));
    } catch {
      statsParsed = null;
    }
  }
  dotenv.config({ path: path.join(pkgRoot, '.env'), quiet: true, override: true });
  if (statsParsed) {
    for (const k of MQTT_FALLBACK_KEYS) {
      if (!nonEmpty(process.env[k]) && statsParsed[k] !== undefined && nonEmpty(String(statsParsed[k]).trim())) {
        process.env[k] = String(statsParsed[k]).trim();
      }
    }
  }
}

async function main() {
  const pkgRoot = path.resolve(__dirname, '..');
  loadMergedEnv(pkgRoot);

  const repoRoot = path.resolve(__dirname, '..', '..');
  const headerPath = path.resolve(repoRoot, env('DEVICE_KEYS_H', 'main/device_keys.h'));
  // PEM bundle: default src/certs/ (client.crt + client.key); override CRT_DIR or legacy src/crts/ layout.
  const crtDir = env('CRT_DIR', path.resolve(__dirname, 'certs'));

  const useCrtDir = env('USE_CRT_DIR', '1') === '1';
  const certPath = path.join(crtDir, 'device certificate CA signed.txt');
  const needsProvisioning = useCrtDir && !fs.existsSync(certPath);

  let deviceKeys;
  if (needsProvisioning) {
    console.log('[MQTT] No device cert in crtDir — running provisioning (CSR + sign-csr)...');
    deviceKeys = await provisionDevice(crtDir);
  } else if (useCrtDir) {
    console.log(
      `[MQTT] Using existing certs in ${crtDir} (skip provisioning). Remove "device certificate CA signed.txt" to generate a new key/CSR and call sign-csr again.`,
    );
    deviceKeys = loadDeviceKeysFromCrtFolder(crtDir);
  } else {
    deviceKeys = loadDeviceKeysFromHeader(headerPath);
  }

  const { deviceId, ca, cert, key } = deviceKeys;

  // Self-hosted Mosquitto (bore tunnel): custom broker CA. Public brokers: omit MQTT_BROKER_CA and use system trust.
  const useCustomCa = env('USE_CUSTOM_CA', '0') === '1';

  const url = resolveMqttUrl();

  const { pem: brokerCaPem, resolvedPath: brokerCaPath } = loadBrokerCaPem(repoRoot, url, crtDir);

  const topicRoot = env('MQTT_TOPIC_ROOT', 'proof.mqtt');
  const topicPrefix = env('TOPIC_PREFIX', `${topicRoot}/${deviceId}`);

  const tlsServername = resolveTlsServername(url);

  const subscribeAll = env('SUBSCRIBE_ALL', '1') === '1';
  const subscribeTopics = [
    ...(subscribeAll ? [`${topicPrefix}/#`] : []),
    `${topicPrefix}/registration_ack`,
    `${topicPrefix}/test-gmb`,
    `${topicPrefix}/instagram`,
    `${topicPrefix}/gmb`,
    `${topicPrefix}/pos`,
    `${topicPrefix}/promotion`,
  ];
  const host = mqttUrlHostname(url);
  const isEmqxCloud = /\.emqxcloud\.com$/i.test(host);

  const username = env('MQTT_USERNAME', '');
  const password = env('MQTT_PASSWORD', '');
  // Only use cert CN as MQTT username when explicitly enabled. EMQX Cloud + built-in DB almost always needs user+pass → connack code 4 if CN is sent with no password.
  const cnAsUsername = String(env('MQTT_PEER_CN_AS_MQTT_USERNAME', '0')).trim() === '1';
  const mqttUsername = cnAsUsername ? deviceId : username;

  if (isEmqxCloud && cnAsUsername && !nonEmpty(password)) {
    console.warn(
      '[MQTT] EMQX Cloud: MQTT_PEER_CN_AS_MQTT_USERNAME=1 sends CONNECT username = cert CN with no password. Built-in users expect MQTT_USERNAME/MQTT_PASSWORD — you will usually get connack code 4 (Bad username or password). Fix: set MQTT_PEER_CN_AS_MQTT_USERNAME=0 (or remove it) and set MQTT_USERNAME + MQTT_PASSWORD like statsmqtt .env, unless the console maps X.509 CN to auth without password.',
    );
  }

  if (isEmqxCloud && !cnAsUsername && (!nonEmpty(username) || !nonEmpty(password))) {
    console.warn(
      '[MQTT] EMQX Cloud usually needs MQTT_USERNAME and MQTT_PASSWORD (same as statsmqtt .env). Loaded ../../statsmqtt/.env when present; otherwise set them in node-mqtt-client/.env',
    );
  }

  let serverCa = null;
  if (brokerCaPem) {
    serverCa = caForBrokerTls(brokerCaPem);
  } else if (useCustomCa && nonEmpty(ca)) {
    serverCa = [...tls.rootCertificates, ca];
  } else if (useCustomCa && !nonEmpty(ca)) {
    console.warn('[MQTT] USE_CUSTOM_CA=1 but no device CA PEM in cert folder (add ca.crt / root-ca.crt or legacy root file); using system roots only');
    serverCa = [...tls.rootCertificates];
  }

  // Name we expect on the server certificate (SAN/CN). Defaults from resolveTlsServername for bore.pub.
  const tlsVerifyHostname = nonEmpty(env('MQTT_TLS_VERIFY_HOST', ''))
    ? String(env('MQTT_TLS_VERIFY_HOST', '')).trim()
    : tlsServername;

  const { host: tcpHost, port: tcpPort } = mqttUrlHostPort(url);
  // mqtt.js tls stream sets opts.servername = opts.host AFTER merge, so SNI + cert check use bore.pub unless we bypass it.
  const useCustomTlsStream =
    nonEmpty(tlsVerifyHostname) && String(tlsVerifyHostname) !== String(tcpHost);

  // bore.pub: default IPv4 — Node's dual-stack connect to tls.connect() often surfaces AggregateError;
  // tunnels are frequently IPv4-only. Override with MQTT_IP_FAMILY=6 or MQTT_IP_FAMILY= (empty = OS default).
  const ipFamilyEnv = process.env.MQTT_IP_FAMILY;
  const ipFamily =
    ipFamilyEnv !== undefined ? String(ipFamilyEnv).trim() : tcpHost === 'bore.pub' ? '4' : '';

  const authLabel = nonEmpty(password)
    ? nonEmpty(mqttUsername)
      ? 'username+password'
      : 'password only'
    : nonEmpty(mqttUsername)
      ? cnAsUsername
        ? 'CONNECT user=cert CN (MQTT_PEER_CN_AS_MQTT_USERNAME=1, no password)'
        : 'CONNECT username only (no password)'
      : 'no CONNECT user/pass (X.509-only if broker allows)';

  console.log(
    `[MQTT] connect: clientId=${deviceId} url=${url} tlsVerifyHost=${tlsVerifyHostname || '(URL host)'} tlsStream=${useCustomTlsStream ? 'custom (SNI+cert name)' : 'mqtt.js'} tcpFamily=${ipFamily || 'default'} mTLS=${useCrtDir ? crtDir : 'header'} brokerCA=${brokerCaPath || (useCustomCa ? 'USE_CUSTOM_CA+device-ca' : 'system')} mqttAuth=${authLabel}`,
  );

  const will = {
    topic: `${topicPrefix}/lwt`,
    payload: JSON.stringify({
      type: 'un_registration',
      clientId: deviceId,
      timestamp: new Date().toISOString(),
    }),
    qos: 1,
    retain: false,
  };

  const sharedMqttOpts = {
    protocolVersion: 4,
    clientId: deviceId,
    clean: true,
    keepalive: Number(env('MQTT_KEEPALIVE', '60')) || 60,
    reconnectPeriod: 2000,
    ...(nonEmpty(mqttUsername) ? { username: mqttUsername } : {}),
    ...(nonEmpty(password) ? { password } : {}),
    cert,
    key,
    ...(serverCa ? { ca: serverCa } : {}),
    rejectUnauthorized: true,
    will,
  };

  let client;
  if (useCustomTlsStream) {
    const verifyName = String(tlsVerifyHostname);
    client = new mqtt.MqttClient((mc) => {
      const o = mc.options;
      const port = o.port || 8883;
      const host = o.host;
      const tlsBase = {
        servername: verifyName,
        ...(serverCa ? { ca: serverCa } : {}),
        cert: o.cert,
        key: o.key,
        rejectUnauthorized: o.rejectUnauthorized !== false,
        checkServerIdentity: (_host, peerCert) => tls.checkServerIdentity(verifyName, peerCert),
      };
      if (ipFamily === '4' || ipFamily === '6') {
        const socket = net.connect({ port, host, family: Number(ipFamily) });
        return tls.connect({ socket, ...tlsBase });
      }
      return tls.connect({ host, port, ...tlsBase });
    }, {
      ...sharedMqttOpts,
      protocol: 'mqtts',
      host: tcpHost,
      hostname: tcpHost,
      port: tcpPort,
    });
  } else {
    client = mqtt.connect(url, {
      ...sharedMqttOpts,
      ...(tlsVerifyHostname && !useCustomTlsStream
        ? {
            checkServerIdentity: (_h, peerCert) =>
              tls.checkServerIdentity(String(tlsVerifyHostname), peerCert),
          }
        : {}),
    });
  }

  client.on('connect', () => {
    console.log(`[MQTT] Connected. clientId=${deviceId}`);
    console.log(`[MQTT] Subscribing under ${topicPrefix}/... (all=${subscribeAll})`);

    for (const t of subscribeTopics) {
      client.subscribe(t, { qos: 1 }, (err) => {
        if (err) console.error(`[MQTT] subscribe ${t} failed:`, err.message || err);
        else console.log(`[MQTT] subscribe ${t}: OK`);
      });
    }

    const regTopic = env('REG_TOPIC', `${topicPrefix}/active`);
    const payload = {
      type: 'device_registration',
      userId: env('USER_ID', 'ESP32-ABC123'),
      clientId: deviceId,
      timestamp: new Date().toISOString(),
      deviceType: env('DEVICE_TYPE', 'node'),
      os: env('DEVICE_OS', process.platform),
      appVersion: env('APP_VERSION', '1.0.0'),
      metadata: {
        ipAddress: env('IP_ADDRESS', '127.0.0.1'),
        userAgent: env('USER_AGENT', 'node-mqtt-client'),
      },
    };
    client.publish(regTopic, JSON.stringify(payload), { qos: 1, retain: false }, (err) => {
      if (err) console.error('[MQTT] registration publish failed:', err.message || err);
      else console.log(`[MQTT] registration published to ${regTopic}`);
    });

    const statusTopic = env('STATUS_TOPIC', `${topicPrefix}/status`);
    const statusPayload = {
      type: 'status',
      status: 'online',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    client.publish(statusTopic, JSON.stringify(statusPayload), { qos: 1, retain: false }, (err) => {
      if (err) console.error('[MQTT] status publish failed:', err.message || err);
      else console.log(`[MQTT] status published to ${statusTopic}`);
    });
  });

  client.on('message', (topic, message) => {
    const text = message.toString('utf8');
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      // keep raw
    }
    console.log(`[MQTT] message topic=${topic}\n${pretty}`);
  });

  client.on('packetreceive', (packet) => {
    if (!packet) return;
    if (packet.cmd === 'publish') return; // already logged via 'message'
    console.log(`[MQTT] <- packet cmd=${packet.cmd} ${packet.reasonCode !== undefined ? `reason=${packet.reasonCode}` : ''}`);
  });

  client.on('packetsend', (packet) => {
    if (!packet) return;
    if (packet.cmd === 'publish') return;
    console.log(`[MQTT] -> packet cmd=${packet.cmd}`);
  });

  client.on('error', (err) => {
    console.error('[MQTT] error:\n', formatConnectError(err));
    const msg = err && err.message ? err.message : String(err);
    const code = err && err.code;

    if (typeof AggregateError !== 'undefined' && err instanceof AggregateError) {
      console.error(
        '[MQTT] hint: read "sub-errors" above. ECONNREFUSED/ETIMEDOUT → start bore (or your tunnel), set MQTT_URL to the host:port bore printed, and keep the tunnel running. tcpFamily=4 is default for bore.pub; MQTT_IP_FAMILY= for OS dual-stack.',
      );
    }
    if (code === 'EAI_AGAIN' || /EAI_AGAIN|getaddrinfo/i.test(msg)) {
      console.error(
        '[MQTT] hint: DNS lookup failed (EAI_AGAIN) — check internet/VPN/DNS, wait and retry. If the hostname is wrong, set MQTT_BROKER in .env to your current EMQX deployment host.',
      );
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg) || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
      console.error(
        '[MQTT] hint: TCP failed — bore port changes each session. Run your tunnel script, copy the new port into MQTT_URL (e.g. mqtts://bore.pub:8373), not a stale port.',
      );
    }
    if (/unable to get (local )?issuer certificate|self signed certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(msg)) {
      console.error(
        `[MQTT] hint: client cannot verify the **server** cert — place broker CA as src/certs/broker-ca.crt (or CRT_DIR), deploy/fly/broker-ca.crt, or set MQTT_BROKER_CA. (Not the same as UNKNOWN_CA below.)`,
      );
    }
    if (/does not match certificate|altnames|cert's altnames/i.test(msg)) {
      console.error(
        `[MQTT] hint: tunnel hostname ≠ cert SAN — MQTT_TLS_VERIFY_HOST=proof-mqtt.fly.dev is default for bore.pub; custom TLS stream applies automatically.`,
      );
    }
    if (/Bad username or password|Not authorized/i.test(msg)) {
      console.error(
        '[MQTT] hint (connack 4): Wrong MQTT username or password — set MQTT_USERNAME + MQTT_PASSWORD to match an EMQX user (Console → Authentication).',
      );
      console.error(
        '[MQTT] hint (connack 5 "Not authorized"): Often no usable auth when CONNECT has no user/pass. Fix A: set MQTT_USERNAME and MQTT_PASSWORD in .env. Fix B: EMQX Console → Authentication → add **X.509** and upload the **same CA** that signed your device cert (src/crts), then connect with mqttAuth=no. With **peer cert as username=CN**, use MQTT_PEER_CN_AS_MQTT_USERNAME=1 and MQTT_PASSWORD if that user uses a password in EMQX.',
      );
    }
    // TLS alert 48: broker does not trust the **device** certificate issuer (opposite direction from broker-ca.crt).
    if (
      code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' ||
      /UNKNOWN_CA|tlsv1 alert unknown ca|alert unknown ca|ALERT_UNKNOWN_CA|ERR_SSL_TLSV1_ALERT_UNKNOWN_CA|SSL alert number 48/i.test(
        msg,
      )
    ) {
      console.error(
        '[MQTT] hint (UNKNOWN_CA / alert 48): Mosquitto rejected your **client** cert — its chain is not signed by the CA in the broker\'s cafile (e.g. /data/ca/root-ca.crt). broker-ca.crt is only for **this app** to trust the **server**.',
      );
      console.error(
        '[MQTT] fix: use client.crt + client.key (under src/certs/ or CRT_DIR) signed by the **same** CA the broker trusts. Add ca.crt/root-ca.crt if you use USE_CUSTOM_CA. Legacy filenames still supported — see device_keys_from_header.js.',
      );
    }
  });

  client.on('close', () => {
    console.log('[MQTT] connection closed');
  });

  process.on('SIGINT', () => {
    console.log('\n[MQTT] disconnecting...');
    client.end(true, () => process.exit(0));
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

