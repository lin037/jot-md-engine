import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [directory, requestedVersion] = process.argv.slice(2);
assert(directory && requestedVersion, "Usage: node publish-editor-package.mjs <artifact-directory> <version>");
const { packages } = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
assert.equal(packages.length, 1);
const { name, version, filename, integrity } = packages[0];
assert.equal(name, "@lin037/jot-md-engine");
assert.match(requestedVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(version, requestedVersion);
assert.equal(filename, `lin037-jot-md-engine-${version}.tgz`);
const tarball = resolve(directory, filename);
const digest = createHash("sha512").update(readFileSync(tarball)).digest("base64");
assert.equal(`sha512-${digest}`, integrity, tarball);

const registry = "https://registry.npmjs.org";
const entry = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`);
if (entry.status === 404) {
  execFileSync("npm", ["publish", tarball, "--registry", registry, "--access", "public", "--ignore-scripts"], { stdio: "inherit" });
} else {
  assert(entry.ok, `Could not check ${name}@${version}: HTTP ${entry.status}`);
  assert.equal((await entry.json()).dist.integrity, integrity, "Published version has different contents");
  console.log(`${name}@${version} is already published with the same integrity`);
}
