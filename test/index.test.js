import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { authCandidates, keyForPath, matchEmail, readSession, signSession, validateIdTokenClaims } from "../src/index.js";

const req = (path, headers = {}) => new Request(`https://private.s-anand.net${path}`, { headers, redirect: "manual" });

const put = async (key, value, options = {}) => env.BUCKET.put(key, value, options);

const rows = async () => (await env.DB.prepare("SELECT * FROM access_log ORDER BY id").all()).results;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM access_log").run();
});

describe("static path mapping", () => {
  it("maps clean URLs and hides policy files", async () => {
    expect(keyForPath("/")).toBe("index.html");
    expect(keyForPath("/client/")).toBe("client/index.html");
    expect(keyForPath("/client/report.pdf")).toBe("client/report.pdf");
    expect(keyForPath("/client/.auth.json")).toBe(null);
  });

  it("redirects extensionless paths to existing directory indexes", async () => {
    await put("client/index.html", "ok");
    const res = await SELF.fetch(req("/client"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/client/");
  });
});

describe("R2 policy lookup", () => {
  it("searches upward and skips the bucket root", () => {
    expect(authCandidates("client-a/subproject/page.html")).toEqual([
      "client-a/subproject/.auth.json",
      "client-a/.auth.json",
    ]);
    expect(authCandidates("index.html")).toEqual([]);
  });

  it("requires login only when the nearest policy exists", async () => {
    await put("client/.auth.json", JSON.stringify({ allow: ["alice@gmail.com"] }));
    await put("client/page.html", "secret");
    await put("public/page.html", "public");

    expect((await SELF.fetch(req("/public/page.html"))).status).toBe(200);
    const res = await SELF.fetch(req("/client/page.html"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  });
});

describe("authorization", () => {
  it("matches exact emails, direct-domain wildcards, and subdomain wildcards", () => {
    expect(matchEmail("alice@gmail.com", ["alice@gmail.com"])).toBe(true);
    expect(matchEmail("bob@example.com", ["*@example.com"])).toBe(true);
    expect(matchEmail("bob@x.example.com", ["*@example.com"])).toBe(false);
    expect(matchEmail("bob@x.client.com", ["*@*.client.com"])).toBe(true);
    expect(matchEmail("bob@client.com", ["*@*.client.com"])).toBe(false);
  });

  it("returns 403 for signed-in users not allowed by the nearest policy", async () => {
    const session = await signSession({ email: "eve@gmail.com", exp: 4_102_444_800 }, "secret");
    await put("client/.auth.json", JSON.stringify({ allow: ["alice@gmail.com"] }));
    await put("client/page.html", "secret");

    const res = await SELF.fetch(req("/client/page.html", { cookie: `s=${session}` }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toMatch(/eve@gmail\.com/);
    const logout = await SELF.fetch(req("/logout"));
    expect(logout.headers.getSetCookie()[0]).toMatch(/^s=;/);
  });
});

describe("sessions and Google claims", () => {
  it("round-trips signed JSON cookies and rejects tampering", async () => {
    const cookie = await signSession({ email: "alice@gmail.com", hd: "gmail.com", exp: 4_102_444_800 }, "secret");
    expect((await readSession(`s=${cookie}`, "secret")).email).toBe("alice@gmail.com");
    expect(await readSession(`s=${cookie}x`, "secret")).toBe(null);
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
    expect(validateIdTokenClaims(payload, "client-id").email).toBe("alice@gmail.com");
    expect(() => validateIdTokenClaims({ ...payload, email_verified: false }, "client-id")).toThrow();
  });
});

describe("analytics", () => {
  it("logs public page access without query strings or secrets", async () => {
    await put("index.html", "home", { httpMetadata: { contentType: "text/html" } });
    const res = await SELF.fetch(
      req("/?code=secret&x=1", {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Vitest Browser",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("home");
    expect(await rows()).toMatchObject([
      {
        email: null,
        path: "/",
        key: "index.html",
        status: 200,
        ip: "203.0.113.10",
        user_agent: "Vitest Browser",
        meta: "{}",
      },
    ]);
  });

  it("logs authenticated email, denied status, and selected Cloudflare metadata", async () => {
    const session = await signSession({ email: "eve@gmail.com", exp: 4_102_444_800 }, "secret");
    await put("client/.auth.json", JSON.stringify({ allow: ["alice@gmail.com"] }));
    await put("client/page.html", "secret");

    const res = await SELF.fetch(req("/client/page.html", { cookie: `s=${session}` }), {
      cf: { country: "IN", city: "Bengaluru", asn: 12345, colo: "BLR" },
    });

    expect(res.status).toBe(403);
    const [row] = await rows();
    expect(row).toMatchObject({
      email: "eve@gmail.com",
      path: "/client/page.html",
      key: "client/page.html",
      status: 403,
    });
    expect(JSON.parse(row.cf)).toMatchObject({ country: "IN", city: "Bengaluru", asn: 12345, colo: "BLR" });
  });
});
