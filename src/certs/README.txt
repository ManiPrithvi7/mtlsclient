Device MQTT mTLS material (development)
======================================
Logical device id (folder): ADMIN-1
Certificate CN + SAN DNS:   PROOF-ADMIN-1
Signed by:                  /home/maniprithvi/Desktop/statsmqtt/nanomq-broker/data/ca/root-ca.crt

Use with node-mqtt-client (default CRT_DIR = this folder):
  - Client cert: client.crt
  - Client key:  client.key (protect at rest)
  - Optional broker-ca.crt — PEM to verify the MQTT server TLS cert (copy from broker / statsmqtt data/ca)
  - Optional ca.crt or root-ca.crt — device issuing CA, used when USE_CUSTOM_CA=1 (not the same role as broker-ca.crt)

Use on the device:
  - Trust: same Root CA as broker (root-ca.crt) — often already bundled in firmware config
  - Client cert: client.crt
  - Client key:  client.key (protect at rest)

Test with openssl:
  openssl s_client -connect HOST:PORT -servername SERVERNAME \
    -CAfile ../../data/ca/root-ca.crt \
    -cert client.crt -key client.key -tls1_2

mqtt-publisher-lite provisioning expects CSR CN (or SAN) = PROOF-ADMIN-1 when device_id is "ADMIN-1" and CERT_CN_PREFIX=PROOF.
