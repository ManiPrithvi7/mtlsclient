const fs = require('node:fs');
const crypto = require('node:crypto');

function commonNameFromCertPem(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const m = String(x509.subject).match(/CN\s*=\s*([^,+]+)/i);
    return m ? m[1].trim() : null;
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

function loadDeviceKeysFromCrtFolder(crtDir) {
  const rootPath = `${crtDir}/root_certifacite.txt`;
  const certPath = `${crtDir}/device certificate CA signed.txt`;
  const keyPath = `${crtDir}/privatekey_protect.txt`;

  const rootTxt = fs.readFileSync(rootPath, 'utf8');
  const certTxt = fs.readFileSync(certPath, 'utf8');
  const keyTxt = fs.readFileSync(keyPath, 'utf8');

  const ca = extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----\n') || extractFirstPemBlock(rootTxt, '-----BEGIN CERTIFICATE-----');
  const cert = extractFirstPemBlock(certTxt, '-----BEGIN CERTIFICATE-----\n') || extractFirstPemBlock(certTxt, '-----BEGIN CERTIFICATE-----');
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

module.exports = {
  loadDeviceKeysFromHeader,
  loadDeviceKeysFromCrtFolder,
};

