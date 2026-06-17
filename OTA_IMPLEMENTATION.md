# OTA Implementation Summary

This document describes the OTA (Over-The-Air Update) functionality implemented in the statsclient project to mimic the ESP32 OTA functionality from the mqttclient project.

## Overview

The statsclient project is a Node.js implementation that simulates an ESP32 device with MQTT connectivity. This implementation adds OTA functionality to match the ESP32's OTA flow while adapting it for the Node.js environment.

## Key Differences from ESP32 Implementation

1. **Language**: ESP32 uses C/C++, statsclient uses Node.js (JavaScript)
2. **Installation**: ESP32 can install firmware to flash memory; statsclient only validates and notifies server
3. **HTTP Client**: ESP32 uses custom HTTP client; statsclient uses Node.js built-in `https` module
4. **File System**: ESP32 uses ESP-IDF partition system; statsclient uses Node.js file system
5. **SHA-256 Verification**: Both use SHA-256, but implementation differs
6. **Signature Verification**: Both support signature verification using signing key

## OTA Flow

### 1. MQTT Command Reception
- ESP32: `ota_handler_on_mqtt_cmd()` in `ota_handler.c`
- statsclient: `OtaHandler.onMqttCmd()` in `otaHandler.js`

### 2. Manifest Parsing
- ESP32: `parse_manifest_from_json()` in `ota_handler.c`
- statsclient: `parseManifestFromJson()` in `otaHandler.js`

### 3. Firmware Download
- ESP32: `http_download_stream()` in `http_mtls_client.c`
- statsclient: `downloadFirmware()` in `otaHandler.js` (using Node.js `https` module)

### 4. Progress Reporting
- ESP32: `ota_publish_progress()` in `ota_handler.c`
- statsclient: `notifyProgress()` in `otaHandler.js`

### 5. Validation
- ESP32: SHA-256 and signature verification in `ota_handler.c`
- statsclient: SHA-256 and signature verification in `otaHandler.js`

### 6. Success Notification
- ESP32: `ota_success` message via MQTT
- statsclient: `ota_success` message via MQTT

## Files Modified

### 1. `/home/maniprithvi/Desktop/statsclient/src/otaHandler.js`
New file containing the OTA handler implementation:
- `OtaHandler` class with methods for OTA lifecycle management
- `init()`, `start()`, `stop()` for OTA handler control
- `onMqttCmd()`, `onMqttAck()`, `onMqttConnected()` for MQTT event handling
- `applyUpdate()` for firmware download and validation
- `downloadFirmware()` for downloading firmware from URL
- `verifySignature()` for signature verification
- `notifyProgress()`, `notifySuccess()`, `notifyFailure()` for status reporting

### 2. `/home/maniprithvi/Desktop/statsclient/src/stateMachine.js`
Updated to integrate OTA handler:
- Added `OtaHandler` import
- Added `otaHandler` property to `DeviceStateMachine` class
- Updated `enterOperational()` to initialize and start OTA handler
- Added `attachOtaCallbacks()` to attach MQTT event handlers

### 3. `/home/maniprithvi/Desktop/statsclient/src/index.js`
Updated to support OTA pending verify flow:
- Added `OtaHandler` import
- Added logic to run pending verify task if active

### 4. `/home/maniprithvi/Desktop/statsclient/src/mqttClient.js`
Updated to add OTA command handling:
- Added `attachOtaHandlers()` method to attach OTA event handlers
- Added `onOtaCmd()`, `onOtaAck()`, `onOtaConnected()` for OTA event handling
- Added `parseManifestFromJson()`, `queueOtaUpdate()` for OTA command processing

## Implementation Details

### OTA Handler Class
```javascript
class OtaHandler {
  constructor(config, mqttClient, deviceId) {
    this.config = config;
    this.mqttClient = mqttClient;
    this.deviceId = deviceId;
    // ... initialization
  }

  async init() {
    // Initialize OTA handler
  }

  async start() {
    // Start OTA processing loop
  }

  async onMqttCmd(topic, payload) {
    // Handle OTA commands from MQTT
  }

  async onMqttAck(topic, payload) {
    // Handle OTA acknowledgments from MQTT
  }

  async onMqttConnected() {
    // Handle MQTT connection events
  }

  async applyUpdate(manifest) {
    // Download and validate firmware
  }

  async downloadFirmware(url, expectedSize) {
    // Download firmware from URL
  }

  async verifySignature(dataHash, signature) {
    // Verify firmware signature
  }

  async notifyProgress(version, percent) {
    // Notify server of download progress
  }

  async notifySuccess(version) {
    // Notify server of successful validation
  }

  async notifyFailure(version, reason) {
    // Notify server of validation failure
  }
}
```

### Key Features

1. **Manifest Parsing**: Parses OTA manifest JSON containing version, download URL, SHA-256 hash, and signature
2. **Firmware Download**: Downloads firmware from URL using Node.js HTTPS module
3. **Progress Tracking**: Tracks download progress and reports to server
4. **SHA-256 Verification**: Validates firmware integrity using SHA-256 hash
5. **Signature Verification**: Verifies firmware signature using signing key
6. **Status Reporting**: Publishes status updates to server via MQTT
7. **Error Handling**: Handles various error scenarios and reports failures
8. **Pending Verify**: Supports pending verify mode for OTA validation

## Testing

To test the OTA functionality:

1. Start the statsclient:
   ```bash
   cd /home/maniprithvi/Desktop/statsclient
   npm start
   ```

2. The client will automatically connect to MQTT and enter operational state
3. The OTA handler will be initialized and started
4. To test OTA, send an `ota_update` command via MQTT to the device

## Configuration

The OTA functionality uses the following environment variables:

- `APP_VERSION`: Current firmware version (for version comparison)
- `CRT_DIR`: Directory containing certificates and keys
- `MQTT_TOPIC_ROOT`: Root topic for MQTT messages
- `STATUS_TOPIC`: Topic for status messages
- `CMD_TOPIC`: Topic for command messages

## Future Enhancements

1. **Actual Installation**: Currently only validates and notifies; could be extended to actually install firmware
2. **Rollback Support**: Could implement rollback functionality
3. **Progress Callbacks**: Could add progress callbacks for real-time updates
4. **OTA Statistics**: Could collect and report OTA statistics
5. **OTA Logs**: Could log OTA activities for debugging

## Conclusion

The statsclient project now has OTA functionality that mimics the ESP32 OTA flow while adapting it for the Node.js environment. The implementation validates firmware integrity, reports progress to the server, and supports signature verification, making it suitable for demonstration purposes for firmware developers.