const crypto = require('crypto');
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { env, nonEmpty } = require('./config');
const { readFirstCertificatePemFromFile } = require('./device_keys_from_header');
const { extractResponseRoot } = require('./renewal');

class OtaHandler {
  constructor(config, mqttClient, deviceId, certificateStore = null) {
    this.config = config;
    this.mqttClient = mqttClient;
    this.deviceId = deviceId;
    this.certificateStore = certificateStore;
    this.topicPrefix = `${config.topicRoot}/${deviceId}`;
    this.isActive = false;
    this.pendingManifest = null;
    this.inflightVersion = null;
    this.pendingVerifyMode = false;
    this.pendingVersion = null;
    this.otaEvents = null;
    this.otaTask = null;
  }

  async init() {
    this.otaEvents = new Map();
    this.isActive = true;
    console.log('[OTA] OTA handler initialized');
  }

  async start() {
    if (!this.isActive) {
      throw new Error('OTA handler not initialized');
    }

    if (this.otaTask) {
      console.warn('[OTA] OTA task already running');
      return;
    }

    this.otaTask = setInterval(() => {
      this.processPendingUpdates();
    }, 5000);
    console.log('[OTA] OTA handler started');
  }

  async stop() {
    if (this.otaTask) {
      clearInterval(this.otaTask);
      this.otaTask = null;
    }
    this.isActive = false;
    console.log('[OTA] OTA handler stopped');
  }

  async onMqttCmd(topic, payload) {
    if (!payload) return;

    console.log(`[OTA] MQTT cmd on ${topic}: ${payload}`);

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      console.warn('[OTA] Failed to parse OTA cmd JSON');
      return;
    }

    const cmd = parsed.cmd || parsed.type;
    if (!cmd) {
      console.warn('[OTA] OTA cmd missing "cmd" field');
      return;
    }

    const force = parsed.force === true;
    console.log(`[OTA] OTA command: ${cmd}`);

