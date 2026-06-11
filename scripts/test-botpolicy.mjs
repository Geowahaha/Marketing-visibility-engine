#!/usr/bin/env node
import assert from "node:assert";
import { aimarkBotAccess, parseRobotsGroups } from "../web/functions/api/_botpolicy.js";

let passed = 0;

function test(label, fn) {
  process.stdout.write(`  ${label} ... `);
  fn();
  console.log("OK");
  passed++;
}

// 1. No robots.txt (empty string)
test("empty robots.txt → allowed: true, matchedGroup: null", () => {
  const r = aimarkBotAccess("", "/");
  assert.equal(r.allowed, true, "allowed should be true");
  assert.equal(r.matchedGroup, null, "matchedGroup should be null");
});

// 2. Star Disallow /
test("* Disallow: / → allowed: false, matchedGroup: '*'", () => {
  const robots = "User-agent: *\nDisallow: /";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, false, "allowed should be false");
  assert.equal(r.matchedGroup, "*", "matchedGroup should be *");
});

// 3. AIBotAuth Allow / overrides * Disallow /
test("AIBotAuth Allow: / overrides * Disallow: / → allowed: true, matchedGroup: 'aibotauth'", () => {
  const robots = "User-agent: *\nDisallow: /\n\nUser-agent: AIBotAuth\nAllow: /";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, true, "allowed should be true");
  assert.equal(r.matchedGroup, "aibotauth", "matchedGroup should be aibotauth");
});

// 4. AIBotAuth Disallow /
test("AIBotAuth Disallow: / → allowed: false, matchedGroup: 'aibotauth'", () => {
  const robots = "User-agent: AIBotAuth\nDisallow: /";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, false, "allowed should be false");
  assert.equal(r.matchedGroup, "aibotauth", "matchedGroup should be aibotauth");
});

// 5. Specific-path disallow only — checking / → allowed
test("Disallow: /admin/ only → checking / → allowed: true", () => {
  const robots = "User-agent: *\nDisallow: /admin/";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, true, "allowed should be true for /");
});

// 6. Case insensitivity — AIbotAuth (mixed case) matches as aibotauth group
test("User-agent: AIbotAuth (mixed case) → matched as aibotauth group", () => {
  const robots = "User-agent: AIbotAuth\nAllow: /\n\nUser-agent: *\nDisallow: /";
  const r = aimarkBotAccess(robots, "/page");
  assert.equal(r.matchedGroup, "aibotauth", "matchedGroup should be aibotauth (case insensitive)");
  assert.equal(r.allowed, true, "allowed should be true");
});

// 7. /robots.txt path → always allowed
test("/robots.txt path → allowed: true, matchedGroup: 'always'", () => {
  const robots = "User-agent: *\nDisallow: /";
  const r = aimarkBotAccess(robots, "/robots.txt");
  assert.equal(r.allowed, true, "robots.txt always accessible");
  assert.equal(r.matchedGroup, "always", "matchedGroup should be 'always'");
});

// 8. Longest match wins — Allow: /pub and Disallow: / → /pub/page is allowed
test("Allow: /pub beats Disallow: / for /pub/page (longest match)", () => {
  const robots = "User-agent: *\nDisallow: /\nAllow: /pub";
  const r = aimarkBotAccess(robots, "/pub/page");
  assert.equal(r.allowed, true, "Allow: /pub should win over Disallow: / for /pub/page");
});

// 9. Empty Disallow → allow all
test("User-agent: * / Disallow: (empty) → allowed: true", () => {
  const robots = "User-agent: *\nDisallow:";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, true, "empty Disallow means allow all");
});

console.log(`\n✅ botpolicy: all ${passed} tests passed.`);
