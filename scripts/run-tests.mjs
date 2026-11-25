#!/usr/bin/env node
/**
 * Cross-platform test runner for both `scripts/` (.test.mjs) and `src/` (.test.ts).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function collectTests(dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTests(full, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out.sort();
}

const scriptTests = collectTests("scripts", ".test.mjs");
const tsTests = collectTests("src", ".test.ts");

const r1 = spawnSync(process.execPath, ["--test", ...scriptTests], { stdio: "inherit" });
if ((r1.status ?? 1) !== 0) process.exit(r1.status ?? 1);

const r2 = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tsTests], {
  stdio: "inherit",
});
process.exit(r2.status ?? 1);
