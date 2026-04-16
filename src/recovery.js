const { generateKeyAndCsr } = require('./provisioning');
const { testMqttConnection } = require('./mqttClient');
const { requestJson, extractCertificatePayload } = require('./renewal');

class RecoveryFlow {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  async run(authToken, deviceId) {
    if (!authToken || !deviceId) {
      throw new Error('authToken and deviceId are required for recovery');
    }

    const { csrPem, keyPem } = generateKeyAndCsr(deviceId, process.env.CERT_CN_PREFIX || 'PROOF');
    await this.store.saveStaging(null, keyPem);

    try {
      const reissueResponse = await requestJson(
        new URL('/api/v1/certificates/reissue', this.config.backendUrl).toString(),
        'POST',
        { device_id: deviceId, csr: csrPem },
        { headers: { Authorization: `Bearer ${authToken}` } },
      );

      const issuedCert = extractCertificatePayload(reissueResponse);
      await this.store.saveStaging(issuedCert, keyPem);

      const brokerCa = this.store.loadBrokerCaPem();
      await testMqttConnection(
        this.config,
        { deviceId, cert: issuedCert, key: keyPem, ca: this.store.readLegacyCaPem() },
        brokerCa,
        10000,
      );

      await this.store.promoteStagingToPrimary();
      return true;
    } catch (error) {
      await this.store.clearStaging();
      throw error;
    }
  }
}

module.exports = { RecoveryFlow };
