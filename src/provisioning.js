'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');
const { stripCnPrefix } = require('./device_keys_from_header');

/**
 * CN for CSR: {CERT_CN_PREFIX}-{deviceId}. If DEVICE_ID already includes the prefix (e.g. PROOF-ESP32-abc),
 * do not double it (PROOF-PROOF-...).
 */
function buildSubjectCn(deviceIdRaw, certCnPrefix) {
  const prefix = (certCnPrefix || 'PROOF').trim().replace(/[-_]+$/g, '');
  const d = String(deviceIdRaw).trim();
  if (!prefix) return d;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escaped}[-_]`, 'i').test(d)) {
    return d;
  }
  return `${prefix}-${d}`;
}

/**
 * Generates an RSA key pair and a CSR with CN = buildSubjectCn(deviceId, certCnPrefix).
 * Returns { csrPem, keyPem, cn }
 */
function generateKeyAndCsr(deviceId, certCnPrefix) {
  const cn = buildSubjectCn(deviceId, certCnPrefix);

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  return { csrPem, keyPem, cn };
}

/**
 * Makes a raw HTTP/HTTPS request and returns { statusCode, body }.
 */
function rawRequest(options, body) {
  const isHttps = options._protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Builds base request options from a URL string.
 */
function baseOptions(serverUrl, urlPath, method, extraHeaders = {}) {
  const u = new URL(urlPath, serverUrl);
  const isHttps = u.protocol === 'https:';
  const defaultPort = isHttps ? 443 : 80;
  return {
    _protocol: u.protocol,
    method,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : defaultPort,
    path: `${u.pathname}${u.search || ''}`,
    headers: extraHeaders,
  };
}

/**
 * Downloads an existing device certificate bundle by certificateId.
 * GET /api/v1/certificates/:certificateId/download
 * Returns { deviceCert, rootCa }
 *
 * NOTE: The private key cannot be recovered from the server — it only exists
 * in the CSR flow. If 409 fires on a fresh machine (no local key), the device
 * must be revoked server-side and re-provisioned. See DEVICE_HAS_ACTIVE_CERTIFICATE
 * handling in provisionDevice() below.
 */
async function downloadCertificate(certificateId) {
  const serverUrl = process.env.PROVISIONING_SERVER_URL;
  const provisioningToken = process.env.PROVISIONING_TOKEN;
  const tokenInBodyOnly = String(process.env.PROVISIONING_TOKEN_IN_BODY || '').trim() === '1';

  if (!serverUrl || !provisioningToken) {
    throw new Error('Missing env: PROVISIONING_SERVER_URL, PROVISIONING_TOKEN');
  }

  const opts = baseOptions(
    serverUrl,
    `/api/v1/certificates/${encodeURIComponent(certificateId)}/download`,
    'GET',
    {
      'Content-Type': 'application/json',
      ...(!tokenInBodyOnly ? { Authorization: `Bearer ${provisioningToken}` } : {}),
    },
  );

  console.log(`[PROVISION] Downloading existing certificate: ${certificateId}`);
  const { statusCode, body } = await rawRequest(opts);

  if (statusCode !== 200 && statusCode !== 201) {
    throw new Error(
      `certificate download failed: HTTP ${statusCode} — ${body.slice(0, 2000)}`,
    );
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error(`certificate download parse error: ${e.message}`);
  }

  // Unwrap optional .data envelope
  const root =
    json.data !== undefined && json.data !== null && typeof json.data === 'object' && !Array.isArray(json.data)
      ? json.data
      : json;
const rawCert =
  root.certificate ||
  root.deviceCertificate ||
  root.device_cert ||
  root.cert ||
  root.certificate_pem ||
  root.device_certificate;

const deviceCert = typeof rawCert === 'object' && rawCert !== null
  ? rawCert.content   // ← unwrap nested { content, filename }
  : rawCert;

const rawCa =
  root.ca_certificate ||
  root.caCertificate ||
  root.rootCa ||
  root.rootCA ||
  root.root_ca ||
  root.ca_cert ||
  root.ca ||
  root.ca_pem;

const rootCa = typeof rawCa === 'object' && rawCa !== null
  ? rawCa.content     // ← unwrap nested { content, filename }
  : rawCa;

  const pemOk = (s) => typeof s === 'string' && s.includes('BEGIN CERTIFICATE');

  if (!pemOk(deviceCert)) {
    throw new Error(
      `certificate download: expected certificate PEM; got ${typeof deviceCert}`,
    );
  }
  if (!pemOk(rootCa)) {
    throw new Error(
      `certificate download: expected ca_certificate PEM; got ${typeof rootCa}`,
    );
  }

  return { deviceCert: deviceCert.trim(), rootCa: rootCa.trim() };
}

/**
 * Submits CSR to POST /api/v1/sign-csr.
 * Returns { deviceCert, rootCa } on success.
 * Throws with .code = 'DEVICE_HAS_ACTIVE_CERTIFICATE' and .certificateId on 409.
 */
async function submitCsr(csrPem) {
  const serverUrl = process.env.PROVISIONING_SERVER_URL;
  const provisioningToken = process.env.PROVISIONING_TOKEN;
  const tokenInBodyOnly = String(process.env.PROVISIONING_TOKEN_IN_BODY || '').trim() === '1';

  if (!serverUrl || !provisioningToken) {
    throw new Error('Missing env for sign-csr: PROVISIONING_SERVER_URL, PROVISIONING_TOKEN');
  }

  const body = tokenInBodyOnly
    ? JSON.stringify({ csr: csrPem, provisioning_token: provisioningToken })
    : JSON.stringify({ csr: csrPem });

  const opts = baseOptions(
    serverUrl,
    '/api/v1/sign-csr',
    'POST',
    {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      ...(!tokenInBodyOnly ? { Authorization: `Bearer ${provisioningToken}` } : {}),
    },
  );

  const { statusCode, body: data } = await rawRequest(opts, body);

  if (statusCode === 409) {
    // Device already has an active certificate — parse certificateId for download fallback.
    let certId = null;
    let errMsg = `sign-csr 409: device already has an active certificate`;
    try {
      const errJson = JSON.parse(data);
      certId = errJson.certificateId || null;
      if (errJson.error) errMsg += ` — ${errJson.error}`;
    } catch { /* ignore */ }

    const err = new Error(errMsg);
    err.code = 'DEVICE_HAS_ACTIVE_CERTIFICATE';
    err.certificateId = certId;
    throw err;
  }

  if (statusCode !== 200 && statusCode !== 201) {
    let extra = '';
    try {
      const errJson = JSON.parse(data);
      const code = errJson.code || errJson.error;
      if (code === 'TOKEN_ALREADY_USED' || /already used/i.test(String(errJson.message || ''))) {
        extra = ' Provisioning JWT is one-time — call POST /api/v1/onboarding again for a new PROVISIONING_TOKEN.';
      } else if (code === 'TOKEN_EXPIRED' || /expired/i.test(String(errJson.message || ''))) {
        extra = ' Provisioning JWT expired — call /api/v1/onboarding again to get a new token.';
      }
    } catch { /* ignore */ }
    throw new Error(`sign-csr failed: HTTP ${statusCode} — ${data.slice(0, 2000)}${extra}`);
  }

  try {
    const json = JSON.parse(data);
    const root =
      json.data !== undefined && json.data !== null && typeof json.data === 'object' && !Array.isArray(json.data)
        ? json.data
        : json;

    const deviceCert =
      root.certificate ||
      root.deviceCertificate ||
      root.device_cert ||
      root.cert ||
      root.certificate_pem ||
      root.device_certificate;

    const rootCa =
      root.ca_certificate ||
      root.caCertificate ||
      root.rootCa ||
      root.rootCA ||
      root.root_ca ||
      root.ca_cert ||
      root.ca ||
      root.ca_pem;

    const pemOk = (s) => typeof s === 'string' && s.includes('BEGIN CERTIFICATE');
    if (!pemOk(deviceCert)) {
      throw new Error(`sign-csr: expected body.certificate PEM; got ${typeof deviceCert}`);
    }
    if (!pemOk(rootCa)) {
      throw new Error(`sign-csr: expected body.ca_certificate PEM; got ${typeof rootCa}`);
    }

    return { deviceCert: deviceCert.trim(), rootCa: rootCa.trim() };
  } catch (e) {
    throw new Error(`sign-csr parse error: ${e.message}`);
  }
}

/**
 * Writes the three crt files loadDeviceKeysFromCrtFolder() expects.
 * keyPem may be null when recovering an existing cert (download path) —
 * in that case privatekey_protect.txt is NOT overwritten if it already exists.
 */
function writeCertFiles(crtDir, { deviceCert, rootCa, keyPem }) {
  fs.mkdirSync(crtDir, { recursive: true });

  const keyPath  = path.join(crtDir, 'privatekey_protect.txt');
  const certPath = path.join(crtDir, 'device certificate CA signed.txt');
  const rootPath = path.join(crtDir, 'root_certifacite.txt');

  if (keyPem) {
    fs.writeFileSync(
      keyPath,
      `===== STORED PRIVATE KEY =====\n${keyPem}\n===== END KEY =====\n`,
      'utf8',
    );
  } else if (!fs.existsSync(keyPath)) {
    // No key returned from server and no local key — caller must handle this.
    throw new Error(
      'Private key is not available: the server cannot return the private key after initial provisioning. ' +
      'Delete the device certificate server-side and re-provision to generate a fresh key pair.',
    );
  }
  // else: key file already on disk — leave it untouched (download just refreshed cert + CA).

  fs.writeFileSync(
    certPath,
    `===== DEVICE CERTIFICATE (CA-SIGNED) =====\n${deviceCert}\n===== END DEVICE CERTIFICATE =====\n`,
    'utf8',
  );
  fs.writeFileSync(
    rootPath,
    `===== ROOT CA =====\n${rootCa}\n===== END ROOT CA =====\n`,
    'utf8',
  );
}

/**
 * Full provisioning flow:
 *
 *  1. Generate RSA key + CSR locally.
 *  2. POST /api/v1/sign-csr
 *     → 200/201 : write key + cert + CA, done.
 *     → 409 (DEVICE_HAS_ACTIVE_CERTIFICATE):
 *         a. If certificateId returned AND local key already exists
 *            → GET /api/v1/certificates/:id/download, refresh cert + CA only.
 *         b. If no local key (fresh machine)
 *            → error with clear instructions (revoke server-side + re-provision).
 */
async function provisionDevice(crtDir) {
  const deviceId = process.env.DEVICE_ID;
  const certCnPrefix = process.env.CERT_CN_PREFIX || 'PROOF';

  if (!deviceId || !String(deviceId).trim()) {
    throw new Error(
      'DEVICE_ID env var is required for provisioning (CSR CN must match the device_id from onboarding)',
    );
  }

  const keyPath = path.join(crtDir, 'privatekey_protect.txt');

  console.log(`[PROVISION] Generating key + CSR for device: ${String(deviceId).trim()}`);
  const { csrPem, keyPem, cn } = generateKeyAndCsr(String(deviceId).trim(), certCnPrefix);
  console.log(`[PROVISION] CSR subject CN=${cn}`);
  console.log('[PROVISION] Submitting CSR to server...');

  let deviceCert, rootCa, usedKeyPem;

  try {
    ({ deviceCert, rootCa } = await submitCsr(csrPem));
    usedKeyPem = keyPem; // fresh key from this CSR
  } catch (err) {
    if (err.code !== 'DEVICE_HAS_ACTIVE_CERTIFICATE') throw err;

    // ── 409 branch ──────────────────────────────────────────────────────────
    console.warn(`[PROVISION] 409: device already has an active certificate.`);

    const { certificateId } = err;

    if (!certificateId) {
      throw new Error(
        '[PROVISION] Server returned 409 but no certificateId — cannot download existing cert. ' +
        'Ask an admin to revoke the device certificate and re-provision.',
      );
    }

    const localKeyExists = fs.existsSync(keyPath);

    if (!localKeyExists) {
      throw new Error(
        `[PROVISION] Device "${String(deviceId).trim()}" already has an active certificate on the server ` +
        `(id: ${certificateId}), but no local private key was found in ${crtDir}.\n` +
        `The private key cannot be recovered from the server.\n` +
        `To fix: ask an admin to revoke certificate ${certificateId} for this device, ` +
        `then delete src/crts/ and run npm start again to re-provision.`,
      );
    }

    // Local key exists — just refresh cert + CA from server.
    console.log(`[PROVISION] Local private key found — downloading existing cert (id: ${certificateId})...`);
    ({ deviceCert, rootCa } = await downloadCertificate(certificateId));
    usedKeyPem = null; // don't overwrite the existing key file
  }

  writeCertFiles(crtDir, { deviceCert, rootCa, keyPem: usedKeyPem });
  console.log(`[PROVISION] Certs written to ${crtDir}`);

  // Always read the key back from disk — on the 409 download path, usedKeyPem is null
  // and the old key file on disk is the one that matches the downloaded cert.
  const activeKeyPem = fs.readFileSync(keyPath, 'utf8');

  const canonicalId = stripCnPrefix(cn) || String(deviceId).trim();
  return { deviceId: canonicalId, ca: rootCa, cert: deviceCert, key: activeKeyPem };
}

module.exports = { provisionDevice, generateKeyAndCsr, submitCsr, buildSubjectCn, downloadCertificate };