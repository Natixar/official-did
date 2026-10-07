// tools/make-did.test.mjs — the cases `--verify-file` must decide.
//
// Without them, the consistency check that continuous integration runs would
// pass just as well if it checked nothing.
//
// THE PRIVATE KEY GOES THROUGH STDIN, NEVER THROUGH A FILE, here too: the rule
// admits no "it's only a test" exception. Key pairs are generated on the fly
// and die with the process.
//
// Run with: node --test tools/make-did.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SCRIPT = join(HERE, "make-did.mjs");

const DID = "did:web:natixar.pro";

async function freshKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pair, jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

const scratch = async () => join(await mkdtemp(join(tmpdir(), "did-")), "did.json");

/** Generates a document, the private key going through stdin. */
function make(jwk, out, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, "--from-private", "-", "--out", out, ...extra],
    { input: JSON.stringify(jwk), encoding: "utf8", cwd: REPO });
  assert.equal(r.status, 0, `generation failed: ${r.stderr}`);
  return r;
}

/** The internal consistency check, as continuous integration runs it. */
function verify(path) {
  return spawnSync(process.execPath, [SCRIPT, "--verify-file", path], { encoding: "utf8", cwd: REPO });
}

test("sound document, fragment = thumbprint: accepted", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out);
  assert.equal(verify(out).status, 0);
});

test("--also-key-name variant, two entries: accepted, with the note", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out, ["--also-key-name", "key-1"]);

  const doc = JSON.parse(await readFile(out, "utf8"));
  assert.equal(doc.verificationMethod.length, 2);
  assert.ok(doc.verificationMethod.some((m) => m.id === `${DID}#key-1`));

  const r = verify(out);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /named fragment/);
});

test("publicKeyJwk edited, fragment unchanged: refused", async () => {
  const { jwk } = await freshKey();
  const other = await freshKey();
  const out = await scratch();
  make(jwk, out);

  // The exact edit a hand would make: replace the key, keep the fragment. The
  // document remains perfectly well formed.
  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod[0].publicKeyJwk =
    { crv: "P-256", kty: "EC", x: other.jwk.x, y: other.jwk.y };
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /thumbprint-shaped fragment, but the key gives/);
});

test("member \"d\" present — private key published: refused", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out);

  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod[0].publicKeyJwk.d = jwk.d;
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PRIVATE KEY PUBLISHED/);
});

test("named fragment only, no thumbprint: refused", async () => {
  const { jwk } = await freshKey();
  const out = await scratch();
  make(jwk, out, ["--also-key-name", "key-1"]);

  // Remove the thumbprint entry: only `#key-1` remains.
  const doc = JSON.parse(await readFile(out, "utf8"));
  doc.verificationMethod = doc.verificationMethod.filter((m) => m.id.endsWith("#key-1"));
  doc.assertionMethod = doc.verificationMethod.map((m) => m.id);
  await writeFile(out, JSON.stringify(doc, null, 2) + "\n");

  const r = verify(out);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no key published under its RFC 7638 thumbprint/);
});

test("--check: the document rebuilt from the same key matches; another key does not", async () => {
  const { jwk } = await freshKey();
  const other = await freshKey();
  const out = await scratch();
  make(jwk, out);
  const run = (k) => spawnSync(process.execPath, [SCRIPT, "--from-private", "-", "--out", out, "--check"],
    { input: JSON.stringify(k), encoding: "utf8", cwd: REPO });
  assert.equal(run(jwk).status, 0);
  assert.equal(run(other.jwk).status, 1);
});

test("the published document passes the continuous-integration check", async () => {
  const published = join(REPO, "public/.well-known/did.json");
  assert.equal(verify(published).status, 0, verify(published).stderr);
});
