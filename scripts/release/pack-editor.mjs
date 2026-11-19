import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const standalone = process.argv.includes("--standalone");
const output = resolve(root, standalone ? "dist/release" : "dist/packages");
const cache = resolve(root, ".tmp/npm-cache");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
mkdirSync(cache, { recursive: true });

run("pnpm", ["run", "build:editor"]);
const packages = standalone ? [packStandalone()] : [
  describe(pack("packages/editor-protocol", output), output),
  describe(pack("packages/editor", output), output),
];
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packages,
};
writeFileSync(
  resolve(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(manifest, null, 2));

function pack(directory, destination) {
  // pnpm rewrites workspace:* to the published sibling version in the tarball.
  const packed = run("pnpm", ["--dir", resolve(root, directory), "pack", "--json",
    "--pack-destination", destination], true);
  return JSON.parse(packed.stdout).filename;
}

function packStandalone() {
  const staging = mkdtempSync(resolve(tmpdir(), "jot-editor-release-"));
  try {
    const protocolArchive = pack("packages/editor-protocol", staging);
    const editorArchive = pack("packages/editor", staging);
    run("tar", ["-xzf", resolve(staging, editorArchive), "-C", staging]);
    const editor = resolve(staging, "package");
    const protocol = resolve(editor, "node_modules/@jot-md/editor-protocol");
    mkdirSync(protocol, { recursive: true });
    run("tar", ["-xzf", resolve(staging, protocolArchive), "--strip-components", "1", "-C", protocol]);
    const manifestPath = resolve(editor, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bundled = JSON.parse(readFileSync(resolve(protocol, "package.json"), "utf8"));
    if (manifest.dependencies[bundled.name] !== bundled.version) {
      throw new Error("Bundled protocol must match the editor dependency version");
    }
    manifest.bundleDependencies = [bundled.name];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const packed = run("npm", [
      "pack", "--ignore-scripts", "--json", "--pack-destination", output, "--cache", cache,
    ], true, editor);
    return describe(JSON.parse(packed.stdout)[0].filename, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function describe(filename, directory) {
  const result = run("npm", [
    "pack",
    resolve(directory, filename),
    "--dry-run",
    "--json",
    "--pack-destination",
    directory,
    "--cache",
    cache,
  ], true);
  const parsed = JSON.parse(result.stdout)[0];
  if (parsed === undefined) throw new Error(`npm pack returned no package for ${filename}`);
  const packageFiles = /^(?:dist\/|src\/|(?:LICENSE|README\.md|THIRD-PARTY-NOTICES\.txt|package\.json)$)/u;
  const appDirectory = /(?:^|\/)(?:apps|demo|benchmarks?)(?:\/|$)/u;
  const protocolPrefix = "node_modules/@jot-md/editor-protocol/";
  if (standalone && !parsed.files.some(file => file.path === protocolPrefix + "dist/index.js")) {
    throw new Error("Standalone editor is missing the bundled protocol");
  }
  const unexpected = parsed.files.find(({ path }) => {
    const member = standalone && path.startsWith(protocolPrefix) ? path.slice(protocolPrefix.length) : path;
    return !packageFiles.test(member) || appDirectory.test(path);
  });
  if (unexpected !== undefined) {
    throw new Error(`Unexpected archive entry in ${directory}: ${unexpected.path}`);
  }
  return {
    name: parsed.name,
    version: parsed.version,
    filename: parsed.filename,
    packedBytes: parsed.size,
    unpackedBytes: parsed.unpackedSize,
    integrity: parsed.integrity,
    files: parsed.entryCount,
  };
}

function run(command, args, capture = false, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr ?? ""}`,
    );
  }
  return result;
}
