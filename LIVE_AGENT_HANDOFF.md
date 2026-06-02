# AI Mark Live Agent Handoff

AI Mark should solve handoff by inviting the approved local agent into a live,
scoped work session instead of asking the owner to remember commands.

## Product Shape

1. Owner clicks **Connect** and approves the bridge once.
2. AI Mark creates a job with explicit approved actions:
   - `progress_report`
   - `public_http_fetch`
   - `browser_snapshot`
   - `browser_live_session`
3. The local bridge polls the cloud queue and starts the selected local runner
   such as Codex/GPT OAuth or Claude Code OAuth.
4. The runner reports progress through `/aimark/progress`.
5. For live page work, the runner calls `/aimark/browser-action`.
6. AI Mark shows the user what the agent is doing, what evidence was captured,
   what files changed, and what access is still missing.

## Lean Protocol First

AI Mark should not depend on a heavy browser-agent stack for every task. The
core is a small protocol that any local runner can call:

- `/aimark/progress`: tell the web app what the agent is doing.
- `/aimark/browser-action`: observe/extract/navigate/click/type/screenshot
  inside an approved scope.
- `/aimark/result`: return the final report and proof.

The default action is cheap: `observe` / `extract` reads public HTML and returns
title, H1, text sample, CTA counts, links, buttons, and inputs. Only tasks that
truly require interaction escalate to a real browser engine.

## Safe Browser Tooling

The live browser lane is approval-scoped:

- The target URL must be the approved client host or its subdomain.
- Private/local network URLs are blocked unless explicitly enabled on the
  bridge with `AIMARK_ALLOW_PRIVATE_BROWSER_SNAPSHOT=1`.
- AI Mark does not receive passwords, GitHub tokens, LINE tokens, cookies, or
  bank details.
- If Playwright is not installed, `/aimark/browser-action` still supports
  low-resource `observe` / `extract` through the same scoped approval.
  Click/type/screenshot actions report `playwright_not_available` instead of
  pretending to work.

## Open-Source Building Blocks

Use these as optional engines or design references, not as blind copy-paste:

- Playwright: deterministic browser control for navigate/click/type/screenshot.
  License: Apache-2.0.
- Browserbase Stagehand: AI-friendly act/extract/observe layer on top of a
  browser. License: MIT.
- browser-use: Python browser agent framework. License: MIT.
- Browserbase MCP server: MCP tool bridge for browser control. License:
  Apache-2.0.

The AI Mark bridge should stay vendor-flexible: Codex/GPT, Claude Code, or any
future local OAuth runner can use the same `/aimark/progress`,
`/aimark/result`, `/aimark/browser-snapshot`, and `/aimark/browser-action`
contract.

## Current Implementation

- `scripts/aimark-local-bridge.mjs`
  - `/aimark/browser-snapshot`: scoped public evidence extract.
  - `/aimark/browser-action`: scoped live action endpoint.
  - `/aimark/progress`: live progress back to the web app.
  - `/aimark/result`: final result back to the web app.
- `web/index.html`
  - **Invite live agent session** button.
  - Scan action chip: **Invite live agent**.
  - Progress panel shows runner events, proof links, files, and screenshots.

## Next Hardening Step

Ship a signed AI Mark desktop starter that bundles Node, the bridge, Playwright,
and Chromium. That turns live browser automation into a true one-click customer
experience instead of relying on the customer's local npm environment.
