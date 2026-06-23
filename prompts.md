# Prompts

## Initial Build, 23 Jun 2026

<!--
cd ~/code/private.s-anand.net
dev.sh -p ~/r2/private/
npx wrangler login
codex --yolo --model gpt-5.5 --config model_reasoning_effort=medium
-->

Build the absolute minimal Cloudflare Worker project that serves static files from a private R2 bucket named [`private`](https://dash.cloudflare.com/2c483e1dd66869c9554c6949a2d17d96/r2/default/buckets/private) at `private.s-anand.net`, with path-level access control using Google OAuth.

- Use Cloudflare Workers + R2 only, not Cloudflare Access / Zero Trust, KV, D1, Durable Objects, backend servers, databases, or external dependencies (unless unavoidable).
- Use modern Cloudflare Worker features to minimize code.
- Prefer `compatibility_flags = ["nodejs_compat"]` so we can use `node:buffer` and `node:crypto` for compact signed-cookie helpers.
- Use Google OAuth / OpenID Connect for login.
- Use `https://private.s-anand.net/auth` as the OAuth callback URL.
- Use `/logout` for logout.
- Store session state in a signed cookie named `s` containing `{ email, hd, exp }`.
- Use HMAC SHA-256 signed JSON cookies. Do not encrypt; the email is not secret.
- Validate Google ID token claims: issuer, audience, expiry, and `email_verified`.

Static file behavior:

- Serve files from the R2 bucket.
- `/` maps to `index.html`.
- `/path/` maps to `path/index.html`.
- `/path/file.ext` maps to `path/file.ext`.
- If `/path` does not exist but `/path/index.html` exists, redirect `/path` to `/path/` with 308.
- Never serve `.auth.json` files.
- Return 404 for missing files.

Access control behavior:

- Authorization is controlled entirely by `.auth.json` files stored in R2. Different paths can have different rules.
- Updating the R2 bucket should update access rules without redeploying the Worker.
- For a requested key, search upward for the nearest `.auth.json` (no need to check the bucket root).
  Example for `client-a/subproject/page.html`, check:
  - `client-a/subproject/.auth.json`
  - `client-a/.auth.json`
- The nearest `.auth.json` wins.
- If no `.auth.json` exists, the file is public.
- If a policy exists and the user has no valid session, redirect to Google login.
- If the user has a valid session but is not allowed, return 403.

Example `.auth.json`:

```json
{
  "allow": ["alice@gmail.com", "bob@client.com", "*@example.com", "*@*.client.com"],
  "session_duration": 604800
}
```

Matching rules:

- `allow`, if present, supports exact emails and wildcard patterns.
  - `*@example.com` should match direct email addresses under `example.com`.
  - `*@*.client.com` should match subdomains.
- `session_duration`, if present, may control session duration (in seconds); otherwise default to 7 days.

Create a complete minimal Worker project: `wrangler.toml`, `index.js`.

Bind the worker to the R2 bucket (use CDP at localhost:9222 if you need to visit Cloudflare dashboard to view the bucket). This bucket is synced locally at ~/r2/private/ - you can use `~/r2/private/nord-anglia-marketing/.auth.json` to test access control.

Create Cloudflare secrets using `.env` for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_SECRET` using `wrangler secret put`.

Keep the code short, readable, and robust. Avoid framework abstractions. Prefer a single `src/index.js` file.

Write minimal, elegant unit tests before implementing the worker. Make sure it covers all workflows, test failure, THEN implement the worker.

Use `wrangler dev` to test the worker locally. Use CDP to test on the browser. Publish with `wrangler publish`.

When you need me to test by logging in with Google, pause and let me know. Let me know if you're stuck anywhere else, e.g. wrangler.

Commit as you go.

---

Instead of a bland Forbidden message, show a minimal HTML page with a crisp explanation, also allowing them to log out.

---

Create a minimal README.md explaining what this repo does, where it's deployed, how to update content with `.auth.json`, and development instructions for how to run, test and deploy it.

<!-- codex resume 019ef49c-091f-7a10-b349-5ffb8b07690d --yolo -->
