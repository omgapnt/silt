// Run: node silt-check.mjs — fails loudly if reply/format extraction regresses.
import assert from "node:assert/strict";
import { parseSse, extractExchange, claudeRpc, geminiChannel, makeRecorder, parseTape, directApps } from "./silt-agent.mjs";

// Desk warning: AI programs connecting around Silt. Silt's own sockets (pid 7), other apps,
// TIME_WAIT (pid 0), listeners and UDP don't count; IPv6 does.
const netstat = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    10.0.0.5:50001         160.79.104.10:443      ESTABLISHED     100",
  "  TCP    10.0.0.5:50002         160.79.104.10:443      HERGESTELLT     100",
  "  TCP    127.0.0.1:50003        127.0.0.1:8877         ESTABLISHED     200",
  "  TCP    [2001:db8::5]:50004    [2606:4700::1]:443     ESTABLISHED     200",
  "  TCP    127.0.0.1:8877         127.0.0.1:50003        ESTABLISHED     7",
  "  TCP    10.0.0.5:50005         1.2.3.4:443            ESTABLISHED     7",
  "  TCP    10.0.0.5:50006         1.2.3.4:443            ESTABLISHED     300",
  "  TCP    10.0.0.5:50007         1.2.3.4:443            TIME_WAIT       0",
  "  TCP    127.0.0.1:50008        127.0.0.1:8877         ESTABLISHED     400",
  "  TCP    0.0.0.0:8877           0.0.0.0:0              LISTENING       7",
  "  UDP    0.0.0.0:5353           *:*                                    100",
].join("\r\n");
const tasklist = ['"claude.exe","100"', '"ChatGPT.exe","200"', '"node.exe","7"', '"spotify.exe","300"', '"Grok Bot.exe","400"']
  .map((l) => l + ',"Console","1","10 K"').join("\r\n");
assert.deepEqual(directApps(netstat, tasklist, 7, 8877), [
  { name: "ChatGPT.exe", pid: 200, direct: 1, via: 1 },
  { name: "claude.exe", pid: 100, direct: 2, via: 0 },
]);

// ChatGPT delta encoding v1: bare {"v":...} continues the previous append.
const gpt = [
  'event: delta_encoding\ndata: "v1"',
  'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]}}},"c":0}',
  'data: {"p":"/message/content/parts/0","o":"append","v":"Hello"}',
  'data: {"v":" world"}',
  'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"!\\n\\nBye"}]}',
  'data: {"v":"."}',
  "data: [DONE]",
].join("\n\n");
assert.equal(parseSse(gpt).text, "Hello world!\n\nBye.");

// Grok NDJSON: tokens live under result.response.
const grok = [
  '{"result":{"response":{"token":"thinking","isThinking":true}}}',
  '{"result":{"response":{"token":"Hi","isThinking":false}}}',
  '{"result":{"response":{"token":" there","isThinking":false}}}',
].join("\n");
assert.equal(parseSse(grok).text, "Hi there");

// Paragraph breaks in the user's own message survive.
const rec = extractExchange({
  host: "api.openai.com",
  method: "POST",
  path: "/v1/chat/completions",
  status: 200,
  reqBuf: Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "line one\n\nline two\n  - item" }] })),
  resBuf: Buffer.from(JSON.stringify({ choices: [{ message: { content: "A\n\nB" } }] })),
  resType: "application/json",
});
assert.equal(rec.requestMessages[0].text, "line one\n\nline two\n  - item");
assert.equal(rec.responseText, "A\n\nB");

// Binary bodies that happen to contain '=' are not saved as garbage.
const junk = Buffer.from([0, 0, 0, 0, 9, 0x12, 0x07, 0x3d, 0x81, 0xff, 0x1a, 0x02, 0x3d, 0x00]);
assert.equal(
  extractExchange({ host: "claude.ai", method: "POST", path: "/x/Stream", status: 200, reqBuf: junk, resBuf: junk, resType: "application/connect+proto" }),
  null,
);

