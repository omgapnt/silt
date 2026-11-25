#!/usr/bin/env node
/**
 * Build `public/silt-windows.zip` from `agent/` so the web download and release
 * archive always match the source launcher, stop script, and recorder.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = join(ROOT, "agent");
const OUT_ZIP = join(ROOT, "public", "silt-windows.zip");

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

const stage = mkdtempSync(join(tmpdir(), "silt-zip-"));
const pkgDir = join(stage, "silt-windows");
mkdirSync(pkgDir, { recursive: true });

try {
  for (const rel of FILES) {
    cpSync(join(AGENT_DIR, rel), join(pkgDir, rel));
  }
  cpSync(join(AGENT_DIR, "node_modules", "node-forge"), join(pkgDir, "node_modules", "node-forge"), {
    recursive: true,
  });

  rmSync(OUT_ZIP, { force: true });
  const r =
    process.platform === "win32"
      ? spawnSync("tar", ["-a", "-c", "-f", OUT_ZIP, "-C", stage, "silt-windows"], { stdio: "inherit" })
      : spawnSync("zip", ["-rq", OUT_ZIP, "silt-windows"], { cwd: stage, stdio: "inherit" });

  if ((r.status ?? 1) !== 0) {
    process.exit(r.status ?? 1);
  }
  console.log(`Built ${OUT_ZIP}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
