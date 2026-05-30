const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const PLATFORM_RULES = {
  facebook_profile: {
    label: "Facebook Profile",
    role: "reach + trust + conversation",
    expected: ["profile", "posts", "about", "professional mode", "featured links"],
    scoreBase: 56,
    actions: [
      "Use the founder/profile as the reach channel; keep Page as official proof.",
      "Pin a clear 'who I help / what result / how to contact' post.",
      "Add website and LINE OA as visible links where possible.",
    ],
  },
  facebook_page: {
    label: "Facebook Page",
    role: "official proof + ads + searchable business hub",
    expected: ["page", "reviews", "about", "service", "message"],
    scoreBase: 52,
    actions: [
      "Use Page as the official brand archive and proof layer.",
      "Make About, service category, website, and LINE OA consistent with the website.",
      "Pin proof/case-study content instead of generic promotion only.",
    ],
  },
  youtube: {
    label: "YouTube / Shorts",
    role: "searchable video authority + short-form discovery",
    expected: ["youtube", "channel", "shorts", "handle", "playlist"],
    scoreBase: 50,
    actions: [
      "Create 3 recurring Shorts topics from the website's strongest services.",
      "Use searchable titles and spoken keywords in the first 5 seconds.",
      "Add pinned comments that route to website or LINE OA.",
    ],
  },
  instagram: {
    label: "Instagram / Reels",
    role: "visual trust + reels discovery + DM intent",
    expected: ["instagram", "reel", "bio", "highlight"],
    scoreBase: 51,
    actions: [
      "Make bio outcome-led: who you help, proof, contact path.",
      "Pin 3 posts: proof, service explanation, how to start.",
      "Turn website/service proof into save-worthy Reels and Highlights.",
    ],
  },
  tiktok: {
    label: "TikTok",
    role: "interest graph discovery + fast content testing",
    expected: ["tiktok", "video", "creator", "bio"],
    scoreBase: 49,
    actions: [
      "Build topic clusters instead of random trend-only clips.",
      "Use hook + proof + CTA structure in short videos.",
      "Repurpose website FAQs into searchable captions and spoken keywords.",
    ],
  },
  line_oa: {
    label: "LINE OA",
    role: "conversion + retention + relationship channel",
    expected: ["lin.ee", "line", "oa", "rich menu"],
    scoreBase: 58,
    actions: [
      "Use LINE OA as the conversion endpoint, not the primary discovery engine.",
      "Set greeting message, rich menu, tags, and lead magnet flow.",
      "Route social/profile traffic into LINE with tracked campaign links.",
    ],
  },
  google_business: {
    label: "Google Business Profile",
    role: "local discovery + reviews + map trust",
    expected: ["google", "maps", "business", "place"],
    scoreBase: 57,
    actions: [
      "Keep category, services, phone, location, and website consistent.",
      "Add fresh photos/posts and answer Q&A.",
      "Ask for reviews tied to specific services, not generic praise only.",
    ],
  },
  linkedin: {
    label: "LinkedIn",
    role: "B2B authority + founder/entity proof",
    expected: ["linkedin", "company", "in/"],
    scoreBase: 53,
    actions: [
      "Use founder/company posts as proof of expertise and operating reality.",
      "Link profile/company/service pages back to the website.",
      "Publish concise case-study or POV posts weekly.",
    ],
  },
};

