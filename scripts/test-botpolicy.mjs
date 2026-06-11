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

// 3. AIMarkBot Allow / overrides * Disallow /
test("AIMarkBot Allow: / overrides * Disallow: / → allowed: true, matchedGroup: 'aimarkbot'", () => {
  const robots = "User-agent: *\nDisallow: /\n\nUser-agent: AIMarkBot\nAllow: /";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, true, "allowed should be true");
  assert.equal(r.matchedGroup, "aimarkbot", "matchedGroup should be aimarkbot");
});

// 4. AIMarkBot Disallow /
test("AIMarkBot Disallow: / → allowed: false, matchedGroup: 'aimarkbot'", () => {
  const robots = "User-agent: AIMarkBot\nDisallow: /";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, false, "allowed should be false");
  assert.equal(r.matchedGroup, "aimarkbot", "matchedGroup should be aimarkbot");
});

// 5. Specific-path disallow only — checking / → allowed
test("Disallow: /admin/ only → checking / → allowed: true", () => {
  const robots = "User-agent: *\nDisallow: /admin/";
  const r = aimarkBotAccess(robots, "/");
  assert.equal(r.allowed, true, "allowed should be true for /");
});

// 6. Case insensitivity — AImarkBot (mixed case) matches as aimarkbot group
test("User-agent: AImarkBot (mixed case) → matched as aimarkbot group", () => {
  const robots = "User-agent: AImarkBot\nAllow: /\n\nUser-agent: *\nDisallow: /";
  const r = aimarkBotAccess(robots, "/page");
  assert.equal(r.matchedGroup, "aimarkbot", "matchedGroup should be aimarkbot (case insensitive)");
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
