'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Provisioning-standard cert persistence. This is extracted to be reusable by the
 * recovery portal commit step without changing provisioning.js exports.
 */
function writeCertFiles(crtDir, { deviceCert, rootCa, keyPem }) {
  fs.mkdirSync(crtDir, { recursive: true });

  const keyPath = path.join(crtDir, 'privatekey_protect.txt');
  const certPath = path.join(crtDir, 'device certificate CA signed.txt');
  const rootPath = path.join(crtDir, 'root_certifacite.txt');

  if (keyPem) {
    fs.writeFileSync(keyPath, `===== STORED PRIVATE KEY =====\n${keyPem}\n===== END KEY =====\n`, 'utf8');
  } else if (!fs.existsSync(keyPath)) {
    throw new Error(
      'Private key is not available: the server cannot return the private key after initial provisioning. ' +
        'Delete the device certificate server-side and re-provision to generate a fresh key pair.',
    );
  }

  fs.writeFileSync(
    certPath,
    `===== DEVICE CERTIFICATE (CA-SIGNED) =====\n${deviceCert}\n===== END DEVICE CERTIFICATE =====\n`,
    'utf8',
  );

  fs.writeFileSync(rootPath, `===== ROOT CA =====\n${rootCa}\n===== END ROOT CA =====\n`, 'utf8');
}

module.exports = { writeCertFiles };

