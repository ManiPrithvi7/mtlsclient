const { main } = require('./index');

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