// claude.ai protobuf: message in PerformAction, reply snapshots in StreamTimeline frames.
const pb = (field, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)));
  return Buffer.concat([Buffer.from([(field << 3) | 2, body.length]), body]);
};
const frame = (msg) => Buffer.concat([Buffer.from([0, 0, 0, 0, msg.length]), msg]);
const conv = "conv-1";
assert.deepEqual(claudeRpc("/x/PerformAction", pb(2, pb(2, conv), pb(3, "hello claude")), Buffer.alloc(0)), { conv, user: "hello claude" });
const block = (text, id = "blk") => pb(1, pb(1, pb(4, pb(2, conv)), pb(5, pb(1, id), pb(2, "grp"), pb(9, text))));
const stream = Buffer.concat([frame(block("Hi")), frame(block("Hi there,\n\nfriend")), Buffer.from([2, 0, 0, 0, 2]), Buffer.from("{}")]);
assert.deepEqual(claudeRpc("/x/StreamTimeline", Buffer.alloc(0), stream).replies.at(-1), { msg: "grp", part: "blk", text: "Hi there,\n\nfriend" });

// Recorder: every change re-writes the turn's row; the tape keeps the newest copy per id.
function record() {
  const lines = [];
  const consider = makeRecorder({ write: (row) => lines.push(JSON.stringify(row)) });
  return { consider, rows: () => parseTape(lines.join("\n")).filter((r) => r.kind !== "reference") };
}
const say = (rows) => rows.map((r) => [r.requestMessages.map((m) => m.text).join(" / "), r.responseText]);

// Claude: a reply streamed over two reconnects stays one row.
{
  const t = record();
  const meta = (p, req, res) => ({ host: "claude.ai", method: "POST", path: "/claudeai-rpc/x/" + p, status: 200, reqBuf: req, resBuf: res });
  t.consider(meta("PerformAction", pb(2, pb(2, conv), pb(3, "hello claude")), Buffer.alloc(0)));
  t.consider(meta("StreamTimeline", Buffer.alloc(0), frame(block("Hi"))));
  t.consider(meta("StreamTimeline", Buffer.alloc(0), Buffer.concat([frame(block("Hi there")), frame(block("More.", "blk2"))])));
  assert.deepEqual(say(t.rows()), [["hello claude", "Hi there\n\nMore."]]);
}

// Gemini web: replies are base64 protobuf snapshots on long-poll GETs, keyed by an rc_ id.
// Each poll carries one reply. A question whose reply never came does not shift the pairs after it.
{
  const t = record();
  const send = (text) => ({ host: "geminiweb-pa.clients6.google.com", method: "POST", path: "/v1/processSession", status: 200, resBuf: Buffer.alloc(0),
    reqBuf: Buffer.from("count=1&ofs=1&req0___data__=" + encodeURIComponent(pb(2, pb(9, pb(1, text))).toString("base64"))) });
  const cand = (rc, text) => pb(2, pb(7, pb(1, pb(4, pb(4, pb(5, pb(1, rc), pb(2, pb(1, text))), pb(6, pb(1, "Somewhere, Earth")))))));
  const poll = (...chunks) => ({ host: "geminiweb-pa.clients6.google.com", method: "GET", path: "/v1/processSession?VER=8", status: 200, reqBuf: Buffer.alloc(0),
    resBuf: Buffer.from(chunks.map((c, i) => { const s = JSON.stringify([[i + 1, [c.toString("base64")]]]); return s.length + "\n" + s; }).join("") + '14\n[[9,["noop"]]]') });
  t.consider(send("what day is it"));
  t.consider(send("hi"));
  t.consider(poll(cand("rc_aa", "Hey! What'"), cand("rc_aa", "Hey! What's up?")));
  t.consider(send("riddle me"));
  t.consider(poll(cand("rc_bb", "I have cities")));
  t.consider(poll(cand("rc_bb", "I have cities, but no houses.\n\nWhat am I?")));
  assert.deepEqual(say(t.rows()), [["what day is it", ""], ["hi", "Hey! What's up?"], ["riddle me", "I have cities, but no houses.\n\nWhat am I?"]]);
  assert.deepEqual(geminiChannel("GET", Buffer.alloc(0), Buffer.from('14\n[[1,["noop"]]]')), { skip: true });
}

