import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const distUrl = new URL("../../packages/editor/dist/", import.meta.url);
const dist = fileURLToPath(distUrl);
const componentStyles = await import(new URL("component/styles.js", distUrl));
const surfaceStyles = await import(new URL("hosts/preview/styles.js", distUrl));
const directScrollbarStyles = await import(new URL("layout/direct-scrollbar.js", distUrl));
const requireEditor = createRequire(new URL("../../packages/editor/package.json", import.meta.url));
const katexDist = dirname(requireEditor.resolve("katex"));
const katexCss = readFileSync(join(katexDist, "katex.min.css"), "utf8");
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
copyFileSync(join(sysroot, "share/doc/rust/COPYRIGHT-library.html"), join(dist, "wasm/COPYRIGHT-library.html"));
const coreCss = [
  "/* @jot-md/editor component styles */",
  componentStyles.MARKDOWN_EDITOR_CSS.trim(),
  "",
  "/* @jot-md/editor surface styles */",
  surfaceStyles.EDITOR_SURFACE_CSS.trim(),
  "",
  "/* EditorSurface direct scrollbar styles */",
  directScrollbarStyles.DIRECT_SCROLLBAR_CSS.trim(),
  "",
].join("\n");
const mathCss = [
  "/* createKaTeXRenderer 使用的 KaTeX 公式样式 */",
  katexCss.trim(),
  "",
].join("\n");
writeFileSync(join(dist, "core.css"), coreCss, "utf8");
writeFileSync(join(dist, "math.css"), mathCss, "utf8");
// The full stylesheet loads the editor and the formula font rules in that order.
writeFileSync(join(dist, "styles.css"), `${coreCss}\n${mathCss}`, "utf8");

const katexFonts = join(katexDist, "fonts");
const fontNames = [...katexCss.matchAll(/url\((?:\.\/)?fonts\/([^)'\"]+)/g)]
  .map((match) => match[1])
  .filter((name) => name !== undefined);
const uniqueFontNames = [...new Set(fontNames)];
const outputFonts = join(dist, "fonts");
mkdirSync(outputFonts, { recursive: true });
for (const name of uniqueFontNames) {
  copyFileSync(join(katexFonts, basename(name)), join(outputFonts, basename(name)));
}

const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    if (directory === dist && name === "artifact-manifest.json") continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else files.push({ path: relative(dist, path), bytes: stat.size });
  }
};
visit(dist);
const byExtension = {};
for (const file of files) {
  const extension = extname(file.path) || "other";
  byExtension[extension] = (byExtension[extension] ?? 0) + file.bytes;
}
const manifest = {
  schemaVersion: 1,
  package: "@jot-md/editor",
  files: files.sort((left, right) => left.path.localeCompare(right.path)),
  totals: {
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    byExtension,
  },
};
writeFileSync(
  join(dist, "artifact-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
