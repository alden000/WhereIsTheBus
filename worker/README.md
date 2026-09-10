# LTA DataMall proxy (Cloudflare Worker)

Holds your LTA DataMall `AccountKey` as a server-side secret and forwards
requests to `datamall2.mytransport.sg`, so the key never appears in the
frontend's JavaScript bundle or in this repo.

Two kinds of endpoint:

- **Live** — `bus-arrival` (arrival estimates change second to second, so
  it's always proxied straight through to LTA).
- **Cached** — `bus-stops`, `bus-services`, `bus-routes`. This reference
  data barely changes, so it's pulled into Cloudflare KV once a day by a
  cron trigger and served from there — the frontend never causes an LTA
  call for these.

Plus two maintenance endpoints:

- `cache/status` — returns `{ "lastUpdated": <ISO timestamp or null> }`.
- `cache/refresh?key=<REFRESH_SECRET>` — manually re-runs the same pull the
  cron does. Useful the first time (don't wait for 3am) or after changing
  which datasets are cached. Gated by a secret so the public can't use it
  to hammer your LTA quota.

## One-time setup

### If you deploy via `wrangler` (CLI)

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY     # your real LTA key
npx wrangler secret put REFRESH_SECRET      # any random string you pick
npx wrangler kv namespace create BUS_CACHE  # prints an id
```

Paste the printed id into `wrangler.toml`'s `[[kv_namespaces]]` block
(replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`), then:

```bash
npx wrangler deploy
```

The cron trigger (`[triggers]` in `wrangler.toml`, `0 19 * * *` UTC = 03:00
Singapore time) is picked up automatically on deploy.

### If you deploy via the Cloudflare dashboard

1. **KV namespace**: dashboard → **Storage & Databases** → **KV** → **Create
   namespace** (e.g. `whereisthebus-bus-cache`).
2. **Bind it**: your Worker → **Settings** → **Bindings** → **Add binding**
   → KV Namespace → variable name `BUS_CACHE` → select the namespace you
   just created → **Save and deploy**.
3. **Add the refresh secret**: **Settings** → **Variables and Secrets** →
   **Add** → type **Secret** → name `REFRESH_SECRET` → value: any random
   string you choose → **Save and deploy**.
4. **Cron trigger**: **Settings** → **Triggers** → **Cron Triggers** → **Add
   Cron Trigger** → expression `0 19 * * *` (03:00 Singapore time) → **Add**.
5. **Code**: paste the latest `src/index.ts` contents (converted to plain JS
   — see below) into **Edit code**, **Save and deploy**.

## First run

The cache stays empty (`cache/status` returns `lastUpdated: null`, and
`bus-stops` / `bus-services` / `bus-routes` return 503) until something
populates it. Don't wait for 3am the first time — trigger it manually:

```
https://<your-worker-url>/cache/refresh?key=<your REFRESH_SECRET>
```

Then check:

```
https://<your-worker-url>/cache/status
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in LTA_ACCOUNT_KEY and REFRESH_SECRET
npm run dev                       # runs at http://localhost:8787, with local KV
```

`.dev.vars` is gitignored — never commit it.

## Redeploying

Any time you change `src/index.ts`, run:

```bash
npx wrangler deploy
```