// ChatGPT web: the send's stream is only a hand-off token; the reply comes from the conversation
// fetch that follows, matched by message id. Fetching an older conversation adds nothing.
{
  const t = record();
  const base = { host: "chatgpt.com", status: 200 };
  t.consider({ ...base, method: "POST", path: "/backend-api/f/conversation", resType: "text/event-stream",
    reqBuf: Buffer.from(JSON.stringify({ action: "next", messages: [{ id: "m-user-1", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } }] })),
    resBuf: Buffer.from('data: {"type":"conduit","token":"eyJhbGciOiJFUzI1NiJ9.eyJjb25kdWl0In0.c2ln"}\n\n') });
  const conversation = (userId, ask, answer) => Buffer.from(JSON.stringify({ current_node: "a1", mapping: {
    root: { id: "root", parent: null, message: null },
    u1: { id: "u1", parent: "root", message: { id: userId, author: { role: "user" }, content: { content_type: "text", parts: [ask] } } },
    a0: { id: "a0", parent: "u1", message: { id: "a0", author: { role: "assistant" }, content: { content_type: "thoughts", thoughts: [] } } },
    a1: { id: "a1", parent: "a0", message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [answer] }, metadata: { model_slug: "gpt-x" } } } } }));
  const fetch = (body) => ({ ...base, method: "GET", path: "/backend-api/conversations/6b058353-23d4-83ed-93e5-33f217875aaa", reqBuf: Buffer.alloc(0), resBuf: body, resType: "application/json" });
  t.consider(fetch(conversation("m-user-1", "hi", "Hey! What can I help with?")));
  t.consider(fetch(conversation("m-user-1", "hi", "Hey! What can I help with?")));
  t.consider(fetch(conversation("m-old", "old question", "old answer")));
  assert.deepEqual(say(t.rows()), [["hi", "Hey! What can I help with?"]]);
  assert.equal(t.rows()[0].model, "gpt-x");

  // The page often fetches the answer while the send is still open: it waits for the send.
  t.consider(fetch(conversation("m-user-2", "and now?", "Now this.")));
  t.consider({ ...base, method: "POST", path: "/backend-api/f/conversation", resType: "text/event-stream",
    reqBuf: Buffer.from(JSON.stringify({ messages: [{ id: "m-user-2", author: { role: "user" }, content: { content_type: "text", parts: ["and now?"] } }] })),
    resBuf: Buffer.from('data: {"type":"conduit","token":"eyJhbGciOiJFUzI1NiJ9.eyJjb25kdWl0In0.c2ln"}\n\n') });
  assert.deepEqual(say(t.rows()), [["hi", "Hey! What can I help with?"], ["and now?", "Now this."]]);
}

