"use strict";

/**
 * Verify that the committed dist/index.js matches what `npm run build`
 * would produce from the current src/index.js.
 *
 * Used by CI to catch forgotten re-builds.
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST_FILE = path.join(ROOT, "dist", "index.js");

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const before = hashFile(DIST_FILE);

execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

const after = hashFile(DIST_FILE);

if (before !== after) {
  console.error(
    "\n❌  dist/index.js is out of date.\n" +
      "    Run `npm run build` locally and commit the updated dist/index.js.\n"
  );
  process.exit(1);
}

console.log("✅  dist/index.js is up to date.");