function cleanUrl(x) {
  const s = String(x || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function domain(url) {
  try { return new URL(cleanUrl(url)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function inferPlatform(url, fallback) {
  const h = domain(url);
  if (h.includes("facebook.com")) return fallback && fallback.includes("profile") ? "facebook_profile" : "facebook_page";
  if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
  if (h.includes("instagram.com")) return "instagram";
  if (h.includes("tiktok.com")) return "tiktok";
  if (h.includes("lin.ee") || h.includes("line.me")) return "line_oa";
  if (h.includes("google.") || h.includes("goo.gl") || h.includes("maps.app")) return "google_business";
  if (h.includes("linkedin.com")) return "linkedin";
  return fallback || "other";
}

function scoreChannel(platform, url, brandName, websiteDomain) {
  const rule = PLATFORM_RULES[platform] || { label: "Other channel", role: "visibility proof", expected: [], scoreBase: 45, actions: ["Make bio, proof, and website link consistent with the main brand."] };
  const u = cleanUrl(url);
  const lower = u.toLowerCase();
  let score = rule.scoreBase;
  const positives = [];
  const risks = [];
  if (u) { score += 8; positives.push("public_url_provided"); } else { score -= 20; risks.push("missing_channel_url"); }
  if (brandName && lower.includes(String(brandName).toLowerCase().replace(/\s+/g, ""))) { score += 7; positives.push("brand_name_appears_in_url"); }
  if (websiteDomain && lower.includes(websiteDomain.split(".")[0])) { score += 5; positives.push("website_entity_hint_in_url"); }
  if (platform === "line_oa") score += 6;
  if (platform === "facebook_profile") score += 6; // profile-first organic reach hypothesis
  score = Math.max(10, Math.min(92, score));
  return {
    platform,
    label: rule.label,
    url: u,
    role: rule.role,
    score,
    confidence: u ? "medium" : "low",
    data_source: u ? "public URL + heuristic readiness model" : "not connected",
    positives,
    risks,
    recommendation: rule.actions[0],
    actions: rule.actions,
  };
}

function dailyActions(channels, brandName) {
  const top = channels.filter(c => c.url).sort((a, b) => a.score - b.score).slice(0, 3);
  const baseBrand = brandName || "this business";
  const actions = [];
  if (channels.some(c => c.platform === "facebook_profile" && c.url)) {
    actions.push({
      platform: "Facebook Profile",
      format: "native post + proof image",
      hook: `Why customers should trust ${baseBrand} before they compare prices`,
      goal: "reach + trust + comments",
      cta: "Comment or message to request the website/AI visibility check.",
    });
  }
  if (channels.some(c => c.platform === "youtube" && c.url)) {
    actions.push({
      platform: "YouTube Shorts",
      format: "35-45 second vertical video",
      hook: "3 reasons AI search may not understand your business website",
      goal: "searchable authority + short-form discovery",
      cta: "Scan your website with AI Mark.",
    });
  }
  if (channels.some(c => c.platform === "line_oa" && c.url)) {
    actions.push({
      platform: "LINE OA",
      format: "rich message / lead magnet",
      hook: "Free check: is your website ready for Google and AI Search?",
      goal: "conversion + follow-up",
      cta: "Tap to request a full improvement plan.",
    });
  }
  if (!actions.length && top.length) {
    actions.push({ platform: top[0].label, format: "profile proof update", hook: `What ${baseBrand} helps customers fix`, goal: "entity clarity", cta: "Visit website or contact for assessment." });
  }
  return actions.slice(0, 5);
}

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const brandName = String(body.brand_name || "").trim();
  const websiteUrl = cleanUrl(body.website_url || body.url || "");
  const websiteDomain = domain(websiteUrl);
  const rawChannels = body.channels || {};
  const requested = [];
  for (const [key, value] of Object.entries(rawChannels)) {
    const url = cleanUrl(value);
    if (!url) continue;
    requested.push(scoreChannel(inferPlatform(url, key), url, brandName, websiteDomain));
  }
  const required = ["facebook_profile", "facebook_page", "youtube", "instagram", "tiktok", "line_oa", "google_business"];
  const present = new Set(requested.map(c => c.platform));
  const missing = required.filter(x => !present.has(x));
  const connectedAvg = requested.length ? Math.round(requested.reduce((a, c) => a + c.score, 0) / requested.length) : 0;
  const entityScore = Math.max(15, Math.min(90, Math.round((connectedAvg || 35) + Math.min(requested.length, 6) * 3 - missing.length * 2)));
  const profileFirst = requested.some(c => c.platform === "facebook_profile") && requested.some(c => c.platform === "facebook_page");
  const recommendation = profileFirst
    ? "Use Page as official proof, Profile as reach, LINE OA as conversion."
    : "Connect Facebook Profile + Page and create a profile-first visibility plan.";
  return json({
    version: "2.0",
    scan_type: "social_visibility_graph",
    generated_at: new Date().toISOString(),
    brand_name: brandName,
    website_url: websiteUrl,
    scores: {
      social_recommendation: connectedAvg || 35,
      entity_trust: entityScore,
      conversion_path: requested.some(c => c.platform === "line_oa") ? 72 : 38,
      visibility_graph: Math.round(((connectedAvg || 35) + entityScore + (requested.some(c => c.platform === "line_oa") ? 72 : 38)) / 3),
    },
    profile_first_strategy: {
      applies: profileFirst || requested.some(c => c.platform === "facebook_profile"),
      insight: "For many SME/founder-led businesses, Facebook Profile can carry organic reach while Page provides official proof and ads infrastructure.",
      recommended_model: "Profile = reach, Page = proof, LINE OA = conversion, Website = search/AI evidence.",
    },
    connected_channels: requested,
    missing_channels: missing.map(k => ({ platform: k, label: PLATFORM_RULES[k]?.label || k, why_it_matters: PLATFORM_RULES[k]?.role || "visibility proof" })),
    next_best_action: recommendation,
    today_content_actions: dailyActions(requested, brandName),
    limitations: [
      "Public/OAuth-free scan uses visible URLs and heuristic readiness signals only.",
      "Private reach, watch time, saves, and follower analytics require future OAuth/API connection.",
      "Recommendations prioritize durable entity trust and platform-native behavior; no instant ranking is promised.",
    ],
  });
}
