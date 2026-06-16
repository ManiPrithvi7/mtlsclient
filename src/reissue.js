const { generateKeyAndCsr } = require('./provisioning');
const { testMqttConnection } = require('./mqttClient');
const {
  requestJson,
  extractCertificatePayload,
  extractCaCertificatePayload,
  extractOptionalBrokerCaCertificatePayload,
} = require('./renewal');

/**
 * Certificate reissue flow (formerly src/recovery.js).
 * This stays strictly client-side: generate CSR, call backend, stage cert, test MQTT, promote.
 */
class ReissueFlow {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  async run(recoveryToken, deviceId) {
    if (!recoveryToken || !deviceId) {
      throw new Error('recoveryToken and deviceId are required for reissue');
    }

    const { csrPem, keyPem } = generateKeyAndCsr(deviceId, process.env.CERT_CN_PREFIX || 'PROOF');
    await this.store.saveStaging(null, keyPem);

    try {
      const reissueResponse = await requestJson(
        new URL('/api/v1/certificates/reissue', this.config.backendUrl).toString(),
        'POST',
        { device_id: deviceId, csr: csrPem, recovery_token: recoveryToken },
      );

      const issuedCert = extractCertificatePayload(reissueResponse);
      const returnedCa = extractCaCertificatePayload(reissueResponse);
      const brokerCaFromResponse = extractOptionalBrokerCaCertificatePayload(reissueResponse);
      await this.store.saveStaging(issuedCert, keyPem);

      await this.store.writeLegacyRootCaPem(returnedCa);
      if (brokerCaFromResponse) {
        await this.store.writeBrokerCaPem(brokerCaFromResponse);
      }

      const brokerCa = this.store.loadBrokerCaPem();
      await testMqttConnection(
        this.config,
        { deviceId, cert: issuedCert, key: keyPem, ca: returnedCa },
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

module.exports = { ReissueFlow };

