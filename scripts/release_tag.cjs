const fs = require("node:fs");
const path = require("node:path");

const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version || "0.1.0-alpha";

process.stdout.write(`v${version}\n`);
