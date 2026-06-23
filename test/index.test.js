import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authCandidates,
  keyForPath,
  matchEmail,
  readSession,
  signSession,
  validateIdTokenClaims,
  worker,
} from "../src/index.js";

const env = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  COOKIE_SECRET: "secret",
};

const req = (path, headers = {}) => new Request(`https://private.s-anand.net${path}`, { headers });

const r2 = (objects) => ({
  async get(key) {
    const value = objects[key];
    if (value == null) return null;
    return {
      body: value,
      httpEtag: `"${key}"`,
      size: value.length,
      writeHttpMetadata(headers) {
        if (key.endsWith(".html")) headers.set("content-type", "text/html");
      },
      async text() {
        return value;
      },
    };
  },
});

describe("static path mapping", () => {
  it("maps clean URLs and hides policy files", async () => {
    assert.equal(keyForPath("/"), "index.html");
    assert.equal(keyForPath("/client/"), "client/index.html");
    assert.equal(keyForPath("/client/report.pdf"), "client/report.pdf");
    assert.equal(keyForPath("/client/.auth.json"), null);
  });

  it("redirects extensionless paths to existing directory indexes", async () => {
    const res = await worker.fetch(req("/client"), { ...env, BUCKET: r2({ "client/index.html": "ok" }) });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "/client/");
  });
});

describe("R2 policy lookup", () => {
  it("searches upward and skips the bucket root", () => {
    assert.deepEqual(authCandidates("client-a/subproject/page.html"), [
      "client-a/subproject/.auth.json",
      "client-a/.auth.json",
    ]);
    assert.deepEqual(authCandidates("index.html"), []);
  });

  it("requires login only when the nearest policy exists", async () => {
    const BUCKET = r2({
      "client/.auth.json": JSON.stringify({ allow: ["alice@gmail.com"] }),
      "client/page.html": "secret",
      "public/page.html": "public",
    });
    assert.equal((await worker.fetch(req("/public/page.html"), { ...env, BUCKET })).status, 200);
    const res = await worker.fetch(req("/client/page.html"), { ...env, BUCKET });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  });
});

describe("authorization", () => {
  it("matches exact emails, direct-domain wildcards, and subdomain wildcards", () => {
    assert.equal(matchEmail("alice@gmail.com", ["alice@gmail.com"]), true);
    assert.equal(matchEmail("bob@example.com", ["*@example.com"]), true);
    assert.equal(matchEmail("bob@x.example.com", ["*@example.com"]), false);
    assert.equal(matchEmail("bob@x.client.com", ["*@*.client.com"]), true);
    assert.equal(matchEmail("bob@client.com", ["*@*.client.com"]), false);
  });

  it("returns 403 for signed-in users not allowed by the nearest policy", async () => {
    const session = await signSession({ email: "eve@gmail.com", exp: 4_102_444_800 }, "secret");
    const BUCKET = r2({
      "client/.auth.json": JSON.stringify({ allow: ["alice@gmail.com"] }),
      "client/page.html": "secret",
    });
    const res = await worker.fetch(req("/client/page.html", { cookie: `s=${session}` }), { ...env, BUCKET });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(await res.text(), /eve@gmail\.com/);
    assert.match(await worker.fetch(req("/logout"), { ...env, BUCKET }).then((r) => r.headers.get("set-cookie")), /^s=;/);
  });
});

describe("sessions and Google claims", () => {
  it("round-trips signed JSON cookies and rejects tampering", async () => {
    const cookie = await signSession({ email: "alice@gmail.com", hd: "gmail.com", exp: 4_102_444_800 }, "secret");
    assert.equal((await readSession(`s=${cookie}`, "secret")).email, "alice@gmail.com");
    assert.equal(await readSession(`s=${cookie}x`, "secret"), null);
  });

  it("validates the Google ID token claims used by auth callback", () => {
    const payload = {
      iss: "https://accounts.google.com",
      aud: "client-id",
      exp: Math.floor(Date.now() / 1000) + 60,
      email_verified: true,
      email: "alice@gmail.com",
      hd: "gmail.com",
    };
    assert.equal(validateIdTokenClaims(payload, "client-id").email, "alice@gmail.com");
    assert.throws(() => validateIdTokenClaims({ ...payload, email_verified: false }, "client-id"));
  });
});
