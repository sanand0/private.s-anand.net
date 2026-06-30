import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "s";
const DEFAULT_SESSION = 604800;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const CF_FIELDS = ["country", "city", "region", "colo", "asn", "asOrganization", "httpProtocol", "timezone"];
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const enc = (value) => Buffer.from(value).toString("base64url");
const dec = (value) => Buffer.from(value, "base64url").toString();
const sign = (value, secret) => createHmac("sha256", secret).update(value).digest("base64url");
const now = () => Math.floor(Date.now() / 1000);

const redirect = (to, status = 302, headers = {}) => new Response(null, { status, headers: { location: to, ...headers } });
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const keyForPath = (path) => {
  const clean = decodeURIComponent(path).replace(/^\/+/, "");
  if (clean.split("/").some((part) => part === ".auth.json" || part === "..")) return null;
  if (!clean) return "index.html";
  return clean.endsWith("/") ? `${clean}index.html` : clean;
};

export const authCandidates = (key) => {
  const parts = key.split("/").slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, parts.length - i).join("/")}/.auth.json`);
};

export const signedJson = async (payload, secret) => {
  const data = enc(JSON.stringify(payload));
  return `${data}.${sign(data, secret)}`;
};

export const verifySignedJson = async (value, secret) => {
  const [data, mac] = (value || "").split(".");
  if (!data || !mac) return null;
  const good = sign(data, secret);
  if (mac.length !== good.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    return JSON.parse(dec(data));
  } catch {
    return null;
  }
};

export const signSession = signedJson;

export const readSession = async (cookie, secret) => {
  const found = (cookie || "").split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  const session = await verifySignedJson(found?.slice(COOKIE.length + 1), secret);
  return session?.email && session?.exp > now() ? session : null;
};

export const matchEmail = (email, allow = []) =>
  allow.some((rule) => {
    if (rule === email) return true;
    if (rule.startsWith("*@*.")) return email.split("@")[1]?.endsWith(`.${rule.slice(4)}`);
    if (rule.startsWith("*@")) return email.split("@")[1] === rule.slice(2);
    return false;
  });

export const validateIdTokenClaims = (payload, audience) => {
  if (!ISSUERS.has(payload.iss)) throw new Error("bad issuer");
  if (payload.aud !== audience) throw new Error("bad audience");
  if (payload.exp <= now()) throw new Error("expired token");
  if (payload.email_verified !== true) throw new Error("email not verified");
  return { email: payload.email, hd: payload.hd, exp: payload.exp };
};

const jwtPayload = (jwt) => JSON.parse(dec(jwt.split(".")[1]));

const cookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const login = async (url, env) => {
  const state = await signedJson({ next: `${url.pathname}${url.search}`, exp: now() + 600 }, env.COOKIE_SECRET);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: "https://private.s-anand.net/auth",
    response_type: "code",
    scope: "openid email",
    state,
  });
  return redirect(`${GOOGLE_AUTH}?${params}`);
};

const policyFor = async (key, bucket) => {
  for (const authKey of authCandidates(key)) {
    const object = await bucket.get(authKey);
    if (object) return JSON.parse(await object.text());
  }
  return null;
};

const responseFor = (object) => {
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  return new Response(object.body, { headers });
};

const forbidden = (email) =>
  new Response(
    `<!doctype html><title>Access denied</title><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:16px system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1rem;line-height:1.5"><h1>Access denied</h1><p>You are signed in as <strong>${escapeHtml(email)}</strong>, but this account is not allowed to view this page.</p><p><a href=/logout>Log out</a> and sign in with a different account.</p>`,
    { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } },
  );

const logAccess = (request, env, ctx, response, { path, email = null, key = null, meta = {} }) => {
  if (!env.DB || !ctx?.waitUntil) return;
  const cf = Object.fromEntries(
    CF_FIELDS.map((field) => [field, request.cf?.[field]]).filter(([, value]) => value != null),
  );
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO access_log (email, path, key, status, ip, user_agent, cf, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        email,
        path,
        key,
        response.status,
        request.headers.get("cf-connecting-ip"),
        request.headers.get("user-agent"),
        JSON.stringify(cf),
        JSON.stringify(meta),
      )
      .run()
      .catch((error) => console.error("access log failed", error)),
  );
};

const serve = async (request, env, access, url) => {
  if (url.pathname === "/logout") return redirect("/", 302, { "set-cookie": cookie("", 0) });
  if (url.pathname === "/auth") return auth(request, env);

  const key = keyForPath(url.pathname);
  access.key = key;
  if (!key) return new Response("Not found", { status: 404 });

  let object = await env.BUCKET.get(key);
  if (!object && !url.pathname.endsWith("/") && !url.pathname.split("/").pop().includes(".")) {
    object = await env.BUCKET.get(`${key}/index.html`);
    if (object) {
      access.key = `${key}/index.html`;
      return redirect(`${url.pathname}/${url.search}`, 308);
    }
  }
  if (!object) return new Response("Not found", { status: 404 });

  const policy = await policyFor(key, env.BUCKET);
  if (!policy) return responseFor(object);

  const session = await readSession(request.headers.get("cookie"), env.COOKIE_SECRET);
  if (!session) return login(url, env);
  access.email = session.email;
  if (!matchEmail(session.email, policy.allow || [])) return forbidden(session.email);
  return responseFor(object);
};

const handle = async (request, env, ctx) => {
  const url = new URL(request.url);
  const access = { path: url.pathname };
  let response;
  try {
    response = await serve(request, env, access, url);
  } finally {
    response ??= new Response("Internal Server Error", { status: 500 });
    if (url.pathname !== "/auth" && url.pathname !== "/logout") logAccess(request, env, ctx, response, access);
  }
  return response;
};

const auth = async (request, env) => {
  const url = new URL(request.url);
  const state = await verifySignedJson(url.searchParams.get("state"), env.COOKIE_SECRET);
  const next = state?.exp > now() && state.next?.startsWith("/") ? state.next : "/";
  if (!url.searchParams.get("code")) return redirect(next);

  const body = new URLSearchParams({
    code: url.searchParams.get("code"),
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: "https://private.s-anand.net/auth",
    grant_type: "authorization_code",
  });
  const token = await fetch(GOOGLE_TOKEN, { method: "POST", body }).then((r) => r.json());
  const user = validateIdTokenClaims(jwtPayload(token.id_token), env.GOOGLE_CLIENT_ID);
  const policy = await policyFor(keyForPath(new URL(next, url).pathname) || "index.html", env.BUCKET);
  const duration = Math.max(1, Number(policy?.session_duration || DEFAULT_SESSION));
  const session = await signSession({ email: user.email, hd: user.hd, exp: now() + duration }, env.COOKIE_SECRET);
  return redirect(next, 302, { "set-cookie": cookie(session, duration) });
};

export const worker = { fetch: handle };
export default worker;
