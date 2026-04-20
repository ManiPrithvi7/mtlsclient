const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');

const { RenewalFlow } = require('./renewal');
const { ReissueFlow } = require('./reissue');
const { testMqttConnection } = require('./mqttClient');
const { requestJson, extractCertificatePayload } = require('./renewal');
const { writeCertFiles } = require('./provisioning_write');

class WebControlPanel {
  constructor(config, store, stateMachine) {
    this.config = config;
    this.store = store;
    this.stateMachine = stateMachine;
    this.app = express();
    this.port = config.controlPort || 3001;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));

    this.app.get('/', (_req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'control.html'));
    });

    // Recovery portal (not linked from main UI)
    this.app.get('/recovery', (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(this.renderRecoveryPortalHtml(code));
    });

    this.app.get('/api/wifi/scan', async (_req, res) => {
      // PC simulator: return mock scan results (real WiFi scanning is OS-specific).
      res.json([
        { ssid: 'Home WiFi', signal: 85, secured: true },
        { ssid: 'Coffee Shop', signal: 72, secured: true },
        { ssid: 'Office Guest', signal: 45, secured: false },
      ]);
    });

    // Recovery portal submit: server performs backend call + local persistence.
    this.app.post('/api/recovery/restore', this.handleRecoveryPortalRestore.bind(this));

    this.app.post('/api/action/factory-reset', this.handleFactoryReset.bind(this));
    this.app.post('/api/action/wifi-reset', this.handleWifiReset.bind(this));
    this.app.post('/api/action/wifi-test', this.handleWifiTest.bind(this));
    this.app.post('/api/action/wifi-connect', this.handleWifiConnect.bind(this));
    this.app.post('/api/action/renew', this.handleRenew.bind(this));
    this.app.post('/api/action/reissue', this.handleReissue.bind(this));
    this.app.post('/api/action/full-recovery', this.handleFullRecovery.bind(this));
    this.app.post('/api/action/test-mqtt', this.handleTestMqtt.bind(this));
    this.app.get('/api/status', this.handleStatus.bind(this));
    this.app.get('/api/cert-info', this.handleCertInfo.bind(this));
  }

  renderRecoveryPortalHtml(code) {
    const safeCode = String(code || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device Recovery Portal</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; margin-bottom: 16px; }
    .code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 36px; letter-spacing: 6px; text-align: center; padding: 14px; background: #f3f4f6; border-radius: 12px; }
    label { display: block; margin-top: 12px; font-weight: 700; }
    input, select { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #d1d5db; margin-top: 6px; }
    button { width: 100%; margin-top: 16px; padding: 12px; border: 0; border-radius: 10px; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .status { margin-top: 12px; padding: 12px; border-radius: 10px; }
    .ok { background: #dcfce7; color: #166534; }
    .bad { background: #fee2e2; color: #991b1b; }
    .hint { color: #6b7280; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Device Recovery Portal</h1>

  <div class="card">
    <div class="hint">Open this page with <code>?code=RECOVERY_CODE</code> from the dashboard.</div>
    <div class="code" id="codeDisplay">${safeCode || '------'}</div>
  </div>

  <div class="card">
    <label for="ssidSelect">WiFi SSID</label>
    <select id="ssidSelect"><option value="">Scanning...</option></select>

    <label for="wifiPassword">WiFi Password</label>
    <input id="wifiPassword" type="password" placeholder="Enter WiFi password">

    <label for="recoveryCode">Recovery Code</label>
    <input id="recoveryCode" placeholder="e.g. 552109" value="${safeCode}">

    <button id="restoreBtn">Restore Device</button>
    <div id="status" class="status" style="display:none;"></div>
  </div>

  <script>
    const backendUrl = ${JSON.stringify(this.config.backendUrl || '')};

    async function scan() {
      const res = await fetch('/api/wifi/scan');
      const list = await res.json();
      const sel = document.getElementById('ssidSelect');
      sel.innerHTML = '<option value=\"\">Select a network...</option>' + list.map(n => \`<option value=\"\${n.ssid}\">\${n.ssid} (\${n.signal}%)</option>\`).join('');
    }
    scan();

    function setStatus(text, ok) {
      const node = document.getElementById('status');
      node.style.display = 'block';
      node.className = 'status ' + (ok ? 'ok' : 'bad');
      node.textContent = text;
    }

    document.getElementById('restoreBtn').onclick = async () => {
      const ssid = document.getElementById('ssidSelect').value;
      const password = document.getElementById('wifiPassword').value;
      const recoveryCode = document.getElementById('recoveryCode').value.replace(/\s+/g, '');
      const btn = document.getElementById('restoreBtn');
      btn.disabled = true;
      setStatus('Submitting recovery...', true);

      try {
        if (!backendUrl) throw new Error('BACKEND_URL is not configured on the local simulator');
        const res = await fetch('/api/recovery/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password, recoveryCode })
        });
        const text = await res.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { success:false, error: text || 'Non-JSON response' }; }
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        setStatus(payload.message || 'Recovery complete. You can close this tab.', true);
      } catch (e) {
        setStatus(e && e.message ? e.message : String(e), false);
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>`;
  }

  async handleRecoveryPortalRestore(req, res) {
    const { ssid, password, recoveryCode } = req.body || {};
    if (!ssid || !password || !recoveryCode) {
      this.sendJsonError(res, 400, 'ssid, password, and recoveryCode are required', 'VALIDATION_ERROR');
      return;
    }

    try {
      await this.attemptWifiConnection(ssid, password);
      await this.saveWifiCredentials(ssid, password);

      if (!this.config.backendUrl) {
        this.sendJsonError(res, 400, 'BACKEND_URL is not configured', 'BACKEND_URL_MISSING');
        return;
      }

      // Generate local keypair + CSR; keep private key in staging until cert arrives.
      const deviceId = process.env.DEVICE_ID || 'DEVICE';
      const { generateKeyAndCsr } = require('./provisioning');
      const { csrPem, keyPem } = generateKeyAndCsr(deviceId, process.env.CERT_CN_PREFIX || 'PROOF');
      await this.store.saveStaging(null, keyPem);

      // Call backend to sign CSR using recovery_code
      const reissueResponse = await requestJson(
        new URL('/api/v1/certificates/reissue', this.config.backendUrl).toString(),
        'POST',
        { device_id: deviceId, csr: csrPem, recovery_code: String(recoveryCode).replace(/\s+/g, '') },
      );

      const issuedCert = extractCertificatePayload(reissueResponse);
      const root =
        reissueResponse && reissueResponse.data && typeof reissueResponse.data === 'object' && !Array.isArray(reissueResponse.data)
          ? reissueResponse.data
          : reissueResponse;
      const caCertificate = root.ca_certificate || root.caCertificate || root.rootCa || root.ca;
      if (typeof caCertificate !== 'string' || !caCertificate.includes('BEGIN CERTIFICATE')) {
        throw new Error('Backend did not return ca_certificate PEM');
      }

      // Persist exactly like provisioning does
      writeCertFiles(this.config.crtDir, { deviceCert: issuedCert, rootCa: caCertificate.trim(), keyPem });
      await this.store.initialize();

      if (this.stateMachine) await this.stateMachine.runAudit();
      res.json({ success: true, message: 'Recovery complete. Certificate installed; device will reconnect shortly.' });
    } catch (error) {
      const mapped = this.mapBackendError(error);
      this.sendJsonError(res, mapped.status, mapped.error, mapped.code, mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {});
    }
  }

  async start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[CONTROL] Web control panel at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.server) this.server.close();
  }

  async handleStatus(_req, res) {
    const hasPrimary = await this.store.hasPrimary();
    const hasStaging = await this.store.hasStaging();
    const integrityOk = hasPrimary ? await this.store.verifyIntegrity() : false;
    const certInfo = await this.store.getCertificateInfo();

    res.json({
      device: {
        id: certInfo?.deviceId || 'NOT_PROVISIONED',
        state: this.stateMachine?.currentState || 'UNKNOWN',
      },
      certificates: {
        hasPrimary,
        hasStaging,
        integrityOk,
        certInfo: certInfo
          ? {
              expiresAt: certInfo.expiresAt,
              daysRemaining: certInfo.daysRemaining,
              isValid: certInfo.isValid,
            }
          : null,
      },
      config: {
        mqttUrl: this.config.mqttUrl,
        backendUrl: this.config.backendUrl,
      },
    });
  }

  async handleCertInfo(_req, res) {
    const certInfo = await this.store.getCertificateInfo();
    res.json(certInfo || { error: 'No certificate found' });
  }

  sendJsonError(res, status, error, code, extra = {}) {
    res.status(status).json({
      success: false,
      error,
      code,
      ...extra,
    });
  }

  mapBackendError(error) {
    const message = error?.message || 'Unknown error';
    if (/HTTP 401:/i.test(message)) {
      return { status: 401, error: 'Invalid or expired token', code: 'AUTH_FAILED' };
    }
    if (/HTTP 403:/i.test(message)) {
      return { status: 403, error: 'Device not owned by user', code: 'ACCESS_DENIED' };
    }
    if (/HTTP 429:/i.test(message)) {
      return { status: 429, error: 'Too many attempts', code: 'RATE_LIMITED', retryAfter: 3600 };
    }
    if (/parse failed/i.test(message) || /<!DOCTYPE html>/i.test(message)) {
      return { status: 502, error: message, code: 'UPSTREAM_INVALID_RESPONSE' };
    }
    return { status: 500, error: message, code: 'SERVER_ERROR' };
  }

  async saveWifiCredentials(ssid, password) {
    const envPath = path.join(this.config.pkgRoot, '.env');
    let envContent = '';
    try {
      envContent = await fs.readFile(envPath, 'utf8');
    } catch {
      envContent = '';
    }

    const setEnvValue = (key, value) => {
      const line = `${key}=${value}`;
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent = `${envContent}${envContent.endsWith('\n') || envContent.length === 0 ? '' : '\n'}${line}\n`;
      }
    };

    setEnvValue('WIFI_SSID', ssid);
    setEnvValue('WIFI_PASSWORD', password);
    await fs.writeFile(envPath, envContent, 'utf8');
  }

  async attemptWifiConnection(ssid, password) {
    if (!ssid || !password) {
      throw new Error('SSID and password are required');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { success: true, signalStrength: 85 };
  }

  async handleFactoryReset(_req, res) {
    try {
      await this.store.clearAll();
      if (this.stateMachine?.mqttClient) {
        this.stateMachine.mqttClient.end(true);
        this.stateMachine.mqttClient = null;
      }
      if (this.stateMachine) {
        this.stateMachine.currentState = 'RECOVERY_MODE';
      }
      res.json({
        success: true,
        message: 'Factory reset complete. Device is now awaiting recovery/provisioning.',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async handleWifiReset(_req, res) {
    if (this.stateMachine) {
      await this.stateMachine.enterWifiReconfig();
    }
    res.json({
      success: true,
      message: 'WiFi credentials cleared. Enter new WiFi details to continue.',
    });
  }

  async handleWifiTest(req, res) {
    const { ssid, password } = req.body || {};
    if (!ssid || !password) {
      this.sendJsonError(res, 400, 'SSID and password required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const wifiResult = await this.attemptWifiConnection(ssid, password);
      res.json({
        success: true,
        signal: wifiResult.signalStrength,
        message: 'WiFi test successful',
      });
    } catch (error) {
      this.sendJsonError(res, 500, error.message, 'WIFI_TEST_FAILED');
    }
  }

  async handleWifiConnect(req, res) {
    const { ssid, password } = req.body || {};
    if (!ssid || !password) {
      this.sendJsonError(res, 400, 'SSID and password required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const wifiResult = await this.attemptWifiConnection(ssid, password);
      await this.saveWifiCredentials(ssid, password);
      if (this.stateMachine) {
        this.stateMachine.currentState = 'WIFI_CONFIGURED';
      }
      res.json({
        success: true,
        message: 'WiFi credentials saved successfully',
        wifi: wifiResult,
        needsReissue: !(await this.store.hasPrimary()),
      });
    } catch (error) {
      this.sendJsonError(res, 500, error.message, 'WIFI_CONNECT_FAILED');
    }
  }

  async handleRenew(_req, res) {
    if (!(await this.store.hasPrimary())) {
      res.status(400).json({ success: false, error: 'No primary certificate found. Cannot renew.' });
      return;
    }

    try {
      const renewal = new RenewalFlow(this.config, this.store);
      await renewal.run();
      if (this.stateMachine) await this.stateMachine.runAudit();
      const certInfo = await this.store.getCertificateInfo();
      res.json({
        success: true,
        message: 'Renewal completed successfully',
        newCertExpiry: certInfo?.expiresAt || null,
      });
    } catch (error) {
      const mapped = this.mapBackendError(error);
      this.sendJsonError(res, mapped.status, mapped.error, mapped.code, mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {});
    }
  }

  async handleReissue(req, res) {
    const { recoveryCode, deviceId } = req.body || {};
    if (!recoveryCode || !deviceId) {
      this.sendJsonError(res, 400, 'recoveryCode and deviceId required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const reissue = new ReissueFlow(this.config, this.store);
      await reissue.run(recoveryCode, deviceId);
      if (this.stateMachine) await this.stateMachine.runAudit();
      const certInfo = await this.store.getCertificateInfo();
      res.json({
        success: true,
        message: 'Certificate reissued successfully',
        newCertExpiry: certInfo?.expiresAt || null,
      });
    } catch (error) {
      const mapped = this.mapBackendError(error);
      this.sendJsonError(res, mapped.status, mapped.error, mapped.code, mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {});
    }
  }

  async handleFullRecovery(req, res) {
    const { ssid, password, recoveryCode, deviceId } = req.body || {};
    if (!ssid || !password || !recoveryCode || !deviceId) {
      this.sendJsonError(res, 400, 'ssid, password, recoveryCode and deviceId are required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const wifi = await this.attemptWifiConnection(ssid, password);
      await this.saveWifiCredentials(ssid, password);
      const reissue = new ReissueFlow(this.config, this.store);
      await reissue.run(recoveryCode, deviceId);

      if (this.stateMachine) {
        await this.stateMachine.runAudit();
      }

      const certInfo = await this.store.getCertificateInfo();
      res.json({
        success: true,
        message: 'Full recovery completed successfully',
        wifi,
        newCertExpiry: certInfo?.expiresAt || null,
      });
    } catch (error) {
      const mapped = this.mapBackendError(error);
      this.sendJsonError(res, mapped.status, mapped.error, mapped.code, mapped.retryAfter ? { retryAfter: mapped.retryAfter } : {});
    }
  }

  async handleTestMqtt(_req, res) {
    if (!(await this.store.hasPrimary())) {
      res.status(400).json({ success: false, error: 'No certificate found' });
      return;
    }

    try {
      const primary = await this.store.loadPrimary();
      const certInfo = await this.store.getCertificateInfo();
      const brokerCa = this.store.loadBrokerCaPem();
      await testMqttConnection(
        this.config,
        {
          deviceId: certInfo?.deviceId || 'unknown',
          cert: primary.cert,
          key: primary.key,
          ca: this.store.readLegacyCaPem(),
        },
        brokerCa,
        10000,
      );
      res.json({ success: true, message: 'MQTT connection successful' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

module.exports = { WebControlPanel };
