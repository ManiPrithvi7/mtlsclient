const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Reverse of server CAService.formatExpectedCN() normalization: CERT_CN_PREFIX + separator
 * stripped so topic/deviceId matches Mongo (e.g. PROOF-ADMIN-1 → ADMIN-1).
 */
function stripCnPrefix(cn) {
  if (!cn || typeof cn !== 'string') return cn;
  const rawPrefix = process.env.CERT_CN_PREFIX || 'PROOF';
  const prefix = rawPrefix.trim().replace(/[-_]+$/g, '');
  if (!prefix) return cn;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cn.replace(new RegExp(`^${escaped}[-_]`), '');
}

function commonNameFromCertPem(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const m = String(x509.subject).match(/CN\s*=\s*([^,\r\n]+)/i);
    const rawCn = m ? m[1].trim() : null;
    return rawCn ? stripCnPrefix(rawCn) : null;
  } catch {
    return null;
  }
}

function extractFirstPemBlock(text, beginLine) {
  const beginIdx = text.indexOf(beginLine);
  if (beginIdx === -1) return null;
  const endLine = beginLine.replace('BEGIN ', 'END ');
  const endIdx = text.indexOf(endLine, beginIdx);
  if (endIdx === -1) return null;
  const afterEnd = text.indexOf('\n', endIdx);
  const sliceEnd = afterEnd === -1 ? text.length : afterEnd + 1;
  return text.slice(beginIdx, sliceEnd);
}

function unescapeCStringFragment(s) {
  // Handle common C escapes found in PEM macro definitions
  return s
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
}

function extractDefineString(headerText, defineName) {
  // Single-line form: #define NAME "value"
  const single = new RegExp(String.raw`^\s*#define\s+${defineName}\s+"([^"]*)"\s*$`, 'm');
  const singleMatch = headerText.match(single);
  if (singleMatch) return singleMatch[1];

  // Multi-line form:
  // #define NAME \
  //   "..." \
  //   "..."
  const start = new RegExp(String.raw`^\s*#define\s+${defineName}\b[^\n]*\\\s*$`, 'm');
  const startMatch = headerText.match(start);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const rest = headerText.slice(startIdx);

  const lines = rest.split('\n');
  const fragments = [];
  for (const line of lines) {
    if (/^\s*#define\b/.test(line) || /^\s*#endif\b/.test(line)) break;
    const m = line.match(/"([^"]*)"/g);
    if (!m) continue;
    for (const quoted of m) {
      fragments.push(quoted.slice(1, -1));
    }
    // If line doesn't end with "\" the macro likely ended
    if (!/\\\s*$/.test(line)) break;
  }
  return fragments.map(unescapeCStringFragment).join('');
}

function loadDeviceKeysFromHeader(headerPath) {
  const headerText = fs.readFileSync(headerPath, 'utf8');

  const deviceId = extractDefineString(headerText, 'DEVICE_ID');
  const ca = extractDefineString(headerText, 'ROOT_CA_CERT_PEM');
  const cert = extractDefineString(headerText, 'DEVICE_CERT_PEM');
  const key = extractDefineString(headerText, 'DEVICE_PRIVATE_KEY_PEM');

  if (!deviceId) throw new Error('DEVICE_ID not found in header');
  if (!ca) throw new Error('ROOT_CA_CERT_PEM not found in header');
  if (!cert) throw new Error('DEVICE_CERT_PEM not found in header');
  if (!key) throw new Error('DEVICE_PRIVATE_KEY_PEM not found in header');

  return { deviceId, ca, cert, key };
}

function extractCertPemFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return (
    extractFirstPemBlock(text, '-----BEGIN CERTIFICATE-----\n') ||
    extractFirstPemBlock(text, '-----BEGIN CERTIFICATE-----')
  );
}

function extractKeyPemFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return (
    extractFirstPemBlock(text, '-----BEGIN RSA PRIVATE KEY-----\n') ||
    extractFirstPemBlock(text, '-----BEGIN PRIVATE KEY-----\n') ||
    extractFirstPemBlock(text, '-----BEGIN RSA PRIVATE KEY-----') ||
    extractFirstPemBlock(text, '-----BEGIN PRIVATE KEY-----')
  );
}

/**
 * PEM layout for src/certs/: client.crt, client.key; optional ca.crt or root-ca.crt (device issuing CA, for USE_CUSTOM_CA).
 * Legacy layout: root_certifacite.txt, device certificate CA signed.txt, privatekey_protect.txt
 */
function loadDeviceKeysFromCrtFolder(crtDir) {
  const clientCrtPath = path.join(crtDir, 'client.crt');
  const clientKeyPath = path.join(crtDir, 'client.key');
  const useStandardPemNames = fs.existsSync(clientCrtPath) && fs.existsSync(clientKeyPath);

  if (useStandardPemNames) {
    const cert = extractCertPemFromFile(clientCrtPath);
    const key = extractKeyPemFromFile(clientKeyPath);
    if (!cert) throw new Error(`No certificate PEM in ${clientCrtPath}`);
    if (!key) throw new Error(`No private key PEM in ${clientKeyPath}`);

    let ca = '';
    for (const name of ['ca.crt', 'root-ca.crt']) {
      const p = path.join(crtDir, name);
      if (fs.existsSync(p)) {
        ca = extractCertPemFromFile(p) || '';
        if (ca) break;
      }
    }
    if (!ca) {
      const legacyRoot = path.join(crtDir, 'root_certifacite.txt');
      if (fs.existsSync(legacyRoot)) {
        const rootTxt = fs.readFileSync(legacyRoot, 'utf8');
        ca =
          extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----\n') ||
          extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----') ||
          '';
      }
    }

    const cn = commonNameFromCertPem(cert);
    const deviceId = process.env.DEVICE_ID_OVERRIDE || cn || 'ADMIN-1';
    return { deviceId, ca, cert, key };
  }

  const rootPath = path.join(crtDir, 'root_certifacite.txt');
  const certPath = path.join(crtDir, 'device certificate CA signed.txt');
  const keyPath = path.join(crtDir, 'privatekey_protect.txt');

  const rootTxt = fs.readFileSync(rootPath, 'utf8');
  const certTxt = fs.readFileSync(certPath, 'utf8');
  const keyTxt = fs.readFileSync(keyPath, 'utf8');

  const ca =
    extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----\n') ||
    extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----');
  const cert =
    extractFirstPemBlock(certTxt, '-----BEGIN CERTIFICATE-----\n') ||
    extractFirstPemBlock(certTxt, '-----BEGIN CERTIFICATE-----');
  const key =
    extractFirstPemBlock(keyTxt, '-----BEGIN RSA PRIVATE KEY-----\n') ||
    extractFirstPemBlock(keyTxt, '-----BEGIN PRIVATE KEY-----\n') ||
    extractFirstPemBlock(keyTxt, '-----BEGIN RSA PRIVATE KEY-----') ||
    extractFirstPemBlock(keyTxt, '-----BEGIN PRIVATE KEY-----');

  if (!ca) throw new Error(`No CA PEM block found in ${rootPath}`);
  if (!cert) throw new Error(`No cert PEM block found in ${certPath}`);
  if (!key) throw new Error(`No private key PEM block found in ${keyPath}`);

  const cn = commonNameFromCertPem(cert);
  const deviceId = process.env.DEVICE_ID_OVERRIDE || cn || 'ADMIN-1';
  return { deviceId, ca, cert, key };
}

/** First PEM certificate block from a file (e.g. provisioning root in root_certifacite.txt). */
function readFirstCertificatePemFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return (
    extractFirstPemBlock(text, '-----BEGIN CERTIFICATE-----\n') ||
    extractFirstPemBlock(text, '-----BEGIN CERTIFICATE-----')
  );
}

module.exports = {
  loadDeviceKeysFromHeader,
  loadDeviceKeysFromCrtFolder,
  stripCnPrefix,
  commonNameFromCertPem,
  readFirstCertificatePemFromFile,
};

