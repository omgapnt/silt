import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  decodeBody,
  extractExchange,
  hostIsAgent,
  parseSse,
  scrubText,
} from "./silt-agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

assert.equal(hostIsAgent("api.openai.com"), true);
assert.equal(hostIsAgent("chatgpt.com"), true);
assert.equal(hostIsAgent("mail.google.com"), false);
assert.equal(hostIsAgent("www.googleapis.com"), false);
assert.equal(hostIsAgent("generativelanguage.googleapis.com"), true);
assert.equal(hostIsAgent("bedrock-runtime.us-east-1.amazonaws.com"), true);
assert.equal(hostIsAgent("s3.us-east-1.amazonaws.com"), false);
assert.equal(hostIsAgent("my-gateway.internal", [".internal"]), true);
assert.equal(hostIsAgent("cursor.sh"), false);
assert.equal(hostIsAgent("api2.cursor.sh"), true);
assert.equal(scrubText("Authorization: Bearer sk-abcDEFghij1234567890"), "Authorization: Bearer «redacted»");

const sse = parseSse(
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n',
);
assert.equal(sse.text, "Hello");

const cap = extractExchange({
  host: "api.openai.com",
  method: "POST",
  path: "/v1/chat/completions",
  status: 200,
  reqBuf: Buffer.from(
    JSON.stringify({
      model: "gpt-4.1",
      api_key: "sk-this-should-not-survive-123456",
      messages: [{ role: "user", content: "Say hi" }],
    }),
  ),
  resBuf: Buffer.from(
    JSON.stringify({
      model: "gpt-4.1",
      choices: [{ message: { role: "assistant", content: "Hello there" } }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    }),
  ),
  resType: "application/json",
  latencyMs: 12,
});
assert.equal(cap.responseText, "Hello there");
assert.equal(cap.requestMessages[0].text, "Say hi");
assert.equal(JSON.stringify(cap).includes("sk-this-should"), false);
assert.equal(cap.usage.input, 2);

const gz = extractExchange({
  host: "api.anthropic.com",
  method: "POST",
  path: "/v1/messages",
  status: 200,
  reqBuf: Buffer.from(JSON.stringify({ model: "claude", messages: [{ role: "user", content: "Ping" }] })),
  resBuf: Buffer.from(JSON.stringify({ content: [{ type: "text", text: "Pong" }] })),
  resType: "application/json",
  latencyMs: 3,
});
assert.equal(gz.responseText, "Pong");
assert.equal(decodeBody(Buffer.from("plain"), "").toString(), "plain");
const gzipJson = zlib.gzipSync(Buffer.from('{"choices":[{"message":{"content":"from-gzip"}}]}'));
assert.equal(decodeBody(gzipJson, "gzip").toString(), '{"choices":[{"message":{"content":"from-gzip"}}]}');
assert.equal(decodeBody(gzipJson, "").toString().includes("from-gzip"), true);
const zstdJson = zlib.zstdCompressSync(Buffer.from('{"ok":"from-zstd"}'));
assert.equal(decodeBody(zstdJson, "zstd").toString(), '{"ok":"from-zstd"}');
const gzipCap = extractExchange({
  host: "api.openai.com",
  method: "POST",
  path: "/v1/chat/completions",
  status: 200,
  reqBuf: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hi" }] })),
  resBuf: decodeBody(gzipJson, "gzip"),
  resType: "application/json",
  latencyMs: 1,
});
assert.equal(gzipCap.responseText, "from-gzip");
assert.equal(JSON.stringify(gzipCap).includes("\u001f\u008b"), false);

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function onceLine(stream, needle) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        stream.off("data", onData);
        resolve(buf);
      }
    };
    stream.on("data", onData);
    stream.on("end", () => reject(new Error("ended before " + needle + "\n" + buf)));
  });
}

