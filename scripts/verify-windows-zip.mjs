#!/usr/bin/env node
/**
 * Verify that `public/silt-windows.zip` matches `agent/` byte-for-byte.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = join(ROOT, "agent");
const ZIP_PATH = join(ROOT, "public", "silt-windows.zip");

const FILES = [
  "silt-agent.mjs",
  "package.json",
  "Start-Silt.ps1",
  "Stop-Silt.ps1",
  "Run-Silt.cmd",
  "Stop-Silt.cmd",
  "README.txt",
  "hosts.example.txt",
];

const stage = mkdtempSync(join(tmpdir(), "silt-verify-"));
try {
  const r =
    process.platform === "win32"
      ? spawnSync("tar", ["-xf", ZIP_PATH, "-C", stage], { stdio: "inherit" })
      : spawnSync("unzip", ["-q", ZIP_PATH, "-d", stage], { stdio: "inherit" });
  if ((r.status ?? 1) !== 0) {
    process.exit(r.status ?? 1);
  }

  for (const rel of FILES) {
    const expected = readFileSync(join(AGENT_DIR, rel));
    const actual = readFileSync(join(stage, "silt-windows", rel));
    assert.equal(actual.equals(expected), true, `Mismatch in silt-windows.zip: ${rel}`);
  }
  console.log(`Verified ${FILES.length} files in public/silt-windows.zip match agent/`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