// Codex: a tool round-trip (previous_response_id, tool output only) continues the same turn.
{
  const t = record();
  const ws = (req, res) => ({ host: "chatgpt.com", method: "WS", path: "/backend-api/codex/responses", status: 101, resType: "application/x-ndjson",
    reqBuf: Buffer.from(JSON.stringify(req)), resBuf: Buffer.from(res.map((e) => JSON.stringify(e)).join("\n")) });
  const done = (id, text) => ({ type: "response.completed", response: { id, model: "gpt-x", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 2 } } });
  t.consider(ws({ type: "response.create", model: "gpt-x", tools: [{ type: "function" }], input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandbox</permissions instructions>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] }] }, [done("resp_1", "Looking.")]));
  t.consider(ws({ type: "response.create", previous_response_id: "resp_1", input: [{ type: "function_call_output", call_id: "c1", output: "file contents here" }] }, [done("resp_2", "Fixed it.")]));
  t.consider(ws({ type: "response.create", generate: false, input: [] }, [{ type: "response.completed", response: { id: "resp_w", output: [] } }]));
  assert.deepEqual(say(t.rows()), [["fix the bug", "Looking.\n\nFixed it."]]);
  assert.deepEqual(t.rows()[0].usage, { input: 20, output: 4 });

  // Codex's own background calls (titles, memory, reviewer) are not turns; its turn id links calls exactly.
  const meta = (source, turn) => ({ "x-codex-turn-metadata": JSON.stringify({ thread_source: source, turn_id: turn }) });
  const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  t.consider(ws({ type: "response.create", client_metadata: meta("thread_title"), input: [user("Name this chat: hi")] }, [done("resp_t", '{"title":"Hi"}')]));
  t.consider(ws({ type: "response.create", client_metadata: meta("user", "turn-9"), input: [user("second task")] }, [done("resp_3", "On it.")]));
  t.consider(ws({ type: "response.create", client_metadata: meta("user", "turn-9"), input: [{ type: "custom_tool_call_output", output: "ok" }] }, [done("resp_4", "All done.")]));
  assert.deepEqual(say(t.rows()).slice(1), [["second task", "On it.\n\nAll done."]]);
}

// Settings pages read like prose but are not conversations.
assert.equal(
  extractExchange({ host: "chatgpt.com", method: "GET", path: "/backend-api/settings/user", status: 200, reqBuf: Buffer.alloc(0),
    resBuf: Buffer.from(JSON.stringify({ settings: { description: "Remember things about you across chats" } })), resType: "application/json" }),
  null,
);

// Codex (Responses API over websocket): only the new turn is kept; reply from deltas / response.completed.
const codex = extractExchange({
  host: "chatgpt.com",
  method: "WS",
  path: "/backend-api/codex/responses",
  status: 101,
  reqBuf: Buffer.from(JSON.stringify({
    type: "response.create",
    model: "gpt-x",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "old question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new question" }] },
    ],
  })),
  resBuf: Buffer.from([
    '{"type":"response.output_text.delta","delta":"Hel"}',
    '{"type":"response.output_text.delta","delta":"lo"}',
    '{"type":"response.completed","response":{"model":"gpt-x","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":5,"output_tokens":1}}}',
  ].join("\n")),
  resType: "application/x-ndjson",
});
assert.deepEqual(codex.requestMessages.map((m) => m.text), ["new question"]);
assert.equal(codex.responseText, "Hello");
assert.deepEqual(codex.usage, { input: 5, output: 1 });

// Gemini WebChannel send: base64 protobuf in a form field (real capture).
const gem = Buffer.from("count=1&ofs=1&req0___data__=EhQIAUoQCg53aGF0IGRheSBpcyBpdA%3D%3D");
assert.deepEqual(geminiChannel("POST", gem, Buffer.alloc(0)), { conv: "gemini", user: "what day is it" });
assert.deepEqual(geminiChannel("POST", Buffer.from("count=0"), Buffer.alloc(0)), { skip: true });

