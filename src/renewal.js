const http = require('node:http');
const https = require('node:https');

const { generateKeyAndCsr } = require('./provisioning');
const { testMqttConnection } = require('./mqttClient');

function requestJson(urlString, method, body, extraOptions = {}) {
  const target = new URL(urlString);
  const payload = body ? JSON.stringify(body) : null;
  const lib = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload, 'utf8') } : {}),
          ...(extraOptions.headers || {}),
        },
        cert: extraOptions.cert,
        key: extraOptions.key,
        ca: extraOptions.ca,
        rejectUnauthorized: extraOptions.rejectUnauthorized !== false,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const json = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
              return;
            }
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          } catch (error) {
            reject(new Error(`Response parse failed: ${error.message}`));
          }
        });
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCertificatePayload(responseJson) {
  const root =
    responseJson.data && typeof responseJson.data === 'object' && !Array.isArray(responseJson.data)
      ? responseJson.data
      : responseJson;

  const certificate =
    root.certificate || root.deviceCertificate || root.device_cert || root.cert || root.certificate_pem;

  if (typeof certificate !== 'string' || !certificate.includes('BEGIN CERTIFICATE')) {
    throw new Error('Backend did not return a PEM certificate');
  }

  return certificate.trim();
}

class RenewalFlow {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  async run() {
    const currentInfo = await this.store.getCertificateInfo();
    if (!currentInfo?.deviceId) {
      throw new Error('Cannot renew without an existing primary certificate');
    }

    const { csrPem, keyPem } = generateKeyAndCsr(currentInfo.deviceId, process.env.CERT_CN_PREFIX || 'PROOF');
    await this.store.saveStaging(null, keyPem);

    try {
      const primary = await this.store.loadPrimary();
      const renewResponse = await requestJson(
        new URL('/api/v1/certificates/renewAuth', this.config.backendUrl).toString(),
        'POST',
        { csr: csrPem },
        { cert: primary.cert, key: primary.key },
      );

      const renewedCert = extractCertificatePayload(renewResponse);
      await this.store.saveStaging(renewedCert, keyPem);

      const brokerCa = this.store.loadBrokerCaPem();
      await testMqttConnection(
        this.config,
        { deviceId: currentInfo.deviceId, cert: renewedCert, key: keyPem, ca: this.store.readLegacyCaPem() },
        brokerCa,
        10000,
      );

      await requestJson(
        new URL('/api/v1/certificates/confirm', this.config.backendUrl).toString(),
        'POST',
        {},
        { cert: renewedCert, key: keyPem },
      );

      await this.store.promoteStagingToPrimary();
      return true;
    } catch (error) {
      await this.store.clearStaging();
      throw error;
    }
  }
}

module.exports = { RenewalFlow, requestJson, extractCertificatePayload };
