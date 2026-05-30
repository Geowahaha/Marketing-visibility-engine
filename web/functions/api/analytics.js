/**
 * Cloudflare Pages Function — POST /api/analytics
 * ------------------------------------------------------------------
 * Pulls real traffic totals from the Cloudflare GraphQL Analytics API for
 * TWO date ranges (a "before" baseline and an "after" period) so you can show
 * a client the impact of the visibility fixes. All auth stays server-side.
 *
 * Required environment variables (set in Cloudflare Pages settings, NOT here):
 *   CF_API_TOKEN  - Cloudflare API token with "Analytics:Read" for the zone
 *   CF_ZONE_TAG   - the Zone ID (Cloudflare dashboard → Overview → Zone ID)
 *
 * Body: { beforeStart, beforeEnd, afterStart, afterEnd }  (YYYY-MM-DD)
 */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const GQL = `
query Totals($zone: String!, $start: String!, $end: String!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequests1dGroups(
        limit: 366
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { requests pageViews bytes }
        uniq { uniques }
      }
    }
  }
}`;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

async function rangeTotals(env, start, end) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({ query: GQL, variables: { zone: env.CF_ZONE_TAG, start, end } }),
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }
  const groups = data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
  let requests = 0, pageViews = 0, bytes = 0, uniques = 0;
  const series = [];
  for (const g of groups) {
    requests += g.sum?.requests || 0;
    pageViews += g.sum?.pageViews || 0;
    bytes += g.sum?.bytes || 0;
    uniques += g.uniq?.uniques || 0; // daily-sum approximation
    series.push({ date: g.dimensions?.date, pageViews: g.sum?.pageViews || 0 });
  }
  return { requests, pageViews, bytes, uniques, days: groups.length, series };
}

const pctDelta = (before, after) =>
  before > 0 ? Math.round(((after - before) / before) * 1000) / 10
             : (after > 0 ? 100 : 0);

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.CF_API_TOKEN || !env.CF_ZONE_TAG) {
    return json({ error: "Server missing CF_API_TOKEN and/or CF_ZONE_TAG. Add them in Pages → Settings → Variables and Secrets." }, 500);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { beforeStart, beforeEnd, afterStart, afterEnd } = body || {};
  for (const [k, v] of Object.entries({ beforeStart, beforeEnd, afterStart, afterEnd })) {
    if (!isDate(v)) return json({ error: `Bad or missing date: ${k} (expected YYYY-MM-DD).` }, 400);
  }

  let before, after;
  try {
    [before, after] = await Promise.all([
      rangeTotals(env, beforeStart, beforeEnd),
      rangeTotals(env, afterStart, afterEnd),
    ]);
  } catch (e) {
    return json({ error: "Cloudflare Analytics query failed: " + String(e) }, 502);
  }

  return json({
    zone: env.CF_ZONE_TAG,
    before: { ...before, range: `${beforeStart} → ${beforeEnd}` },
    after: { ...after, range: `${afterStart} → ${afterEnd}` },
    delta: {
      requests: pctDelta(before.requests, after.requests),
      pageViews: pctDelta(before.pageViews, after.pageViews),
      uniques: pctDelta(before.uniques, after.uniques),
    },
    generated_at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  });
}
