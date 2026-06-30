# private.s-anand.net

Minimal Cloudflare Worker that serves static files from the private R2 bucket named `private` at:

https://private.s-anand.net

The Worker serves public files by default and uses Google OAuth only for paths protected by `.auth.json` files stored in R2. It uses D1 only for access logs, and no KV, Durable Objects, Cloudflare Access, backend server, external analytics service, or framework.

## How It Works

- Static files are read from my [`private`](https://dash.cloudflare.com/2c483e1dd66869c9554c6949a2d17d96/r2/default/buckets/private) R2 bucket.
- `/` maps to `index.html`.
- `/path/` maps to `path/index.html`.
- `/path/file.ext` maps to `path/file.ext`.
- `/path` redirects to `/path/` with `308` if `path/index.html` exists.
- `.auth.json` files are never served.
- Missing files return `404`.
- Sessions are signed JSON cookies named `s` containing `{ email, hd, exp }`.
- `/logout` clears the session cookie.
- Meaningful requests are logged asynchronously to D1 in `access_log`.

## Access Control

Access rules live in R2 as `.auth.json` files. Updating R2 updates access control immediately; no Worker deploy is needed.

For a requested key like `client-a/subproject/page.html`, the Worker checks:

1. `client-a/subproject/.auth.json`
2. `client-a/.auth.json`

The nearest policy wins. The bucket root is not checked. If no policy exists, the file is public.

Example policy:

```json
{
  "allow": ["alice@gmail.com", "bob@client.com", "*@example.com", "*@*.client.com"],
  "session_duration": 604800
}
```

`allow` supports exact emails and wildcard domains:

- `*@example.com` matches direct addresses like `a@example.com`.
- `*@*.client.com` matches subdomains like `a@x.client.com`.

`session_duration` is optional and is in seconds. The default is 7 days.

## Updating Content

Upload files to the `private` R2 bucket using Wrangler or any existing sync process.

```bash
npx wrangler r2 object put private/path/index.html --remote --file ./index.html
npx wrangler r2 object put private/path/.auth.json --remote --file ./.auth.json
```

To make a folder public, remove its nearest `.auth.json` or move the content outside protected paths:

```bash
npx wrangler r2 object delete private/path/.auth.json --remote
```

The local synced bucket is at `~/r2/private/`.

## Analytics

Access logs are written to the D1 database bound as `DB`. The table stores UTC timestamp, authenticated email when available, URL path without query string, resolved R2 object key, response status, IP, user agent, selected Cloudflare request metadata as JSON, and future metadata as JSON.

Apply migrations:

```bash
npx wrangler d1 migrations apply private-s-anand-net --remote
```

Recent accesses:

```sql
SELECT ts, email, path, key, status, ip, user_agent
FROM access_log
ORDER BY ts DESC
LIMIT 50;
```

Accesses by email:

```sql
SELECT ts, path, key, status, json_extract(cf, '$.country') AS country
FROM access_log
WHERE email = 'alice@gmail.com'
ORDER BY ts DESC
LIMIT 50;
```

Top paths:

```sql
SELECT path, COUNT(*) AS accesses, COUNT(DISTINCT email) AS signed_in_users
FROM access_log
WHERE ts >= datetime('now', '-30 days')
GROUP BY path
ORDER BY accesses DESC
LIMIT 20;
```

Status summary:

```sql
SELECT status, COUNT(*) AS accesses
FROM access_log
WHERE ts >= datetime('now', '-7 days')
GROUP BY status
ORDER BY accesses DESC;
```

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run locally with the real remote R2 bucket:

```bash
npx wrangler dev --port 8787 --env-file .env
```

Required secrets are read from `.env` for local development:

<!-- https://console.cloud.google.com/auth/clients/872568319651-r1jl15a1oektabjl48ch3v9dhipkpdjh.apps.googleusercontent.com?project=encoded-ensign-221 - root.node@gmail.com - Project: Personal mail etc - Client - Web apps -->

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_SECRET`

Set production Worker secrets:

```bash
bash -lc 'set -a; source .env; set +a; for name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET COOKIE_SECRET; do printf "%s" "${!name}" | npx wrangler secret put "$name"; done'
```

Deploy:

```bash
npx wrangler deploy
```

The OAuth callback URL configured in Google must be:

```text
https://private.s-anand.net/auth
```
