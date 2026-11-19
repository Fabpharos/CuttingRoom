// Runs the frontend's unit tests (src/**/*.test.ts) with Node's test runner.
// Each test file is bundled with esbuild (already installed with Vite), with
// the Tauri packages replaced by stubs, since tests never talk to Rust.
//
//   npm test

import { build } from "esbuild";
import { readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = join(tmpdir(), `cutting-room-tests-${process.pid}`);
mkdirSync(out, { recursive: true });

const stub = join(out, "tauri-stub.mjs");
writeFileSync(
  stub,
  `export const invoke = async () => { throw new Error("no Tauri in tests"); };
export const convertFileSrc = (p) => p;
export const listen = async () => () => {};
export class LazyStore { async get() { return undefined; } async set() {} async save() {} }
export const open = async () => null;
export const save = async () => null;
export const getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });
`,
);

function findTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : findTests(p);
    return e.name.endsWith(".test.ts") ? [p] : [];
  });
}

const tests = findTests(join(root, "src"));
const bundles = [];
for (const file of tests) {
  const dest = join(out, relative(root, file).replace(/[\\/]/g, "_").replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [file],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: dest,
    logLevel: "error",
    alias: {
      "@tauri-apps/api/core": stub,
      "@tauri-apps/api/event": stub,
      "@tauri-apps/api/webview": stub,
      "@tauri-apps/plugin-store": stub,
      "@tauri-apps/plugin-dialog": stub,
    },
  });
  bundles.push(dest);
}

const result = spawnSync(process.execPath, ["--test", ...bundles], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
