const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const forge = require('node-forge');

const {
  loadDeviceKeysFromHeader,
  loadDeviceKeysFromCrtFolder,
  commonNameFromCertPem,
  readFirstCertificatePemFromFile,
} = require('./device_keys_from_header');

class CertificateStore {
  constructor(config) {
    this.config = config;
    this.paths = {
      primary: {
        cert: path.join(this.config.crtDir, 'primary', 'client.crt'),
        key: path.join(this.config.crtDir, 'primary', 'client.key'),
      },
      staging: {
        cert: path.join(this.config.crtDir, 'staging', 'client.crt'),
        key: path.join(this.config.crtDir, 'staging', 'client.key'),
      },
      legacy: {
        cert: path.join(this.config.crtDir, 'device certificate CA signed.txt'),
        key: path.join(this.config.crtDir, 'privatekey_protect.txt'),
        ca: path.join(this.config.crtDir, 'root_certifacite.txt'),
      },
      integrity: path.join(this.config.crtDir, '.integrity.sig'),
      metadata: path.join(this.config.crtDir, '.metadata.json'),
    };
    this.migrated = false;
  }

  async initialize() {
    await fsp.mkdir(path.dirname(this.paths.primary.cert), { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.staging.cert), { recursive: true });
    await this.migrateFromLegacyIfNeeded();
  }

  hasDeviceCertBundle() {
    const clientCrt = path.join(this.config.crtDir, 'client.crt');
    const clientKey = path.join(this.config.crtDir, 'client.key');
    if (fs.existsSync(this.paths.legacy.cert)) return true;
    if (fs.existsSync(this.paths.primary.cert) && fs.existsSync(this.paths.primary.key)) return true;
    return fs.existsSync(clientCrt) && fs.existsSync(clientKey);
  }

  needsProvisioning() {
    return this.config.useCrtDir && !this.hasDeviceCertBundle();
  }

  async migrateFromLegacyIfNeeded() {
    try {
      const metadata = JSON.parse(await fsp.readFile(this.paths.metadata, 'utf8'));
      if (metadata.migrated) {
        // Metadata can become stale after a factory reset that clears slot files but leaves metadata.
        // Only trust it if primary still exists.
        if (await this.hasPrimary()) {
          this.migrated = true;
          return;
        }
      }
    } catch {
      // metadata absent or invalid, continue
    }

    if (await this.hasPrimary()) {
      this.migrated = true;
      return;
    }

    try {
      const legacy = loadDeviceKeysFromCrtFolder(this.config.crtDir);
      if (legacy?.cert && legacy?.key) {
        console.log('[CERT-STORE] Migrating legacy certificates to slot storage...');
        await this.savePrimary(legacy.cert, legacy.key);
        await fsp.writeFile(
          this.paths.metadata,
          JSON.stringify(
            {
              migrated: true,
              migratedAt: new Date().toISOString(),
              legacyPath: this.paths.legacy.cert,
            },
            null,
            2,
          ),
        );
        this.migrated = true;
        console.log('[CERT-STORE] Migration complete. Legacy files preserved.');
      }
    } catch {
      // no legacy material available yet
    }
  }

  loadDeviceKeys() {
    if (this.config.useCrtDir) {
      if (fs.existsSync(this.paths.primary.cert) && fs.existsSync(this.paths.primary.key)) {
        const cert = fs.readFileSync(this.paths.primary.cert, 'utf8');
        const key = fs.readFileSync(this.paths.primary.key, 'utf8');
        let ca = '';
        const legacyCaPem = this.readLegacyCaPem();
        if (legacyCaPem) ca = legacyCaPem;
        const deviceId = process.env.DEVICE_ID_OVERRIDE || commonNameFromCertPem(cert) || 'ADMIN-1';
        return { deviceId, ca, cert, key };
      }
      return loadDeviceKeysFromCrtFolder(this.config.crtDir);
    }
    return loadDeviceKeysFromHeader(this.config.headerPath);
  }

  readLegacyCaPem() {
    if (!fs.existsSync(this.paths.legacy.ca)) return '';
    try {
      return readFirstCertificatePemFromFile(this.paths.legacy.ca) || '';
    } catch {
      return '';
    }
  }

  async hasPrimary() {
    try {
      await fsp.access(this.paths.primary.cert);
      await fsp.access(this.paths.primary.key);
      return true;
    } catch {
      return false;
    }
  }

  async hasStaging() {
    try {
      await fsp.access(this.paths.staging.cert);
      await fsp.access(this.paths.staging.key);
      return true;
    } catch {
      return false;
    }
  }

  async loadPrimary() {
    if (await this.hasPrimary()) {
      const [cert, key] = await Promise.all([
        fsp.readFile(this.paths.primary.cert, 'utf8'),
        fsp.readFile(this.paths.primary.key, 'utf8'),
      ]);
      return { cert, key };
    }

    const legacy = loadDeviceKeysFromCrtFolder(this.config.crtDir);
    return { cert: legacy.cert, key: legacy.key };
  }

