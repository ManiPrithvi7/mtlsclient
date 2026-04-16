const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const MQTT_FALLBACK_KEYS = [
  'MQTT_URL',
  'MQTT_BROKER',
  'MQTT_PORT',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_PEER_CN_AS_MQTT_USERNAME',
];

function env(name, fallback) {
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function mqttUrlHostname(mqttUrl) {
  try {
    const normalized = String(mqttUrl).replace(/^mqtts:/i, 'https:').replace(/^mqtt:/i, 'http:');
    return new URL(normalized).hostname;
  } catch {
    return '';
  }
}

function mqttUrlHostPort(mqttUrl) {
  try {
    const normalized = String(mqttUrl).replace(/^mqtts:/i, 'https:').replace(/^mqtt:/i, 'http:');
    const url = new URL(normalized);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 8883,
    };
  } catch {
    return { host: 'localhost', port: 8883 };
  }
}

function resolveTlsServername(mqttUrl) {
  const explicit = env('MQTT_TLS_SERVERNAME', '');
  if (nonEmpty(explicit)) return String(explicit).trim();

  const host = mqttUrlHostname(mqttUrl);
  if (host === 'bore.pub') return 'proof-mqtt.fly.dev';
  return undefined;
}

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
    url = `${url}:8883`;
  }

  return url;
}

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

  if (!statsParsed) return;
  for (const key of MQTT_FALLBACK_KEYS) {
    if (!nonEmpty(process.env[key]) && statsParsed[key] !== undefined && nonEmpty(String(statsParsed[key]).trim())) {
      process.env[key] = String(statsParsed[key]).trim();
    }
  }
}

function loadRuntimeConfig() {
  const pkgRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(__dirname, '..', '..');

  loadMergedEnv(pkgRoot);

  const url = resolveMqttUrl();
  const tcpAddress = mqttUrlHostPort(url);
  const tlsServername = resolveTlsServername(url);
  const tlsVerifyHostname = nonEmpty(env('MQTT_TLS_VERIFY_HOST', ''))
    ? String(env('MQTT_TLS_VERIFY_HOST', '')).trim()
    : tlsServername;

  return {
    pkgRoot,
    repoRoot,
    url,
    urlHost: mqttUrlHostname(url),
    mqttUrl: url,
    backendUrl: env('BACKEND_URL', env('PROVISIONING_SERVER_URL', '')),
    provisioningServerUrl: env('PROVISIONING_SERVER_URL', ''),
    controlPort: Number(env('CONTROL_PORT', '3001')) || 3001,
    autoProvision: env('AUTO_PROVISION', '1') === '1',
    headerPath: path.resolve(repoRoot, env('DEVICE_KEYS_H', 'main/device_keys.h')),
    crtDir: env('CRT_DIR', path.resolve(__dirname, 'certs')),
    certPath: env('CRT_DIR', path.resolve(__dirname, 'certs')),
    useCrtDir: env('USE_CRT_DIR', '1') === '1',
    useCustomCa: env('USE_CUSTOM_CA', '0') === '1',
    topicRoot: env('MQTT_TOPIC_ROOT', 'proof.mqtt'),
    tlsServername,
    tlsVerifyHostname,
    tcpAddress,
    username: env('MQTT_USERNAME', ''),
    password: env('MQTT_PASSWORD', ''),
    cnAsUsername: String(env('MQTT_PEER_CN_AS_MQTT_USERNAME', '0')).trim() === '1',
    keepalive: Number(env('MQTT_KEEPALIVE', '60')) || 60,
    subscribeAll: env('SUBSCRIBE_ALL', '1') === '1',
    ipFamilyEnv: process.env.MQTT_IP_FAMILY,
  };
}

module.exports = {
  env,
  nonEmpty,
  mqttUrlHostname,
  mqttUrlHostPort,
  resolveTlsServername,
  resolveMqttUrl,
  loadMergedEnv,
  loadRuntimeConfig,
};
