const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lockPath = path.join(root, "branding", "icon-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const mismatches = [];

for (const [relativePath, expectedHash] of Object.entries(lock)) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    mismatches.push(`${relativePath}: missing`);
    continue;
  }

  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actualHash !== expectedHash) {
    mismatches.push(`${relativePath}: expected ${expectedHash}, received ${actualHash}`);
  }
}

if (mismatches.length) {
  console.error("Icon lock verification failed:\n" + mismatches.join("\n"));
  process.exit(1);
}

console.log(`Icon lock verified (${Object.keys(lock).length} files).`);
