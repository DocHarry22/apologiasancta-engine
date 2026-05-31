const { mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error("Usage: node scripts/with-local-temp.cjs <command> [...args]");
  process.exit(1);
}

const tempDir = join(process.cwd(), ".tmp");
mkdirSync(tempDir, { recursive: true });

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
