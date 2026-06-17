//!/usr/bin/env node

const path = require('path');

// Add src directory to path
process.chdir(path.join(__dirname, 'src'));

const { main } = require('./index');

async function run() {
  console.log('=== Testing OTA Handler ===');
  try {
    await main();
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };