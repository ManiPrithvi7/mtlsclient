const { loadRuntimeConfig, nonEmpty } = require('./config');
const { CertificateStore } = require('./certificateStore');
const { provisionDevice } = require('./provisioning');
const { DeviceStateMachine } = require('./stateMachine');
const { WebControlPanel } = require('./webControlPanel');
const { OtaHandler } = require('./otaHandler');

async function main() {
  const config = loadRuntimeConfig();
  console.log('=== Node mTLS Device Simulator ===');
  console.log(`MQTT Broker: ${config.mqttUrl}`);
  console.log(`Backend API: ${config.backendUrl || '(not configured)'}`);

  const store = new CertificateStore(config);
  await store.initialize();

  const stateMachine = new DeviceStateMachine(config, store);
  const controlPanel = new WebControlPanel(config, store, stateMachine);
  await controlPanel.start();

  console.log(`\n[CONTROL] Open http://localhost:${config.controlPort}\n`);

  const hasProvisioningEnv = nonEmpty(process.env.PROVISIONING_TOKEN || '') && nonEmpty(config.provisioningServerUrl || '');
  if (config.autoProvision && store.needsProvisioning() && hasProvisioningEnv) {
    console.log('[MQTT] No device cert in crtDir — running provisioning (CSR + sign-csr)...');
    await provisionDevice(config.crtDir);
    await store.initialize();
  }

  process.on('SIGINT', () => {
    console.log('\n[MQTT] disconnecting...');
    if (stateMachine.mqttClient) {
      stateMachine.mqttClient.end(true, () => process.exit(0));
      return;
    }
    process.exit(0);
  });

  await stateMachine.start();

  if (stateMachine.otaHandler && stateMachine.otaHandler.pendingVerifyActive()) {
    console.log('[MQTT] Starting OTA pending verify task...');
    setTimeout(async () => {
      await stateMachine.otaHandler.runPendingVerify();
    }, 2000);
  }

  return { stateMachine, controlPanel };
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}
