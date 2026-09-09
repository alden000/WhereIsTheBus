# LTA DataMall proxy (Cloudflare Worker)

Holds your LTA DataMall `AccountKey` as a server-side secret and forwards
allowed requests to `datamall2.mytransport.sg`, so the key never appears in
the frontend's JavaScript bundle or in this repo.

Allowed endpoints (add more to `ALLOWED_ENDPOINTS` in `src/index.ts` as
needed): `bus-arrival`, `bus-services`, `bus-routes`, `bus-stops`.

## One-time setup (run these yourself — they need your Cloudflare account)

```bash
cd worker
npm install

# Opens a browser to log in to (or create) a free Cloudflare account
npx wrangler login

# Stores your real LTA API key as an encrypted secret on Cloudflare.
# It is never written to disk in this repo.
npx wrangler secret put LTA_ACCOUNT_KEY
# (paste your key when prompted)

npx wrangler deploy
```

`wrangler deploy` prints the live URL, something like:

```
https://whereisthebus-lta-proxy.<your-subdomain>.workers.dev
```

That's the URL the frontend will call instead of LTA DataMall directly.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in a real or dummy key
npm run dev                       # runs at http://localhost:8787
```

`.dev.vars` is gitignored — never commit it.

## Redeploying

Any time you change `src/index.ts` (e.g. to allow a new LTA endpoint), run:

```bash
npx wrangler deploy
```