  async loadStaging() {
    const [cert, key] = await Promise.all([
      fsp.readFile(this.paths.staging.cert, 'utf8'),
      fsp.readFile(this.paths.staging.key, 'utf8'),
    ]);
    return { cert, key };
  }

  async savePrimary(cert, key) {
    await Promise.all([
      fsp.writeFile(this.paths.primary.cert, cert, 'utf8'),
      fsp.writeFile(this.paths.primary.key, key, 'utf8'),
    ]);
    await this.updateIntegritySignature(key);
  }

  async saveStaging(cert, key) {
    const writes = [fsp.writeFile(this.paths.staging.key, key, 'utf8')];
    if (cert) writes.push(fsp.writeFile(this.paths.staging.cert, cert, 'utf8'));
    await Promise.all(writes);
  }

  async promoteStagingToPrimary() {
    const staging = await this.loadStaging();
    await this.savePrimary(staging.cert, staging.key);
    await this.clearStaging();
    console.log('[CERT-STORE] Promoted staging to primary');
  }

  async clearStaging() {
    await Promise.allSettled([
      fsp.unlink(this.paths.staging.cert),
      fsp.unlink(this.paths.staging.key),
    ]);
  }

  async clearAll() {
    await Promise.allSettled([
      fsp.unlink(this.paths.primary.cert),
      fsp.unlink(this.paths.primary.key),
      fsp.unlink(this.paths.integrity),
      fsp.unlink(this.paths.metadata),
    ]);
    await this.clearStaging();
    console.log('[CERT-STORE] All certificates cleared (factory reset)');
  }

  async updateIntegritySignature(privateKeyPem) {
    const signature = crypto
      .createHmac('sha256', privateKeyPem)
      .update('PROOF_INTEGRITY_CHECK')
      .digest('hex');
    await fsp.writeFile(this.paths.integrity, signature, 'utf8');
  }

  async verifyIntegrity() {
    try {
      const { key } = await this.loadPrimary();
      const storedSig = await fsp.readFile(this.paths.integrity, 'utf8');
      const computedSig = crypto
        .createHmac('sha256', key)
        .update('PROOF_INTEGRITY_CHECK')
        .digest('hex');
      return storedSig === computedSig;
    } catch {
      return false;
    }
  }

  async getCertificateInfo() {
    try {
      const { cert } = await this.loadPrimary();
      const parsed = forge.pki.certificateFromPem(cert);
      const notAfter = parsed.validity.notAfter;
      return {
        deviceId: this.extractCN(parsed),
        expiresAt: notAfter,
        daysRemaining: this.getDaysRemaining(notAfter),
        isValid: new Date() < notAfter,
      };
    } catch {
      return null;
    }
  }

  extractCN(cert) {
    const cnAttr = cert.subject.attributes.find((attr) => attr.name === 'commonName');
    return cnAttr ? cnAttr.value : 'unknown';
  }

  getDaysRemaining(expiryDate) {
    const diff = new Date(expiryDate) - new Date();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  async getDeviceId() {
    const info = await this.getCertificateInfo();
    return info?.deviceId || null;
  }

  loadBrokerCaPem() {
    const raw = process.env.MQTT_BROKER_CA;
    const host = this.config.urlHost;

    if (raw !== undefined && String(raw).trim() === '') {
      return { pem: null, resolvedPath: null };
    }

    if (raw !== undefined && String(raw).trim() !== '') {
      const relOrAbs = String(raw).trim();
      const resolvedPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(this.config.repoRoot, relOrAbs);
      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[MQTT] broker CA file missing: ${resolvedPath}`);
        return { pem: null, resolvedPath };
      }
      return { pem: fs.readFileSync(resolvedPath, 'utf8'), resolvedPath };
    }

    const bundledBrokerCa = path.join(this.config.crtDir, 'broker-ca.crt');
    if (fs.existsSync(bundledBrokerCa)) {
      return { pem: fs.readFileSync(bundledBrokerCa, 'utf8'), resolvedPath: bundledBrokerCa };
    }

    const provisionedRootPath = path.join(this.config.crtDir, 'root_certifacite.txt');
    if (fs.existsSync(provisionedRootPath)) {
      try {
        const pem = readFirstCertificatePemFromFile(provisionedRootPath);
        if (pem) {
          return { pem, resolvedPath: provisionedRootPath };
        }
      } catch (error) {
        console.warn(`[MQTT] could not read provisioning root CA from ${provisionedRootPath}: ${error.message}`);
      }
    }

    const defaultFlyCa = !/\.emqxcloud\.com$/i.test(host);
    if (!defaultFlyCa) return { pem: null, resolvedPath: null };

    const resolvedPath = path.resolve(this.config.repoRoot, 'deploy', 'fly', 'broker-ca.crt');
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`[MQTT] broker CA file missing (copy broker-ca.crt here): ${resolvedPath}`);
      return { pem: null, resolvedPath };
    }

    return { pem: fs.readFileSync(resolvedPath, 'utf8'), resolvedPath };
  }
}

module.exports = { CertificateStore };
