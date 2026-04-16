const { MqttRuntimeClient } = require('./mqttClient');
const { RenewalFlow } = require('./renewal');

class DeviceStateMachine {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.currentState = 'INIT';
    this.mqttClient = null;
  }

  async start() {
    await this.runAudit();
  }

  async runAudit() {
    this.currentState = 'AUDIT';

    if (!(await this.store.hasPrimary())) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] No primary certificate available. Waiting for recovery or provisioning.');
      return;
    }

    const integrityOk = await this.store.verifyIntegrity();
    if (!integrityOk) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] Integrity check failed. Waiting for manual recovery.');
      return;
    }

    const certInfo = await this.store.getCertificateInfo();
    if (!certInfo?.isValid) {
      this.currentState = 'RECOVERY_MODE';
      console.warn('[STATE] Certificate is missing or expired. Waiting for manual recovery.');
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

  async enterWifiReconfig() {
    this.currentState = 'WIFI_RECONFIG';
  }
}

module.exports = { DeviceStateMachine };
