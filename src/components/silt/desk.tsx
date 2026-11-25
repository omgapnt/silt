import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, Search } from "lucide-react";
import { previewPathPrefix } from "@/lib/preview-path-prefix";
import { formatBytes, formatCount, formatDay, formatTime, isCapture, previewOf, roleLabel } from "@/lib/silt/format";
import { sampleCaptures, sampleSession } from "@/lib/silt/sample";
import type { Capture } from "@/lib/silt/types";

const STEPS = [
  {
    n: "01",
    title: "Download the Windows folder",
    body: "One zip. It contains the recorder, the start script, and nothing that phones home.",
  },
  {
    n: "02",
    title: "Double-click Run-Silt",
    body: "Unzip first. The script asks before it changes anything. Leave the window open while you want the tape running.",
  },
  {
    n: "03",
    title: "Approve the certificate",
    body: "Windows asks you to trust “Silt Local Recorder”. That trust is how agent calls can be read. It stays on this PC.",
  },
  {
    n: "04",
    title: "Use your agents as usual",
    body: "Browsers and most apps follow the Windows proxy. Their messages to known agent hosts are written to the tape. API keys are stripped first.",
  },
  {
    n: "05",
    title: "Stop when you are done",
    body: "Double-click Stop-Silt, or close the window. Your previous proxy comes back. The tape file stays until you delete it.",
  },
];

function parseTape(text: string) {
  const rows: Capture[] = [];
  let skipped = 0;
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isCapture(value)) rows.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

function sumTokens(rows: Capture[], key: "input" | "output") {
  return rows.reduce((total, row) => total + (row.usage?.[key] ?? 0), 0);
}

