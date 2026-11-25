Silt
====

A recorder for messages this Windows PC sends to AI agents.
It is a local proxy. It is not a hidden sniffer, and it does not upload the tape.

What it saves
- Chat, completion, and message calls to known agent hosts
  (OpenAI, Anthropic, xAI, Gemini, Groq, Cursor, Copilot, and others).
- The prompt, the reply, the model, and rough token counts.
- Stored under %LOCALAPPDATA%\Silt\captures.jsonl

What it refuses to save
- Authorization headers, cookies, and API keys. Those are stripped first.
- Page bodies from ordinary sites. Those connections are counted, not opened.
- Traffic on someone else's machine. Run it only on a PC you own.

Command-line and desktop AI tools
- Silt sets HTTP_PROXY/HTTPS_PROXY plus NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and
  REQUESTS_CA_BUNDLE (pointing at %LOCALAPPDATA%\Silt\ca-bundle.pem) for your user,
  so Node, Bun and Python tools (Codex, Claude Code, Gemini CLI, aider...) trust it.
- It also sets NODE_USE_ENV_PROXY=1. Without it Node tools (Qwen, Cline, Gemini CLI,
  DeepSeek dsh, pi...) ignore HTTPS_PROXY and go straight out. Node then prints
  "EnvHttpProxyAgent is experimental" once per run; that warning is harmless.
- Restart them after starting Silt: close the terminal (and VS Code / Cursor fully),
  open a new one. Stop-Silt puts the old values back.
- Chat titles and memory tidying the tools do by themselves are not saved as turns.
- A tool that still refuses the certificate is passed through unread, not broken.
  The desk lists it under "refused".

Desktop apps
- Grok Bot: every turn, read from the transcript the app keeps fetching.
- Claude app Code sessions: what you type is saved when you send it. The reply is
  saved when the app streams or re-fetches that session.
- The desk warns in orange when an AI program still connects around Silt (it was
  started before Silt, or it ignores the proxy). Quit and reopen the ones it names.

What it cannot see
- Apps that ignore the Windows proxy.
- Apps that pin their own certificate. Silt will not bypass that.
- Models running on this PC (Ollama, LM Studio on localhost): that traffic never
  leaves the machine through a proxy.
- Firefox, until you import %LOCALAPPDATA%\Silt\silt-ca.cer into Firefox.

Install
1. Unzip this folder.
2. Double-click Run-Silt.cmd.
3. Confirm the prompt, then approve the Windows certificate dialog.
4. Leave the window open. The desk is http://127.0.0.1:8878
5. Double-click Stop-Silt.cmd when you want your old proxy back.

Add a private gateway
Copy hosts.example.txt to %LOCALAPPDATA%\Silt\hosts.txt and list the host.
Restart Silt.

If the web stops loading after a crash, run Stop-Silt.cmd. That clears the proxy.
