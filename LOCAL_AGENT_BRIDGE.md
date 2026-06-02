# AI Mark Local Agent Bridge

This bridge lets the AI Mark web UI hand scan, improve, and lead-scout results
to an AI agent running on this machine.

## Start

```powershell
.\scripts\start-aimark-local-bridge.ps1
```

Bridge URL:

```text
http://127.0.0.1:8799
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8799/health
```

## What It Writes

Every handoff becomes:

```text
.aimark-agent/inbox/<task-id>.json
.aimark-agent/inbox/<task-id>.md
.aimark-agent/inbox/latest.json
.aimark-agent/inbox/latest.md
```

Give the Markdown file to the local AI agent/Codex session:

```text
Read .aimark-agent/inbox/latest.md and continue the AI Mark task.
```

## Browser Flow

Open `https://aimark.pages.dev`, run a scan or lead scout, then click:

```text
Send to local AI agent
```

The browser posts only to `127.0.0.1`, so the payload stays on this machine.

## Runner Self-Test

After pairing the bridge, use `Run runner self-test` in the Agent Bridge modal.
It sends a safe no-edit task through the same queue path used by real jobs and
waits for the selected local runner to report back.

Local endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:8799/aimark/self-test -Method Post
```

Automated checks:

```powershell
cd web
npm run test:bridge
npm run test:bridge:real
npm run test:bridge:real:apply
```

`test:bridge` uses a mock runner and proves bridge orchestration.  
`test:bridge:real` uses the installed Codex CLI and proves that a real local
runner can receive work and return a result.  
`test:bridge:real:apply` uses the installed Codex CLI against a temporary
customer workspace, verifies that it can edit `index.html`, create
`aimark-proof.md`, and report the result through AI Mark.

On Windows, use `RunnerMode full-access` for Codex. `full-auto` can fail before
shell startup with `CreateProcessAsUserW failed: 1312` in the Codex sandbox.
The production launcher already uses `full-access`.

## Customer Machine Pairing

For a customer on another computer, use the secure device-code flow instead of
copying a local repo path:

1. In AI Mark, sign in with Google.
2. Click `Connect Agent`.
3. Click `Create link + code`.
4. Run the generated PowerShell launcher on the customer machine.
5. Open the approval link and approve the displayed code.

The bridge stores a short-lived agent token locally under the customer's
`%LOCALAPPDATA%\AI Mark` folder. AI Mark never asks for the customer's Google
password, GitHub password, or GitHub token.

The hosted launcher is:

```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'start-aimark-bridge.ps1'; Invoke-WebRequest 'https://aimark.pages.dev/downloads/start-aimark-bridge.ps1' -OutFile $p; powershell -ExecutionPolicy Bypass -File $p"
```
