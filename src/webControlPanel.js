const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');

const { RenewalFlow } = require('./renewal');
const { RecoveryFlow } = require('./recovery');
const { testMqttConnection } = require('./mqttClient');

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
        message: 'Factory reset complete. Device is now awaiting reprovisioning.',
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
    const { authToken, deviceId } = req.body || {};
    if (!authToken || !deviceId) {
      this.sendJsonError(res, 400, 'authToken and deviceId required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const recovery = new RecoveryFlow(this.config, this.store);
      await recovery.run(authToken, deviceId);
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
    const { ssid, password, authToken, deviceId } = req.body || {};
    if (!ssid || !password || !authToken || !deviceId) {
      this.sendJsonError(res, 400, 'ssid, password, authToken and deviceId are required', 'VALIDATION_ERROR');
      return;
    }

    try {
      const wifi = await this.attemptWifiConnection(ssid, password);
      await this.saveWifiCredentials(ssid, password);
      const recovery = new RecoveryFlow(this.config, this.store);
      await recovery.run(authToken, deviceId);

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