// CLI tools: their own title and memory calls are not turns; injected context is not what was typed.
{
  const t = record();
  const call = (host, path, req, reply) => t.consider({ host, method: "POST", path, status: 200, resType: "application/json",
    reqBuf: Buffer.from(JSON.stringify({ model: "m", ...req })), resBuf: Buffer.from(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] })) });
  call("openrouter.ai", "/api/v1/chat/completions", { messages: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, { role: "user", content: "fix it" }] }, "Fix");
  call("api.deepseek.com", "/chat/completions", { messages: [{ role: "system", content: "Create a concise title for an AI coding-assistant session from the supplied human messages." }, { role: "user", content: "Generate the session title" }] }, "Title");
  call("dashscope-intl.aliyuncs.com", "/compatible-mode/v1/chat/completions", { tools: [{ type: "function" }], messages: [{ role: "user", content: "Managed memory has TWO directories. Choose which one" }] }, "none");
  call("api.deepseek.com", "/chat/completions", { tools: [{ type: "function" }], messages: [{ role: "system", content: "You are dsh" }, { role: "user", content: "say ok" },
    { role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\npolicy" }] }, "ok");
  call("api.individual.githubcopilot.com", "/chat/completions", { messages: [{ role: "user", content: "<current_datetime>2026-11-24T18:09</current_datetime>\n\nsay hi" }] }, "hi");
  assert.deepEqual(say(t.rows()), [["say ok", "ok"], ["say hi", "hi"]]);
}

// Claude app Code session: the send, then the socket streaming the turn over two flushes.
{
  const t = record();
  const ws = (...lines) => t.consider({ host: "claude.ai", method: "WS", path: "/v1/sessions/ws/session_01AB/subscribe", status: 101,
    resType: "application/x-ndjson", reqBuf: Buffer.from('{"type":"keep_alive"}'), resBuf: Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n")) });
  const said = (uuid, ...content) => ({ type: "assistant", uuid, parent_tool_use_id: null, message: { id: "m1", role: "assistant", content } });
  t.consider({ host: "claude.ai", method: "POST", path: "/v1/code/sessions/cse_01AB/events", status: 200, resType: "application/json",
    reqBuf: Buffer.from(JSON.stringify({ events: [{ payload: { type: "user", uuid: "u1", parent_tool_use_id: null, message: { role: "user", content: "fix the build" } } }, { payload: { type: "control_request" } }] })), resBuf: Buffer.from("{}") });
  ws({ type: "user", uuid: "u1", parent_tool_use_id: null, timestamp: "2026-11-24T20:38:01.000Z", message: { role: "user", content: "fix the build" } },
    { type: "stream_event", event: { type: "content_block_delta" } },
    said("a1", { type: "thinking", thinking: "" }), said("a2", { type: "text", text: "Looking." }), said("a3", { type: "tool_use", id: "x", name: "Bash", input: {} }));
  ws({ type: "user", uuid: "r1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    { ...said("s1", { type: "text", text: "subagent chatter" }), parent_tool_use_id: "x" },
    { type: "user", uuid: "n1", parent_tool_use_id: null, message: { role: "user", content: "<task-notification>done</task-notification>" } },
    said("a4", { type: "text", text: "Fixed." }), { type: "result", subtype: "success", result: "Fixed." });
  ws({ type: "system", subtype: "task_started" });
  assert.deepEqual(t.rows().map((r) => [r.id, ...say([r])[0]]), [["claude-code-01AB-u1", "fix the build", "Looking.\n\nFixed."]]);
  // Opening the session fetches its log: newest first, starting mid-turn, with another agent's message.
  const ev = (seq, payload) => ({ sequence_num: String(seq), created_at: `2099-11-24T21:0${seq}:00.000Z`, payload });
  const log = [ev(1, said("a0", { type: "text", text: "tail of an older turn" })),
    ev(2, { type: "user", uuid: "u5", origin: { kind: "human" }, parent_tool_use_id: null, message: { role: "user", content: "deploy it" } }),
    ev(3, said("a5", { type: "text", text: "Deployed." })),
    ev(4, { type: "user", uuid: "p1", origin: { kind: "peer" }, parent_tool_use_id: null, message: { role: "user", content: "from another agent" } }),
    ev(5, said("a6", { type: "text", text: "Noted." }))].reverse();
  const fetchLog = (data) => t.consider({ host: "claude.ai", method: "GET", path: "/v1/code/sessions/session_01AB/events", status: 200, resType: "application/json", reqBuf: Buffer.alloc(0), resBuf: Buffer.from(JSON.stringify({ data })) });
  fetchLog(log);
  // Then the app polls for what's new, oldest first: the reply goes on.
  fetchLog([ev(6, said("a7", { type: "thinking", thinking: "" })), ev(7, said("a8", { type: "text", text: "Live." }))]);
  assert.deepEqual(t.rows().map((r) => [r.id, r.at, ...say([r])[0]]).slice(1), [["claude-code-01AB-u5", "2099-11-24T21:02:00.000Z", "deploy it", "Deployed.\n\nNoted.\n\nLive."]]);
}

// Grok Bot app: each poll is the whole recent transcript, newest first; ids tie answers to their turn.
{
  const t = record();
  const entry = (kind, j) => pb(1, pb(2, kind), pb(3, JSON.stringify({ kind, ...j })));
  const poll = (...entries) => t.consider({ host: "api2.cursor.sh", method: "POST", path: "/aiserver.v1.GrokBotService/ListGrokBotTranscriptEntries",
    status: 200, resType: "application/proto", reqBuf: pb(1, "agent-1"), resBuf: Buffer.concat(entries) });
  const say1 = (id, text) => entry("send-message", { id, message: { type: "text", content: text } });
  const ask = entry("message", { id: "t2u", role: "user", content: "plan my week", timestampMs: 1795550830025 });
  poll(say1("t1s5", "cut off: its question is outside the window"), ask);
  poll(say1("t2s7", "Done."), say1("t2s6", "Planning."), entry("message", { id: "t3u", role: "user", content: "from another agent", fromAgent: "x" }), ask);
  poll(say1("t2s7", "Done."), say1("t2s6", "Planning."), ask);
  assert.deepEqual(t.rows().map((r) => [r.id, r.at, ...say([r])[0]]), [["grok-bot-agent-1-t2", "2026-11-24T20:07:10.025Z", "plan my week", "Planning.\n\nDone."]]);
}

// Grok Build socket: the answer names its question; a history reload is the same row, not a new one.
{
  const t = record();
  const ev = (item) => JSON.stringify({ session_id: "s", event: { type: "conversation.history.item", item } });
  const user = ev({ id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "" }], x_grok: { input_chunks: [{ text: { text: "fix the desk" } }] } });
  const reply = ev({ id: "a1", type: "message", role: "assistant", content: [], x_grok: { parent_response_id: "u1", output_chunks: [
    { text: { text: "Thinking about your request", channel: "CHANNEL_ASSISTANT_NOTETAKER_HEADER" } },
    { text: { text: "Looking at the desk.", channel: "CHANNEL_ASSISTANT_RESPONSE" } },
    { tool_usage_card: {} },
    { text: { text: "Fixed.", channel: "CHANNEL_ASSISTANT_RESPONSE" } }] } });
  const load = { host: "grok.com", method: "WS", path: "/ws/mgw/", status: 101, reqBuf: Buffer.from('{"event":{"type":"ping"}}'), resBuf: Buffer.from(`${user}\n${reply}`) };
  t.consider(load);
  t.consider(load);
  // Live: the question echoed as a created item, the answer inside a finished response, in separate flushes.
  const live = (type, body) => JSON.stringify({ session_id: "s", event: { type, ...body } });
  const ws = (res) => t.consider({ ...load, resBuf: Buffer.from(res) });
  ws(live("conversation.item.created", { item: { id: "u2", role: "user", x_grok: { input_chunks: [{ text: { text: "and the chair" } }] } } }));
  ws(live("response.done", { response: { output: [{ id: "a2", role: "assistant", x_grok: { parent_response_id: "u2", output_chunks: [{ text: { text: "Chair done.", channel: "CHANNEL_ASSISTANT_RESPONSE" } }] } }] } }));
  assert.deepEqual(t.rows().map((r) => [r.id, ...say([r])[0]]), [["grok-build-u1", "fix the desk", "Looking at the desk.\n\nFixed."], ["grok-build-u2", "and the chair", "Chair done."]]);
}

console.log("silt-check: ok");