    if (cmd === 'ota_check') {
      console.log('[OTA] Ignoring deprecated ota_check — server pushes ota_update');
    } else if (cmd === 'ota_update') {
      console.log('[OTA 1/10] MQTT cmd received on ota_update');
      const manifest = this.parseManifestFromJson(parsed);
      if (manifest) {
        this.queueOtaUpdate(manifest, force);
      } else {
        console.error('[OTA] ota_update missing manifest fields — ignoring cmd');
      }
    } else {
      console.log(`[OTA] Ignoring non-OTA cmd: ${cmd}`);
    }
  }

  async onMqttAck(topic, payload) {
    if (!payload) return;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      return;
    }

    const cmd = parsed.cmd;
    if (cmd === 'ota_rollback_received') {
      console.log('[OTA] Rollback ack received');
      if (this.otaEvents.has('rollback_ack')) {
        this.otaEvents.get('rollback_ack').resolve();
      }
    }
  }

  async onMqttConnected() {
    if (this.pendingVerifyMode) {
      console.log('[OTA] Connected with pending verify mode');
      await this.notifyValidating(this.pendingVersion);
    }
  }

  parseManifestFromJson(root) {
    if (!root) {
      return null;
    }

    const manifest = {
      version: root.version || '',
      download_url:
        root.download_url ||
        root.oci_download_url ||
        root.oci_url ||
        root.par_url ||
        '',
      sha256: root.sha256 || '',
      signature: root.signature || '',
      size_bytes: root.size_bytes || 0,
    };

    if (!manifest.version || !manifest.sha256 || !manifest.signature) {
      console.error('[OTA] Missing required manifest fields');
      return null;
    }

    return manifest;
  }

  isOciDownloadUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase();
      return (
        host.includes('objectstorage') ||
        host.includes('oci.customer-oci.com') ||
        host.endsWith('.oraclecloud.com')
      );
    } catch {
      return false;
    }
  }

  isLocalLanDownloadUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:') return false;
      if (parsed.port === '8765') return true;
      return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  isProxyDownloadUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      return /\/api\/v1\/ota\/download\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  requiresMtlsDownload(url) {
    if (!url || this.isOciDownloadUrl(url) || this.isLocalLanDownloadUrl(url)) {
      return false;
    }

    const base = this.resolveOtaApiBase();
    if (!base) {
      return this.isProxyDownloadUrl(url);
    }

    try {
      return new URL(url).origin === new URL(base).origin;
    } catch {
      return this.isProxyDownloadUrl(url);
    }
  }

  resolveOtaApiBase() {
    const explicit = env('OTA_API_BASE', env('BACKEND_URL', env('PROVISIONING_SERVER_URL', '')));
    if (nonEmpty(explicit)) {
      return String(explicit).trim().replace(/\/+$/, '');
    }
    return '';
  }

  loadDeviceTlsMaterial() {
    if (this.certificateStore) {
      const keys = this.certificateStore.loadDeviceKeys();
      if (!keys?.cert || !keys?.key) {
        throw new Error('Device mTLS cert/key missing — cannot fetch OTA offer from server');
      }
      return {
        cert: keys.cert,
        key: keys.key,
        deviceCa: keys.ca || this.certificateStore.readLegacyCaPem() || '',
      };
    }

    const crtDir = this.config.crtDir || this.config.certPath;
    const certPath = path.join(crtDir, 'primary', 'client.crt');
    const keyPath = path.join(crtDir, 'primary', 'client.key');
    const caCandidates = [
      'ca_root.pem',
      'ca.crt',
      'root-ca.crt',
      'broker-ca.crt',
      'root_certifacite.txt',
    ];
    let deviceCa = '';
    for (const name of caCandidates) {
      const candidate = path.join(crtDir, name);
      if (!fs.existsSync(candidate)) continue;
      if (name === 'root_certifacite.txt') {
        deviceCa = readFirstCertificatePemFromFile(candidate) || '';
      } else {
        deviceCa = fs.readFileSync(candidate, 'utf8');
      }
      if (deviceCa) break;
    }
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      throw new Error('Device mTLS cert/key missing — cannot fetch OTA offer from server');
    }
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8'),
      deviceCa,
    };
  }

  buildApiTlsOptions(parsedUrl, tlsMaterial) {
    return {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'GET',
      cert: tlsMaterial.cert,
      key: tlsMaterial.key,
      ca: tls.rootCertificates,
      rejectUnauthorized: true,
      servername: parsedUrl.hostname,
      minVersion: 'TLSv1.2',
    };
  }

  parseOfferDownloadUrl(responseJson) {
    const root = extractResponseRoot(responseJson);
    return root.download_url || root.oci_download_url || root.oci_url || root.par_url || '';
  }

  mtlsUnavailableMessage(statusCode, body) {
    if (statusCode !== 401 || !/MTLS_REQUIRED/i.test(body)) {
      return '';
    }
    return (
      ' — server requires device mTLS but the HTTP edge cannot forward client certificates; ' +
      'push an OCI presigned URL in download_url or expose OTA_API_BASE on an mTLS-capable endpoint'
    );
  }

  async fetchOciDownloadUrlFromServer(version) {
    const base = this.resolveOtaApiBase();
    if (!base) {
      throw new Error('Set OTA_API_BASE or BACKEND_URL to resolve OCI download URL from proofmqtt server');
    }

    const url = `${base}/api/v1/ota/offer/${encodeURIComponent(version)}`;
    const tlsMaterial = this.loadDeviceTlsMaterial();

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(this.buildApiTlsOptions(parsed, tlsMaterial), (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OTA offer HTTP ${res.statusCode}: ${body.slice(0, 200)}${this.mtlsUnavailableMessage(res.statusCode, body)}`,
              ),
            );
            return;
          }
          try {
            const json = JSON.parse(body);
            const downloadUrl = this.parseOfferDownloadUrl(json);
            if (!downloadUrl || !this.isOciDownloadUrl(downloadUrl)) {
              reject(new Error('Server OTA offer did not return an OCI download_url'));
              return;
            }
            resolve(downloadUrl);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async resolveDownloadUrl(manifest) {
    if (this.isOciDownloadUrl(manifest.download_url)) {
      return manifest.download_url;
    }

    if (this.isLocalLanDownloadUrl(manifest.download_url)) {
      throw new Error(
        `Stale LAN OTA manifest (${manifest.download_url}) — clear retained cmd and push a fresh update from server`
      );
    }

    if (this.isProxyDownloadUrl(manifest.download_url)) {
      console.log(
        `[OTA] MQTT download_url is a server proxy — resolving OCI presigned URL for version ${manifest.version}`,
      );
    } else if (manifest.download_url) {
      console.warn(
        `[OTA] Unrecognized download_url in MQTT payload — fetching fresh OCI offer from server`,
      );
    }

    const ociUrl = await this.fetchOciDownloadUrlFromServer(manifest.version);
    console.log(`[OTA] Resolved OCI download_url from server for version ${manifest.version}`);
    return ociUrl;
  }

  async queueOtaUpdate(manifest, force) {
    if (!this.otaEvents) {
      console.warn('[OTA] OTA update ignored — handler not ready');
      return;
    }

    if (this.pendingVerifyMode) {
      console.warn('[OTA] OTA update ignored — pending verify active');
      return;
    }

    if (this.isLocalLanDownloadUrl(manifest.download_url)) {
      console.warn(
        `[OTA] Ignoring stale LAN/dev ota_update (${manifest.download_url}) — not queuing`
      );
      this.clearRetainedCmd();
      return;
    }

    if (!force && this.isVersionAlreadyRunning(manifest.version)) {
      console.log(`[OTA] Already running version ${manifest.version} — clearing stale cmd`);
      this.clearRetainedCmd();
      return;
    }

    if (this.inflightVersion && this.inflightVersion === manifest.version) {
      console.log(`[OTA] OTA update for ${manifest.version} already in progress`);
      return;
    }

    this.inflightVersion = manifest.version;
    this.pendingManifest = manifest;
    console.log(`[OTA 2/10] Queued ota_update version=${manifest.version} force=${force}`);
  }

  isVersionAlreadyRunning(version) {
    if (!version || version === '') {
      return false;
    }

    const currentVersion = env('APP_VERSION', '1.0.0');
    return currentVersion === version;
  }

  async processPendingUpdates() {
    if (!this.pendingManifest || this.pendingVerifyMode) {
      return;
    }

    const manifest = this.pendingManifest;
    this.pendingManifest = null;
    this.inflightVersion = null;

    console.log(`[OTA] Starting OTA download for version ${manifest.version}`);
    await this.notifyProgress(manifest.version, 0);

    try {
      const result = await this.applyUpdate(manifest);
      if (result === 'success') {
        console.log(`[OTA 10/10] OTA validation complete for version ${manifest.version}`);
        await this.notifySuccess(manifest.version);
      } else if (result === 'failed') {
        console.error(`[OTA] OTA validation failed for version ${manifest.version}`);
        await this.notifyFailure(manifest.version, 'validation_failed');
      }
    } catch (error) {
      console.error(`[OTA] OTA update failed: ${error.message}`);
      this.inflightVersion = null;
      await this.notifyFailure(manifest.version, error.message);
    }
  }

  async applyUpdate(manifest) {
    console.log(`[OTA 3/10] Target partition info: size=${manifest.size_bytes || 'unknown'}`);

    let downloadUrl = await this.resolveDownloadUrl(manifest);
    console.log(`[OTA 4/10] HTTP GET ${downloadUrl}`);

    let downloadResult;
    try {
      downloadResult = await this.downloadFirmware(downloadUrl, manifest.size_bytes);
    } catch (error) {
      const canRetryWithOci =
        !this.isOciDownloadUrl(downloadUrl) &&
        /HTTP 401|MTLS_REQUIRED/i.test(error.message || '');
      if (!canRetryWithOci) {
        throw error;
      }

      console.warn(
        `[OTA] Download via API failed (${error.message}) — fetching OCI presigned URL from server`,
      );
      downloadUrl = await this.fetchOciDownloadUrlFromServer(manifest.version);
      console.log(`[OTA 4/10] HTTP GET ${downloadUrl}`);
      downloadResult = await this.downloadFirmware(downloadUrl, manifest.size_bytes);
    }

    if (!downloadResult) {
      throw new Error('Failed to download firmware');
    }

    const { filePath, sha256, size } = downloadResult;

    if (manifest.size_bytes > 0 && size !== manifest.size_bytes) {
      throw new Error(`Size mismatch: got ${size}, expected ${manifest.size_bytes}`);
    }

    console.log(`[OTA 5/10] SHA-256: ${sha256}`);

    if (manifest.sha256 && manifest.sha256 !== sha256) {
      throw new Error(`SHA-256 mismatch: got ${sha256}, expected ${manifest.sha256}`);
    }

    console.log(`[OTA 6/10] SHA-256 match OK`);

    if (manifest.signature) {
      const signatureValid = await this.verifySignature(manifest.sha256, manifest.signature);
      if (!signatureValid) {
        throw new Error('Signature verification failed');
      }
      console.log(`[OTA 7/10] Signature verification OK`);
    }

    console.log(`[OTA 8/10] Firmware validation complete, notifying server...`);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return 'success';
  }

  streamFirmwareResponse(response, file, sha256, expectedSize, tempFile, resolve, reject) {
    let totalWritten = 0;
    let lastLoggedPct = 0;

    const statusCode = response.statusCode;
    if (statusCode !== 200) {
      reject(new Error(`HTTP ${statusCode}`));
      return;
    }

    response.on('data', (chunk) => {
      sha256.update(chunk);
      file.write(chunk);
      totalWritten += chunk.length;

      if (expectedSize > 0) {
        const pct = Math.floor((totalWritten * 100) / expectedSize);
        if (pct >= 100) {
          console.log(`[OTA 6/10] Downloaded ${totalWritten} / ${expectedSize} bytes (100%)`);
        } else {
          const milestone = Math.floor((pct / 25) * 25);
          if (milestone > 0 && milestone > lastLoggedPct) {
            lastLoggedPct = milestone;
            console.log(`[OTA 6/10] Downloaded ${totalWritten} / ${expectedSize} bytes (${milestone}%)`);
          }
        }
      }
    });

    response.on('end', () => {
      file.end();
      resolve({
        filePath: tempFile,
        sha256: sha256.digest('hex'),
        size: totalWritten,
      });
    });

    response.on('error', (err) => {
      file.close();
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      reject(err);
    });
  }

  async downloadFirmware(url, expectedSize) {
    return new Promise((resolve, reject) => {
      const tempFile = path.join(require('os').tmpdir(), `ota_${Date.now()}.bin`);
      const file = fs.createWriteStream(tempFile);
      const sha256 = crypto.createHash('sha256');

      console.log(`[OTA 6/10] Downloading ${url} to ${tempFile}`);

      const parsedUrl = new URL(url);
      const onError = (err) => {
        file.close();
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        reject(err);
      };

      if (this.requiresMtlsDownload(url)) {
        const tlsMaterial = this.loadDeviceTlsMaterial();
        const req = https.request(this.buildApiTlsOptions(parsedUrl, tlsMaterial), (response) => {
          this.streamFirmwareResponse(
            response,
            file,
            sha256,
            expectedSize,
            tempFile,
            resolve,
            reject
          );
        });
        req.on('error', onError);
        req.end();
        return;
      }

      const client = parsedUrl.protocol === 'https:' ? https : http;
      const request = client.get(url, (response) => {
        this.streamFirmwareResponse(
          response,
          file,
          sha256,
          expectedSize,
          tempFile,
          resolve,
          reject
        );
      });
      request.on('error', onError);
    });
  }

  async verifySignature(dataHash, signature) {
    try {
      const signingKeyPath = path.join(this.config.crtDir, 'signing_key.pem');
      if (!fs.existsSync(signingKeyPath)) {
        console.warn('[OTA] Signing key not found, skipping signature verification');
        return true;
      }

      const publicKey = fs.readFileSync(signingKeyPath, 'utf8');
      const verifier = crypto.createVerify('sha256');
      verifier.update(dataHash, 'hex');
      return verifier.verify(publicKey, signature, 'base64');
    } catch (err) {
      console.error(`[OTA] Signature verification error: ${err.message}`);
      return false;
    }
  }

  async notifyProgress(version, percent) {
    const obj = {
      type: 'ota_progress',
      version: version,
      percent: percent,
    };
    await this.publishStatus(obj);
  }

  async notifySuccess(version) {
    const obj = {
      type: 'ota_success',
      version: version,
    };
    await this.publishStatus(obj);
  }

  async notifyFailure(version, reason) {
    const obj = {
      type: 'ota_failure',
      version: version,
      reason: reason,
    };
    await this.publishStatus(obj);
  }

  async notifyValidating(version) {
    const obj = {
      type: 'ota_validating',
      version: version,
    };
    await this.publishStatus(obj);
  }

  async publishStatus(obj) {
    const statusTopic = env('STATUS_TOPIC', `${this.topicPrefix}/status`);
    const json = JSON.stringify(obj);

    return new Promise((resolve, reject) => {
      this.mqttClient.publish(statusTopic, json, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`[OTA] Failed to publish status to ${statusTopic}: ${err.message}`);
          reject(err);
        } else {
          console.log(`[OTA] Status published to ${statusTopic}: ${JSON.stringify(obj)}`);
          resolve();
        }
      });
    });
  }

  clearRetainedCmd() {
    const cmdTopic = env('CMD_TOPIC', `${this.topicPrefix}/cmd`);
    this.mqttClient.publish(cmdTopic, '', { qos: 1, retain: true }, (err) => {
      if (err) {
        console.error(`[OTA] Failed to clear retained cmd: ${err.message}`);
      }
    });
  }

  async runPendingVerify() {
    if (!this.pendingVerifyMode) {
      return 'success';
    }

    console.log('[OTA] Waiting for WiFi + MQTT before OTA validation...');
    for (let i = 0; i < 120; i++) {
      if (this.mqttClient && this.mqttClient.connected) {
        await this.notifyValidating(this.pendingVersion);
        return 'success';
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.error('[OTA] OTA pending verify timeout');
    await this.notifyFailure(this.pendingVersion, 'pending_verify_failed');
    return 'failed';
  }

  async notifyWifiMqttReady() {
    if (!this.pendingVerifyMode) {
      return;
    }

    this.pendingVerifyMode = false;
    this.clearRetainedCmd();

    const obj = {
      type: 'ota_success',
      version: this.pendingVersion,
    };
    await this.publishStatus(obj);
    console.log(`[OTA 10/10] Pending verify succeeded for version ${this.pendingVersion}`);
  }

  pendingVerifyActive() {
    return this.pendingVerifyMode;
  }
}

module.exports = { OtaHandler };