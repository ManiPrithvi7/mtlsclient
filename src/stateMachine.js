const { MqttRuntimeClient } = require('./mqttClient');
const { RenewalFlow } = require('./renewal');
const { ReissueFlow } = require('./reissue');
const { OtaHandler } = require('./otaHandler');

class DeviceStateMachine {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.currentState = 'INIT';
    this.mqttClient = null;
    this.otaHandler = null;
  }

  async start() {
    await this.runAudit();
  }

  async runAudit() {
    this.currentState = 'AUDIT';

    if (!(await this.store.hasPrimary())) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] No primary certificate available. Waiting for recovery or provisioning.');
      if (this.config.recoveryMode) {
        await this.enterRecovery();
      }
      return;
    }

    const integrityOk = await this.store.verifyIntegrity();
    if (!integrityOk) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] Integrity check failed. Waiting for manual recovery.');
      if (this.config.recoveryMode) {
        await this.enterRecovery();
      }
      return;
    }

    const certInfo = await this.store.getCertificateInfo();
    if (!certInfo?.isValid) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] Certificate is missing or expired. Waiting for manual recovery.');
      if (this.config.recoveryMode) {
        await this.enterRecovery();
      }
      return;
    }

    if (certInfo.daysRemaining < 30 && this.config.backendUrl) {
      await this.enterRenewal();
      return;
    }

    await this.enterOperational();
  }

  async enterOperational() {
    this.currentState = 'OPERATIONAL';

    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }

    const deviceKeys = this.store.loadDeviceKeys();
    const brokerCa = this.store.loadBrokerCaPem();
    this.mqttClient = new MqttRuntimeClient(this.config, deviceKeys, brokerCa).connect();
    console.log(`[STATE] Device entered OPERATIONAL state as ${deviceKeys.deviceId}`);

    this.otaHandler = new OtaHandler(this.config, this.mqttClient, deviceKeys.deviceId, this.store);
    await this.otaHandler.init();
    await this.otaHandler.start();

    this.attachOtaCallbacks();
  }

  attachOtaCallbacks() {
    if (!this.otaHandler) return;

    const deviceKeys = this.store.loadDeviceKeys();
    const topicPrefix = `${this.config.topicRoot}/${deviceKeys.deviceId}`;

    this.mqttClient.on('message', (topic, message) => {
      const payload = message.toString('utf8');
      if (topic === `${topicPrefix}/cmd`) {
        this.otaHandler.onMqttCmd(topic, payload);
      } else if (topic === `${topicPrefix}/ack`) {
        this.otaHandler.onMqttAck(topic, payload);
      }
    });

    this.mqttClient.on('connect', () => {
      this.otaHandler.onMqttConnected();
    });
  }

  async enterRenewal() {
    this.currentState = 'RENEWAL_PENDING';
    console.log('[STATE] Certificate is nearing expiry. Starting renewal flow.');

    try {
      const renewal = new RenewalFlow(this.config, this.store);
      await renewal.run();
      console.log('[STATE] Renewal succeeded. Re-running audit.');
      await this.runAudit();
    } catch (error) {
      this.currentState = 'OPERATIONAL_DEGRADED';
      console.error(`[STATE] Renewal failed: ${error.message}`);
    }
  }

  async enterRecovery() {
    if (!this.config.backendUrl) {
      console.error('[STATE] Auto reissue skipped: BACKEND_URL (or PROVISIONING_SERVER_URL) is not configured.');
      return;
    }
    if (!this.config.recoveryToken) {
      console.error('[STATE] Auto reissue skipped: RECOVERY_TOKEN (or RECOVERY_CODE) is not set.');
      return;
    }
    if (!this.config.deviceId) {
      console.error('[STATE] Auto reissue skipped: DEVICE_ID is not set.');
      return;
    }

    console.log('[STATE] Starting automatic certificate reissue.');
    try {
      const reissue = new ReissueFlow(this.config, this.store);
      await reissue.run(this.config.recoveryToken, this.config.deviceId);
      console.log('[STATE] Reissue succeeded. Re-running audit.');
      await this.runAudit();
    } catch (error) {
      this.currentState = 'RECOVERY_MODE';
      console.error(`[STATE] Reissue failed: ${error.message}`);
    }
  }

  async enterWifiReconfig() {
    this.currentState = 'WIFI_RECONFIG';
  }
}

module.exports = { DeviceStateMachine };
