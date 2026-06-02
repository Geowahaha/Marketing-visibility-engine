# LINE OA Growth Kit

## Positioning

LINE OA Growth Kit is the Thai conversion layer for AI Mark.

AI Mark fixes the website so Google, AI engines, and social previews understand
the business. The LINE OA Growth Kit turns that attention into chat, quote,
follow-up, coupon, and repeat purchase workflows inside the channel Thai
customers already use.

## Security Model

AI Mark should not ask a customer to paste a LINE channel access token into the
web UI.

Safe options:

1. **Manual LINE OA Manager lane**: AI Mark generates copy, rich menu brief, and
   broadcast drafts; the owner applies them inside LINE Official Account Manager.
2. **Local agent lane**: the owner or AI Mark operator runs
   `line-oa-mcp-ultimate` locally; LINE secrets stay in local config such as
   `~/.line-mcp/config.json`.
3. **Managed lane**: AI Mark performs setup during a service engagement using
   approved access and documented handover.

Remote HTTP/MCP mode can be added later, but it must sit behind real auth,
tenant isolation, audit logging, and secret storage. It should not be the first
customer-facing flow.

## Studied MCP Capability

Repo: https://github.com/Geowahaha/line-oa-mcp-ultimate.git

Useful capabilities found:

- `line_send_message`: reply, push, multicast, narrowcast, broadcast, draft, and
  dry-run modes with quota/quiet-hour safety.
- `line_build_rich_menu`: create/upload/set default rich menu with validation.
- Flex message templates localized for Thai.
- Audience tools from CSV or engagement.
- OA status, follower, message stats, coupon stats, and reports.
- Coupon management.
- Webhook testing and signature verification.
- User profile and follower list tools.
- Multi-OA support for agencies.
- LIFF lifecycle and code generation.
- Thai festival/calendar resources for campaign planning.

AI Mark should generate the brief and pass it to this MCP runtime instead of
rebuilding all LINE tooling from scratch.

## Generated Artifact Contract

`/api/improve` now includes `line_oa_growth_kit` in the paid artifact set.

The artifact should contain:

- Customer-specific mission and source URL.
- Security note: no LINE token in AI Mark web UI.
- MCP package/source/install guidance.
- Rich menu brief: 6 areas, labels, actions, and image direction.
- Welcome message.
- Quick replies.
- Auto-reply rules for quote/service/contact intents.
- 3-6 draft LINE broadcasts derived from the social calendar.
- Verification checklist.
- Agent prompt for `line-oa-mcp-ultimate`.

## Customer Flow

1. Customer runs AI Mark scan.
2. Customer clicks "Generate all fixes".
3. Paid Fix Pack unlocks web artifacts plus `line_oa_growth_kit`.
4. Customer clicks "Send this package to local AI agent" or uses manual LINE OA
   Manager setup.
5. Agent first runs status/inspection tools, then prepares rich menu and message
   drafts.
6. Outbound messages use dry-run first.
7. Owner approves before any real broadcast.
8. AI Mark re-scans website and tracks LINE campaign results where available.

## Offer Design

| Offer | Deliverable | Price idea |
|---|---|---|
| LINE OA Starter | Rich menu brief, welcome, quick replies, 3 broadcasts | ฿2,900 |
| LINE OA Growth Kit | Starter + MCP agent setup + dry-run proof | ฿6,900 |
| Managed LINE Growth | Monthly broadcasts, coupon/test/report cycle | ฿5,900+/mo |

This should be sold after the scan when the customer already sees that the site
and social path are leaking conversion.

## Acceptance Criteria

- The web app shows `LINE OA Growth Kit` as an artifact after Improve Engine.
- Free tier locks it behind credits.
- Paid tier exposes a ready-to-use Markdown brief.
- Local agent bridge includes it in generated task packages.
- No customer secret is requested in AI Mark web UI.
- The generated brief tells the agent to use `dry_run` and owner approval before
  real outbound sending.
