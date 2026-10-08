// tools/site.test.mjs — what `public/` declares to crawlers and resolvers.
//
// Netlify publishes `public/` as it is: nothing is built, so these files ARE
// the behaviour. The tests read them as Netlify does, without network, and
// check that natixar.pro asks not to be indexed without breaking the headers a
// resolver needs on the DID document.
//
// Run with: node --test tools/site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const DID_PATH = "/.well-known/did.json";

const read = (name) => readFile(join(PUBLIC, name), "utf8");

/** robots.txt as groups: { agents: [...], rules: [[field, value], ...] }. */
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || current.rules.length) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value);
    } else if (current) {
      current.rules.push([field, value]);
    }
  }
  return groups;
}

/** _headers as rules: [{ path, headers: [[name, value], ...] }], in file order. */
function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ path: raw.trim(), headers: [] });
      continue;
    }
    const m = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(raw);
    assert.ok(m && rules.length, `unreadable _headers line: ${raw}`);
    rules.at(-1).headers.push([m[1].toLowerCase(), m[2].trim()]);
  }
  return rules;
}

/** Netlify path patterns: `*` matches anything, `:name` one segment. */
function matches(pattern, path) {
  const re = pattern
    .split(/(\*|:[A-Za-z_]\w*)/)
    .map((part) => part === "*" ? ".*"
      : part.startsWith(":") ? "[^/]+"
      : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${re}$`).test(path);
}

/** Every header the rules give `path`, with the rule each came from. */
function headersFor(rules, path) {
  return rules
    .filter((rule) => matches(rule.path, path))
    .flatMap((rule) => rule.headers.map(([name, value]) => ({ name, value, rule: rule.path })));
}

// A header value is a comma-separated list of directives, each `name` or
// `name=value`. The checks below compare whole directives, never substrings:
// `noindexnofollownoarchive` is one unknown directive, not three, and
// `s-max-age=0` is not `max-age=0`.

/** Directives of a header value: Map of lower-cased name → value, or `true`. */
function directives(value) {
  const map = new Map();
  for (const item of value.split(",")) {
    const m = /^\s*([^=\s]+)\s*(?:=\s*(.*?))?\s*$/.exec(item);
    if (m) map.set(m[1].toLowerCase(), m[2] ?? true);
  }
  return map;
}

const NOT_INDEXED = ["noindex", "nofollow", "noarchive"];

/** The directives of NOT_INDEXED that an X-Robots-Tag value lacks. */
const robotsLacks = (value) => NOT_INDEXED.filter((d) => directives(value).get(d) !== true);

/** Whether a Cache-Control value forces revalidation on every read. */
function revalidatesEveryRead(value) {
  const d = directives(value);
  return d.get("max-age") === "0" && d.get("must-revalidate") === true;
}

// The checks themselves, against values that would fool a substring test.
// They pass before the change too: they test the test, not the site.
test("directive checks compare whole directives, not substrings", () => {
  for (const [value, lacks] of [
    ["noindex, nofollow, noarchive", []],
    ["NoIndex,nofollow , noarchive", []],
    ["noindexnofollownoarchive", NOT_INDEXED],
    ["noindex nofollow noarchive", NOT_INDEXED],
    ["noindex, nofollowed, xnoarchive", ["nofollow", "noarchive"]],
    ["noindex=1, nofollow, noarchive", ["noindex"]],
  ]) assert.deepEqual(robotsLacks(value), lacks, `X-Robots-Tag: ${value}`);

  for (const [value, ok] of [
    ["public, max-age=0, must-revalidate", true],
    ["must-revalidate,max-age=0", true],
    ["s-max-age=0, must-revalidate", false],
    ["max-age=0.5, must-revalidate", false],
    ["max-age=0, x-must-revalidate", false],
    ["max-age=0must-revalidate", false],
    ["max-age=00, must-revalidate", false],
  ]) assert.equal(revalidatesEveryRead(value), ok, `Cache-Control: ${value}`);
});

test("robots.txt asks every crawler to fetch nothing", async () => {
  const groups = parseRobots(await read("robots.txt"));
  const all = groups.find((g) => g.agents.includes("*"));
  assert.ok(all, "no `User-agent: *` group");
  assert.ok(all.rules.some(([field, value]) => field === "disallow" && value === "/"),
    "the `User-agent: *` group has no `Disallow: /`");
});

for (const path of ["/", "/robots.txt", DID_PATH, "/any/other/path"]) {
  test(`${path} is served with X-Robots-Tag: noindex, nofollow, noarchive`, async () => {
    const found = headersFor(parseHeaders(await read("_headers")), path)
      .filter((h) => h.name === "x-robots-tag");
    assert.equal(found.length, 1, `expected one X-Robots-Tag for ${path}, got ${found.length}`);
    assert.deepEqual(robotsLacks(found[0].value), [], `X-Robots-Tag: ${found[0].value}`);
  });
}

test("the DID document keeps what a resolver needs, and is not indexed", async () => {
  const got = Object.fromEntries(
    headersFor(parseHeaders(await read("_headers")), DID_PATH).map((h) => [h.name, h.value]));
  assert.equal(got["content-type"], "application/did+json");
  assert.equal(got["access-control-allow-origin"], "*");
  assert.ok(revalidatesEveryRead(got["cache-control"] ?? ""), `Cache-Control: ${got["cache-control"]}`);
  assert.deepEqual(robotsLacks(got["x-robots-tag"] ?? ""), [], `X-Robots-Tag: ${got["x-robots-tag"]}`);
});

// A guard, not a discriminator: it passes before the change too. It refuses
// the one way of adding the header that would hurt — repeating, in a second
// rule, a header the DID document already gets, so that Netlify sends both.
test("no header reaches the DID document from two rules", async () => {
  const seen = new Map();
  for (const { name, rule } of headersFor(parseHeaders(await read("_headers")), DID_PATH)) {
    assert.ok(!seen.has(name), `${name} is set by both ${seen.get(name)} and ${rule}`);
    seen.set(name, rule);
  }
});
