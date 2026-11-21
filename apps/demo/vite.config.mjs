import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { editorChunkGroups } from "../../scripts/build/vite-editor-chunks.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  worker: {
    format: "es",
  },
  build: {
    outDir: "../../dist/demo",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            ...editorChunkGroups,
            {
              name: "demo-panels",
              test: /[\\/]apps[\\/]demo[\\/]src[\\/](?:runtime-panel|style-lab)\.ts$/u,
              tags: ["$initial"],
            },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
