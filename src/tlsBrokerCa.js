const tls = require('node:tls');

/**
 * Node replaces the default CA store when `ca` is set. Public brokers (e.g. EMQX
 * Serverless / DigiCert) may need both Mozilla roots and an explicit broker PEM.
 */
function caForBrokerTls(customCaPem) {
  return [...tls.rootCertificates, customCaPem];
}

module.exports = { caForBrokerTls };
