import type { Capture } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function formatTime(iso: string) {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatCount(n: number) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatBytes(n: number) {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

export function previewOf(capture: Capture) {
  const user = [...capture.requestMessages].reverse().find((m) => m.role === "user");
  const text = user?.text || capture.requestMessages[0]?.text || capture.path;
  return text.replace(/\s+/g, " ").trim();
}

export function roleLabel(role: string) {
  if (role === "user" || role === "human") return "You";
  if (role === "assistant" || role === "model") return "Agent";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  if (role === "raw") return "Request";
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

export function isCapture(value: unknown): value is Capture {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Capture>;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    typeof v.provider === "string" &&
    typeof v.host === "string" &&
    typeof v.method === "string" &&
    typeof v.path === "string" &&
    typeof v.status === "number" &&
    typeof v.responseText === "string" &&
    Array.isArray(v.requestMessages)
  );
}
