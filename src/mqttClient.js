const net = require('node:net');
const tls = require('node:tls');
const mqtt = require('mqtt');

const { caForBrokerTls } = require('./tlsBrokerCa');
const { env, nonEmpty } = require('./config');

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
    err.errors.forEach((nested, index) => {
      lines.push(
        `  [${index}] ${nested && nested.message ? nested.message : String(nested)}${nested && nested.code ? ` (code=${nested.code})` : ''}`,
      );
    });
  }
  return lines.join('\n');
}

class MqttRuntimeClient {
  constructor(config, deviceKeys, brokerCa) {
    this.config = config;
    this.deviceKeys = deviceKeys;
    this.brokerCa = brokerCa;
  }

  createClient() {
    const { deviceId, ca, cert, key } = this.deviceKeys;
    const topicPrefix = `${this.config.topicRoot}/${deviceId}`;
    const explicitSubtopics = [
      `${topicPrefix}/registration_ack`,
      `${topicPrefix}/test-gmb`,
      `${topicPrefix}/instagram`,
      `${topicPrefix}/gmb`,
      `${topicPrefix}/pos`,
      `${topicPrefix}/promotion`,
    ];
    const subscribeTopics = this.config.subscribeAll ? [`${topicPrefix}/#`] : explicitSubtopics;
    const isEmqxCloud = /\.emqxcloud\.com$/i.test(this.config.urlHost);
    const mqttUsername = this.config.cnAsUsername ? deviceId : this.config.username;

    if (isEmqxCloud && this.config.cnAsUsername && !nonEmpty(this.config.password)) {
      console.warn(
        '[MQTT] EMQX Cloud: MQTT_PEER_CN_AS_MQTT_USERNAME=1 sends CONNECT username = cert CN with no password. Built-in users expect MQTT_USERNAME/MQTT_PASSWORD — you will usually get connack code 4 (Bad username or password). Fix: set MQTT_PEER_CN_AS_MQTT_USERNAME=0 (or remove it) and set MQTT_USERNAME + MQTT_PASSWORD like statsmqtt .env, unless the console maps X.509 CN to auth without password.',
      );
    }

    if (isEmqxCloud && !this.config.cnAsUsername && (!nonEmpty(this.config.username) || !nonEmpty(this.config.password))) {
      console.warn(
        '[MQTT] EMQX Cloud usually needs MQTT_USERNAME and MQTT_PASSWORD (same as statsmqtt .env). Loaded ../../statsmqtt/.env when present; otherwise set them in node-mqtt-client/.env',
      );
    }

    let serverCa = null;
    if (this.brokerCa.pem) {
      serverCa = caForBrokerTls(this.brokerCa.pem);
    } else if (this.config.useCustomCa && nonEmpty(ca)) {
      serverCa = [...tls.rootCertificates, ca];
    } else if (this.config.useCustomCa && !nonEmpty(ca)) {
      console.warn(
        '[MQTT] USE_CUSTOM_CA=1 but no device CA PEM in cert folder (add ca.crt / root-ca.crt or legacy root file); using system roots only',
      );
      serverCa = [...tls.rootCertificates];
    }

    const useCustomTlsStream =
      nonEmpty(this.config.tlsVerifyHostname) &&
      String(this.config.tlsVerifyHostname) !== String(this.config.tcpAddress.host);
    const ipFamily =
      this.config.ipFamilyEnv !== undefined
        ? String(this.config.ipFamilyEnv).trim()
        : this.config.tcpAddress.host === 'bore.pub'
          ? '4'
          : '';

    const authLabel = nonEmpty(this.config.password)
      ? nonEmpty(mqttUsername)
        ? 'username+password'
        : 'password only'
      : nonEmpty(mqttUsername)
        ? this.config.cnAsUsername
          ? 'CONNECT user=cert CN (MQTT_PEER_CN_AS_MQTT_USERNAME=1, no password)'
          : 'CONNECT username only (no password)'
        : 'no CONNECT user/pass (X.509-only if broker allows)';

    console.log(
      `[MQTT] connect: clientId=${deviceId} url=${this.config.url} tlsVerifyHost=${this.config.tlsVerifyHostname || '(URL host)'} tlsStream=${useCustomTlsStream ? 'custom (SNI+cert name)' : 'mqtt.js'} tcpFamily=${ipFamily || 'default'} mTLS=${this.config.useCrtDir ? this.config.crtDir : 'header'} brokerCA=${this.brokerCa.resolvedPath || (this.config.useCustomCa ? 'USE_CUSTOM_CA+device-ca' : 'system')} mqttAuth=${authLabel}`,
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
      keepalive: this.config.keepalive,
      reconnectPeriod: 2000,
      ...(nonEmpty(mqttUsername) ? { username: mqttUsername } : {}),
      ...(nonEmpty(this.config.password) ? { password: this.config.password } : {}),
      cert,
      key,
      ...(serverCa ? { ca: serverCa } : {}),
      rejectUnauthorized: true,
      will,
    };

    if (useCustomTlsStream) {
      const verifyName = String(this.config.tlsVerifyHostname);
      return new mqtt.MqttClient((mqttClient) => {
        const options = mqttClient.options;
        const port = options.port || 8883;
        const host = options.host;
        const tlsBase = {
          servername: verifyName,
          ...(serverCa ? { ca: serverCa } : {}),
          cert: options.cert,
          key: options.key,
          rejectUnauthorized: options.rejectUnauthorized !== false,
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
        host: this.config.tcpAddress.host,
        hostname: this.config.tcpAddress.host,
        port: this.config.tcpAddress.port,
      });
    }

    return mqtt.connect(this.config.url, {
      ...sharedMqttOpts,
      ...(this.config.tlsVerifyHostname
        ? {
            checkServerIdentity: (_host, peerCert) =>
              tls.checkServerIdentity(String(this.config.tlsVerifyHostname), peerCert),
          }
        : {}),
    });
  }

  attachLifecycle(client) {
    const { deviceId } = this.deviceKeys;
    const topicPrefix = `${this.config.topicRoot}/${deviceId}`;
    const subscribeTopics = this.config.subscribeAll
      ? [`${topicPrefix}/#`]
      : [
          `${topicPrefix}/registration_ack`,
          `${topicPrefix}/test-gmb`,
          `${topicPrefix}/instagram`,
          `${topicPrefix}/gmb`,
          `${topicPrefix}/pos`,
          `${topicPrefix}/promotion`,
        ];

    client.on('connect', () => {
      console.log(`[MQTT] Connected. clientId=${deviceId}`);
      console.log(`[MQTT] Subscribing under ${topicPrefix}/... (all=${this.config.subscribeAll})`);

      for (const topic of subscribeTopics) {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) console.error(`[MQTT] subscribe ${topic} failed:`, err.message || err);
          else console.log(`[MQTT] subscribe ${topic}: OK`);
        });
      }

      const regTopic = env('REG_TOPIC', `${topicPrefix}/active`);
      const registrationPayload = {
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

      client.publish(regTopic, JSON.stringify(registrationPayload), { qos: 1, retain: false }, (err) => {
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
      } catch {
        // keep raw
      }
      console.log(`[MQTT] message topic=${topic}\n${pretty}`);
    });

    client.on('packetreceive', (packet) => {
      if (!packet || packet.cmd === 'publish') return;
      console.log(`[MQTT] <- packet cmd=${packet.cmd} ${packet.reasonCode !== undefined ? `reason=${packet.reasonCode}` : ''}`);
    });

    client.on('packetsend', (packet) => {
      if (!packet || packet.cmd === 'publish') return;
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
          '[MQTT] hint: client cannot verify the **server** cert — place broker CA as src/certs/broker-ca.crt (or CRT_DIR), deploy/fly/broker-ca.crt, or set MQTT_BROKER_CA. (Not the same as UNKNOWN_CA below.)',
        );
      }
      if (/does not match certificate|altnames|cert's altnames/i.test(msg)) {
        console.error(
          '[MQTT] hint: tunnel hostname ≠ cert SAN — MQTT_TLS_VERIFY_HOST=proof-mqtt.fly.dev is default for bore.pub; custom TLS stream applies automatically.',
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
  }

  connect() {
    const client = this.createClient();
    this.attachLifecycle(client);
    return client;
  }
}

function testMqttConnection(config, deviceKeys, brokerCa, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const runtimeClient = new MqttRuntimeClient(config, deviceKeys, brokerCa);
    const client = runtimeClient.createClient();

    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error('MQTT connection timeout'));
    }, timeoutMs);

    client.once('connect', () => {
      clearTimeout(timer);
      client.end(true, () => resolve(true));
    });

    client.once('error', (error) => {
      clearTimeout(timer);
      client.end(true);
      reject(error);
    });
  });
}

module.exports = {
  MqttRuntimeClient,
  formatConnectError,
  testMqttConnection,
};
