# AIMarkBot — Web Bot Auth (RFC 9421) Deployment Manual

Goal: every audit fetch AI Mark makes carries a cryptographic signature any
origin can verify against our published key directory. AIMarkBot becomes a
**verified-identity audit bot** — un-spoofable, allowlist-able, and a
credibility line in every client report.

## Files in this package → where they go in the repo

| File | Destination |
|---|---|
| `web/functions/api/_botauth.js` | `web/functions/api/_botauth.js` |
| `web/functions/.well-known/http-message-signatures-directory.js` | `web/functions/.well-known/http-message-signatures-directory.js` |
| `scripts/generate-botauth-key.mjs` | `scripts/generate-botauth-key.mjs` |
| `scripts/test-botauth.mjs` | `scripts/test-botauth.mjs` |

## Deploy (15 minutes)

```powershell
# 1. Generate the identity (run locally, output stays local)
node scripts/generate-botauth-key.mjs

# 2. Store the PRIVATE key as an encrypted secret (paste when prompted)
npx wrangler pages secret put BOTAUTH_PRIVATE_JWK --project-name aimark

# 3. Set plain env vars (Dashboard → aimark → Settings → Variables):
#    BOTAUTH_PUBLIC_JWK = {public JWK JSON from step 1}
#    BOTAUTH_AGENT_URL  = https://aimark.pages.dev   (or the custom domain)

# 4. Deploy, then verify the directory is live:
curl -s https://aimark.pages.dev/.well-known/http-message-signatures-directory
#    → application/http-message-signatures-directory+json with your public key,
#      and the response itself carries Signature headers (self-signed directory).

# 5. Add to the verify gate (package.json or verify script):
node scripts/test-botauth.mjs
```

## Integrate into the audit fetch paths

Anywhere the scanner fetches a TARGET site, switch to the signed wrapper.
One-line change per call site:

```js
import { signedFetch } from "./_botauth.js";

// before:
const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal });
// after:
const r = await signedFetch(env, url, { headers: { "User-Agent": UA }, redirect: "follow", signal });
```

Call sites to patch (pass `env` down where the helper doesn't have it):
- `scan.js` — the target-site fetch (~line 186). NOT the Anthropic/PSI API calls.
- `deep-scan.js` — `fetchText()` (thread `env` through).
- `bot-access.js` / `bot-intel.js` — **only the AIMarkBot-identity fetch.**
  The per-bot simulation fetches (GPTBot UA, ClaudeBot UA…) must stay
  UNSIGNED — signing a request that claims to be GPTBot would be identity
  confusion. Recommended pattern: fetch once as signed AIMarkBot for the
  authoritative read, then run the unsigned per-UA simulations for the
  comparison matrix.
- `render-check.js`, `social-visibility.js`, `competitor.js`, `citation-probe.js`
  target fetches.

Fail-open guarantee: with no key configured, `signedFetch` === `fetch`.
Nothing breaks on day one; signatures appear the moment secrets are set.

## Honest User-Agent (do this at the same time)

A verified bot should not wear a Chrome costume. Change the default audit UA:

```
AIMarkBot/1.0 (+https://aimark.pages.dev/bot; audit on site-owner request)
```

And publish a one-page `/bot` page (Thai + English): what AIMarkBot is, that
scans run at the site owner's request, the UA string, the key-directory URL,
how to verify our signature, and a contact for opt-out. Keep the
browser-like UA available as an explicit *comparison mode* inside
bot-access testing (that's a legitimate audit function: "how do you treat
browsers vs declared bots"), never as the default identity.

## Key rotation

1. Generate a new pair. 2. Set new private as `BOTAUTH_PRIVATE_JWK`, move the
old public JWK to `BOTAUTH_PUBLIC_JWK_PREV`, new public to
`BOTAUTH_PUBLIC_JWK` (the directory serves both during overlap). 3. After
48h (directory cache 24h + margin), remove `_PREV`. Rotate immediately on
any suspicion of exposure; rotate routinely every 6–12 months.

## What to tell customers (the marketing line)

> "Every AI Mark scan is cryptographically signed (RFC 9421 Web Bot Auth —
> the same standard Cloudflare uses to verify legitimate bots). Your WAF can
> verify it's really us, and nobody can impersonate our scanner. We hold our
> bot to the standard we audit yours against."

That last sentence is the brand. The scanner that scores other sites on
agent-readiness is itself a model citizen of the agentic web: signed
requests, published directory, honest UA, public bot page — and the AI Mark
site itself should score Level 4+ on its own rubric (llms.txt, Markdown
negotiation, Link headers, MCP card via AI Search). Eat the cooking.

## Opt-out KV registry

Permanent opt-out is stored in the `RATE_LIMIT_KV` binding (see wrangler.toml).
Key format: `botoptout:<hostname>` — lowercase, no leading `www.`
(e.g. `botoptout:example.com` covers both `example.com` and `www.example.com`).

To add a host to the opt-out list (Wrangler v4):
```
npx wrangler kv key put botoptout:example.com 1 --binding RATE_LIMIT_KV --remote
```

To remove a host:
```
npx wrangler kv key delete botoptout:example.com --binding RATE_LIMIT_KV --remote
```

To list all opted-out hosts:
```
npx wrangler kv key list --binding RATE_LIMIT_KV --remote --prefix botoptout:
```

To reverse an opt-out, contact: Geowahaha@gmail.com

## Verification matrix (proof this works)

| Check | Command | Expect |
|---|---|---|
| Directory live | `curl -sI https://aimark.pages.dev/.well-known/http-message-signatures-directory` | 200, directory media type, Signature headers |
| E2E sign/verify | `node scripts/test-botauth.mjs` | ✅ all assertions |
| Live request signed | scan any site you control; inspect access log | Signature-Agent + Signature-Input + Signature present |
| Cloudflare recognition | target zone with Bot Management: check bot tags on our requests | signed-agent verification (rollout varies by plan) |
