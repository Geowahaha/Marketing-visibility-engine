# AIBotAuth — Verified Audit Bot / บอทตรวจสอบที่ยืนยันตัวตนได้

> AIBotAuth is a cryptographically signed website audit bot operated by AIBotAuth
> (https://aibotauth.com). Every request carries an Ed25519 HTTP Message
> Signature (RFC 9421, Web Bot Auth profile). We scan only at the site owner's
> request. / AIBotAuth เซ็นลายเซ็นดิจิทัลทุกคำขอ และสแกนเฉพาะเมื่อเจ้าของเว็บไซต์ร้องขอเท่านั้น

## Identity

- User-Agent: `AIBotAuth/1.0 (+https://aibotauth.com/bot; site-owner-requested audit)`
- Operator: AIBotAuth — https://aibotauth.com
- Key directory (JWKS, Ed25519): https://aibotauth.com/.well-known/http-message-signatures-directory
- Contact / opt-out: Geowahaha@gmail.com

## How to verify a request is really from us

Do not trust the User-Agent string alone — verify the signature:

1. Every AIBotAuth request includes `Signature-Agent: "https://aibotauth.com"`,
   `Signature-Input: sig1=("@authority" "signature-agent");created=…;expires=…;keyid="…";alg="ed25519";tag="web-bot-auth"`,
   and `Signature: sig1=:…:`.
2. Fetch our JWKS from the key directory above and match `keyid` to a key `kid`.
3. Rebuild the RFC 9421 signature base over `@authority` (your host) and
   `signature-agent`, then verify the Ed25519 signature.
4. Enforce the `created`/`expires` window (300 s). Signatures are bound to your
   host and cannot be replayed against another domain.

On Cloudflare, Web Bot Auth signatures are verified automatically under
Verified Bots; you can allowlist the signed AIBotAuth and block impostors.

## Crawl behavior

- Scans run only when a site owner (or their delegate) requests an audit through AIBotAuth.
- robots.txt is honored; your declared policy is also reported back to the requester.
- Low volume: one audit fetches at most ~15 public pages within seconds.
  No recurring crawl unless the owner enables monitoring.
- We never collect content for AI training, never resell crawl data, and never
  crawl the open web uninvited.
- Our bot-access comparison mode sends third-party crawler User-Agents
  (GPTBot, ClaudeBot, …) to test how a site treats them. Those simulation
  requests are NEVER signed with our key — the signature belongs exclusively
  to the AIBotAuth identity.

## Opt out

Add to your robots.txt (always honored):

```
User-agent: AIBotAuth
Disallow: /
```

or email Geowahaha@gmail.com for a permanent opt-out.