function TapeList({
  rows,
  activeId,
  onPick,
}: {
  rows: Capture[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  if (!rows.length) {
    return <p className="px-4 py-8 text-sm text-mute">Nothing in this filter.</p>;
  }
  let lastDay = "";
  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const day = formatDay(row.at);
        const showDay = day !== lastDay;
        lastDay = day;
        const selected = row.id === activeId;
        return (
          <li key={row.id}>
            {showDay ? (
              <p className="px-4 pt-4 pb-1 text-xs text-mute">{day}</p>
            ) : null}
            <button
              type="button"
              onClick={() => onPick(row.id)}
              aria-pressed={selected}
              className={
                "flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left " +
                (selected ? "border-seal bg-raised" : "border-transparent hover:bg-surface")
              }
            >
              <span className="flex items-baseline justify-between gap-3 text-xs text-mute">
                <span>
                  {row.provider}
                  {row.model ? ` · ${row.model}` : ""}
                </span>
                <span className="tabular-nums">{formatTime(row.at)}</span>
              </span>
              <span className="line-clamp-2 text-sm text-chalk">{previewOf(row)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Transcript({ capture }: { capture: Capture }) {
  return (
    <div className="flex flex-col gap-6">
      {capture.requestMessages.map((turn, index) => (
        <section key={`${capture.id}-${index}`}>
          <h3 className="text-xs tracking-wide text-seal">{roleLabel(turn.role)}</h3>
          <p className="mt-2 font-serif text-lg leading-relaxed text-pretty whitespace-pre-wrap text-chalk">
            {turn.text}
          </p>
        </section>
      ))}
      <section>
        <h3 className="text-xs tracking-wide text-seal">Agent</h3>
        <p className="mt-2 font-serif text-lg leading-relaxed text-pretty whitespace-pre-wrap text-chalk">
          {capture.responseText || "No reply text was saved."}
        </p>
      </section>
    </div>
  );
}

function Facts({ capture }: { capture: Capture }) {
  const rows = [
    ["Provider", capture.provider],
    ["Model", capture.model || "Not named"],
    ["Host", capture.host],
    ["Request", `${capture.method} ${capture.path}`],
    ["Status", String(capture.status)],
    ["Latency", `${formatCount(capture.latencyMs)} ms`],
    [
      "Tokens",
      capture.usage
        ? `${formatCount(capture.usage.input ?? 0)} in · ${formatCount(capture.usage.output ?? 0)} out`
        : "Not reported",
    ],
    ["Stream", capture.streaming ? "Yes" : "No"],
    ["Secrets", capture.secretsStripped ? "Stripped before save" : "Unknown"],
  ];
  return (
    <dl className="flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="border-b border-line py-3">
          <dt className="text-xs text-mute">{label}</dt>
          <dd className="mt-1 text-sm break-words text-lime">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Install() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-8 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <h2 className="font-serif text-3xl text-balance text-chalk">Install on your Windows PC</h2>
          <p className="mt-3 text-sm leading-relaxed text-pretty text-lime">
            This preview is a sample tape. It cannot see your network. The recorder runs
            only after you start it on the machine you own, and the file it writes never leaves that machine.
          </p>
        </div>
        <a
          href="/silt-windows.zip"
          download="silt-windows.zip"
          onClick={(event) => {
            const prefix =
              previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
            event.currentTarget.href = `${prefix}/silt-windows.zip`;
          }}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-chalk px-4 text-sm font-medium text-bg"
        >
          <Download className="size-4" aria-hidden="true" />
          Download for Windows
        </a>
      </div>
      <ol className="flex flex-col border-t border-line">
        {STEPS.map((step) => (
          <li key={step.n} className="grid gap-2 border-b border-line py-5 sm:grid-cols-[4rem_1fr] sm:gap-6">
            <span className="font-serif text-lg text-seal">{step.n}</span>
            <div>
              <h3 className="text-base text-chalk">{step.title}</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-pretty text-mute">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h3 className="text-sm text-chalk">What gets saved</h3>
          <p className="mt-2 text-sm leading-relaxed text-pretty text-mute">
            Prompts and replies to known agent hosts: OpenAI, Anthropic, xAI, Gemini, Groq,
            Mistral, Cohere, Cursor, Copilot, and the rest of the built-in list. Add a private
            gateway by copying hosts.example.txt to the Silt folder in your user profile.
          </p>
        </section>
        <section>
          <h3 className="text-sm text-chalk">What does not</h3>
          <p className="mt-2 text-sm leading-relaxed text-pretty text-mute">
            Ordinary sites are counted, not opened. Keys, cookies, and Authorization headers are
            dropped before the tape is written. Apps that pin their certificate, or that ignore
            the Windows proxy, stay unread. Silt does not install a driver and does not hide itself.
          </p>
        </section>
      </div>
      <p className="text-sm text-mute">
        While the window is open, the desk on that PC is at 127.0.0.1 port 8878. If the web
        breaks after a crash, run Stop-Silt. Firefox needs the certificate imported by hand.
      </p>
    </div>
  );
}

export function Desk() {
  const [view, setView] = useState<"tape" | "install">("tape");
  const [imported, setImported] = useState<Capture[] | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileRead, setMobileRead] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (window.location.hash === "#install") setView("install");
  }, []);

  const source = imported ?? sampleCaptures;
  const providers = useMemo(() => {
    const names = new Set(source.map((row) => row.provider));
    return ["All", ...names];
  }, [source]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((row) => {
      if (provider !== "All" && row.provider !== provider) return false;
      if (!q) return true;
      const hay = [row.provider, row.model, row.host, row.path, row.responseText, ...row.requestMessages.map((m) => m.text)]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [source, provider, query]);

  const active = filtered.find((row) => row.id === selected) ?? filtered[0] ?? null;
  const tokenIn = sumTokens(source, "input");
  const tokenOut = sumTokens(source, "output");
  const sample = imported === null;

  function openView(next: "tape" | "install") {
    setView(next);
    const url = next === "install" ? "#install" : "#";
    window.history.replaceState(null, "", url);
  }

  function pick(id: string) {
    setSelected(id);
    setMobileRead(true);
  }

  async function onFile(file: File) {
    const text = await file.text();
    const { rows, skipped } = parseTape(text);
    if (!rows.length) {
      setNotice("That file had no Silt messages in it.");
      return;
    }
    setImported(rows);
    setSelected(rows[0]?.id ?? null);
    setProvider("All");
    setMobileRead(false);
    setNotice(skipped ? `Opened ${rows.length}. Skipped ${skipped} broken lines.` : `Opened ${rows.length} messages from this PC.`);
  }

  return (
    <div className="flex h-dvh flex-col bg-bg text-chalk">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 lg:px-6">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-mute">Local recorder</p>
          <h1 className="font-serif text-3xl leading-none text-chalk">Silt</h1>
        </div>
        <nav aria-label="Sections" className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => openView("tape")}
            className={
              "h-11 rounded-md px-3 text-sm " +
              (view === "tape" ? "bg-chalk text-bg" : "text-lime")
            }
          >
            Tape
          </button>
          <button
            type="button"
            onClick={() => openView("install")}
            className={
              "h-11 rounded-md px-3 text-sm " +
              (view === "install" ? "bg-chalk text-bg" : "text-lime")
            }
          >
            Install
          </button>
        </nav>
      </header>

      {view === "install" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Install />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
            <p className="max-w-3xl text-sm leading-relaxed text-pretty text-mute">
              {sample
                ? `Sample tape, not your traffic. ${formatCount(sampleSession.otherConnections)} other connections and ${formatBytes(sampleSession.otherBytes)} were counted and not stored.`
                : `Tape opened from a file on this computer. ${formatCount(source.length)} messages.`}
              {` ${formatCount(tokenIn)} tokens in, ${formatCount(tokenOut)} out.`}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="h-11 rounded-md border border-line px-3 text-sm text-lime"
              >
                Open tape
              </button>
              {imported ? (
                <button
                  type="button"
                  onClick={() => {
                    setImported(null);
                    setSelected(null);
                    setNotice(null);
                    setMobileRead(false);
                  }}
                  className="h-11 rounded-md px-3 text-sm text-mute"
                >
                  Sample
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept=".jsonl,.json,application/x-ndjson,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onFile(file);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          {notice ? <p className="px-4 py-2 text-sm text-lime lg:px-6">{notice}</p> : null}

          <div className="hidden min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-12">
            <div className="col-span-4 flex min-h-0 flex-col border-r border-line">
              <Filters
                query={query}
                provider={provider}
                providers={providers}
                onQuery={setQuery}
                onProvider={setProvider}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TapeList rows={filtered} activeId={active?.id ?? null} onPick={pick} />
              </div>
            </div>
            <div className="col-span-5 min-h-0 overflow-y-auto px-6 py-6">
              {active ? <Transcript capture={active} /> : <p className="text-sm text-mute">No message selected.</p>}
            </div>
            <div className="col-span-3 min-h-0 overflow-y-auto border-l border-line px-5 py-4">
              {active ? <Facts capture={active} /> : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col lg:hidden">
            {mobileRead && active ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setMobileRead(false)}
                  className="flex h-11 items-center gap-2 px-4 text-sm text-lime"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Tape
                </button>
                <div className="px-4 pb-6">
                  <Transcript capture={active} />
                  <div className="mt-6 border-t border-line">
                    <Facts capture={active} />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <Filters
                  query={query}
                  provider={provider}
                  providers={providers}
                  onQuery={setQuery}
                  onProvider={setProvider}
                />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <TapeList rows={filtered} activeId={active?.id ?? null} onPick={pick} />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Filters({
  query,
  provider,
  providers,
  onQuery,
  onProvider,
}: {
  query: string;
  provider: string;
  providers: string[];
  onQuery: (value: string) => void;
  onProvider: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-3">
      <label className="relative block">
        <span className="sr-only">Search messages</span>
        <Search className="pointer-events-none absolute top-3 left-3 size-4 text-mute" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search the tape"
          className="h-11 w-full rounded-md border border-line bg-surface pr-3 pl-10 text-sm text-chalk outline-none placeholder:text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal"
        />
      </label>
      <div className="flex gap-2 overflow-x-auto">
        {providers.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onProvider(name)}
            className={
              "h-11 shrink-0 rounded-md px-3 text-sm " +
              (provider === name ? "bg-chalk text-bg" : "bg-surface text-lime")
            }
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