async function requestViaProxy({ proxyPort, host, port, ca, path: reqPath, body, headers }) {
  const sock = net.connect(proxyPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  const headerBuf = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      sock.off("data", onData);
      const head = buf.slice(0, idx).toString();
      const rest = buf.slice(idx + 4);
      if (!head.includes(" 200 ")) reject(new Error(head));
      else resolve(rest);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });

  const tlsSock = tls.connect({ socket: sock, servername: host, ca, rejectUnauthorized: true });
  if (headerBuf.length) tlsSock.unshift(headerBuf);
  await new Promise((resolve, reject) => {
    tlsSock.once("secureConnect", resolve);
    tlsSock.once("error", reject);
  });
  const payload =
    `POST ${reqPath} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Content-Type: application/json\r\n` +
    `Accept-Encoding: gzip\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    headers +
    `\r\n` +
    body;
  tlsSock.write(payload);
  const response = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    tlsSock.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
    });
    tlsSock.on("end", () => {
      const sep = buf.indexOf("\r\n\r\n");
      const head = buf.slice(0, Math.max(sep, 0)).toString("utf8");
      let body = sep === -1 ? buf : buf.slice(sep + 4);
      if (/content-encoding:\s*gzip/i.test(head)) body = zlib.gunzipSync(body);
      resolve(head + "\r\n\r\n" + body.toString("utf8"));
    });
    tlsSock.on("error", reject);
  });
  return response;
}

async function integration() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "silt-"));
  const upstreamKey = path.join(dataDir, "up.key");
  const upstreamCert = path.join(dataDir, "up.crt");
  await new Promise((resolve, reject) => {
    const child = spawn(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-keyout", upstreamKey, "-out", upstreamCert, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"],
      { stdio: "ignore" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("openssl " + code))));
  });

  const secret = "sk-SUPERSECRETTOKENVALUE1234567890";
  const upstream = https.createServer(
    { key: fs.readFileSync(upstreamKey), cert: fs.readFileSync(upstreamCert) },
    (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        assert.equal(req.headers.authorization, "Bearer " + secret);
        const json = JSON.stringify({
          model: "demo-model",
          choices: [{ message: { role: "assistant", content: "recorded-ok" } }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        });
        const gz = zlib.gzipSync(json);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(gz.length),
        });
        res.end(gz);
      });
    },
  );
  const upstreamPort = await listen(upstream);

  const proxyPort = 18877;
  const uiPort = 18878;
  const agent = spawn(process.execPath, [path.join(here, "silt-agent.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      SILT_DATA_DIR: dataDir,
      SILT_PROXY_PORT: String(proxyPort),
      SILT_UI_PORT: String(uiPort),
      SILT_INSECURE_UPSTREAM: "1",
      SILT_EXTRA_HOSTS: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  agent.stdout.on("data", (c) => {
    logs += c.toString();
  });
  agent.stderr.on("data", (c) => {
    logs += c.toString();
  });
  try {
    await onceLine(agent.stdout, "Silt desk");
    const ca = fs.readFileSync(path.join(dataDir, "silt-ca.crt"));
    const response = await requestViaProxy({
      proxyPort,
      host: "127.0.0.1",
      port: upstreamPort,
      ca,
      path: "/v1/chat/completions",
      body: JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "Record this" }] }),
      headers: `Authorization: Bearer ${secret}\r\n`,
    });
    assert.match(response, /recorded-ok/);
    await new Promise((r) => setTimeout(r, 200));
    const saved = fs.readFileSync(path.join(dataDir, "captures.jsonl"), "utf8");
    assert.match(saved, /recorded-ok/);
    assert.match(saved, /Record this/);
    assert.equal(saved.includes(secret), false);
    assert.equal(saved.includes("Authorization"), false);

    const echo = net.createServer((socket) => {
      socket.on("data", (d) => socket.write(d));
    });
    const echoPort = await listen(echo);
    const tunnel = net.connect(proxyPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      tunnel.once("connect", resolve);
      tunnel.once("error", reject);
    });
    tunnel.write(`CONNECT example.test:${echoPort} HTTP/1.1\r\nHost: example.test:${echoPort}\r\n\r\n`);
    // example.test will not resolve — use a numeric host that is NOT an agent.
    tunnel.destroy();
    echo.close();

    const direct = net.connect(proxyPort, "127.0.0.1");
    const echoed = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let stage = "status";
      direct.on("connect", () => {
        direct.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
      });
      // 127.0.0.1 IS mitm in this test. Use a different approach: temporarily we need a non-agent host
      // that still connects. Skip if this races. We open a second agent? Keep it simple:
      direct.on("data", (c) => {
        buf = Buffer.concat([buf, c]);
      });
      direct.on("error", reject);
      setTimeout(() => resolve(buf.toString()), 400);
    });
    // This connection is MITM because 127.0.0.1 is extra. Don't assert tunnel body.
    void echoed;
    direct.destroy();

    const health = await new Promise((resolve, reject) => {
      http
        .get("http://127.0.0.1:" + uiPort + "/api/stats", (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(JSON.parse(b)));
        })
        .on("error", reject);
    });
    assert.ok(health.aiCaptures >= 1);
    console.log("integration ok", { captures: health.aiCaptures, other: health.otherConnections });
  } finally {
    agent.kill("SIGTERM");
    upstream.close();
    await new Promise((r) => setTimeout(r, 100));
    if (logs.includes("Error") || logs.includes("error")) {
      console.log("--- agent log ---");
      console.log(logs);
    }
  }
}

await integration();

async function tunnelPassthrough() {
  const echo = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const echoPort = await listen(echo);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "silt-tunnel-"));
  const proxyPort = 18879;
  const uiPort = 18880;
  const agent = spawn(process.execPath, [path.join(here, "silt-agent.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      SILT_DATA_DIR: dataDir,
      SILT_PROXY_PORT: String(proxyPort),
      SILT_UI_PORT: String(uiPort),
      SILT_EXTRA_HOSTS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  agent.stderr.on("data", (c) => {
    logs += c.toString();
  });
  try {
    await onceLine(agent.stdout, "Silt desk");
    const sock = net.connect(proxyPort, "127.0.0.1");
    const echoed = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let tunneled = false;
      sock.on("error", (err) => reject(new Error("client " + err.message + "\n" + logs)));
      sock.once("connect", () => {
        sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
      });
      sock.on("data", (chunk) => {
        if (!tunneled) {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const head = buf.slice(0, idx).toString();
          if (!head.includes(" 200 ")) {
            reject(new Error(head));
            return;
          }
          tunneled = true;
          const rest = buf.slice(idx + 4);
          buf = rest;
          sock.write("hello-through-silt");
        } else {
          buf = Buffer.concat([buf, chunk]);
          if (buf.toString().includes("hello-through-silt")) resolve(buf.toString());
        }
      });
      setTimeout(() => reject(new Error("tunnel timed out: " + buf.toString() + "\n" + logs)), 4000);
    });
    assert.match(echoed, /hello-through-silt/);
    console.log("tunnel ok");
  } finally {
    agent.kill("SIGTERM");
    echo.close();
  }
}

await tunnelPassthrough();
console.log("self-test passed");
