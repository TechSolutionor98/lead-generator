# GrabLeads

A practical B2B **lead-generation tool** for collecting **Russian business leads**
(computer shops, system integrators, service centers, component wholesalers,
mining-gear sellers) and exporting them to **CSV / Excel** — built for the UAE
hardware exporter **grabatoz.ae**.

It runs at **zero cost**. No paid API subscriptions are required.

---

## What it collects

| Source | How | Cost | Contacts |
| --- | --- | --- | --- |
| **Yandex Maps** | Playwright headless browser | Free | **name, phone, website, category, rating** — richest source |
| **OpenStreetMap** (Overpass) | Open-data API, no key | Free | name, phone, email, website, address, coords |
| **2GIS** | Public catalog JSON endpoint | Free *(needs a free key)* | name, address, category, rating — **no contacts** (phones/sites are a paid 2GIS add-on; use it for coverage) |
| **Avito** | Manual CSV/JSON import (no scraping) | Free | whatever your export contains |
| **Website enricher** | Visits each business's *own* website | Free | fills missing **email + phone** |

> **On contacts:** Yandex + OSM are the contact-rich sources (phone/website). 2GIS has the best *coverage* of Russian businesses, but its free key returns names/addresses only — real contacts require a paid 2GIS subscription. We do **not** scrape 2GIS pages for contacts (they are captcha-protected, and we don't solve captchas or bypass access controls). The website enricher recovers emails/phones from businesses' own sites.

Leads from all sources are **deduplicated** (by normalized phone → website
domain → name+address), persisted to **MongoDB**, and exportable.

### Only-new-leads on re-runs

Dedup is **global across every run**, not just within one search. The first run
that discovers a business "owns" it; if you re-run the **same city a day later**,
businesses found before are recognised and skipped — each run surfaces **only the
leads that are genuinely new** since last time. (Behind the scenes: one document
per unique business keyed by its fingerprint, with `firstJobId` marking the run
that first found it; a run's results are the leads whose `firstJobId` is that run.)

Want a full fresh pull instead? Clear the `leads` collection in your database
(e.g. in MongoDB Atlas → Collections → `grableads.leads` → drop), and the next
run treats everything as new again.

---

## Quick start

```bash
# 1. Install dependencies (root installs both workspaces)
npm install

# 2. Install the Chromium browser used by the Yandex scraper
npx playwright install chromium

# 3. Configure — set your MongoDB connection string (required), see below
cp .env.example .env
#    then edit .env and set MONGODB_URI=...

# 4. Run server (:5050) + client (:5173) together
npm run dev
```

## MongoDB setup (required)

GrabLeads stores jobs + leads in **MongoDB**. The easiest free option is
**MongoDB Atlas** (no credit card for the free M0 tier):

1. Create a free account + cluster at <https://www.mongodb.com/atlas>.
2. Create a **database user** (username + password) and, under **Network
   Access**, allow your IP (or `0.0.0.0/0` for any IP while testing).
3. Click **Connect → Drivers** and copy the connection string. It looks like:
   ```
   mongodb+srv://USER:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
4. Put it in `.env` (replace `<password>` with the real one):
   ```env
   MONGODB_URI=mongodb+srv://USER:yourpassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB=grableads
   ```

The database and its collections are created automatically on first write.
Prefer a **local MongoDB**? Set `MONGODB_URI=mongodb://localhost:27017` instead.

> If `MONGODB_URI` is left blank, the app still loads but collecting/exporting
> returns a clear "configure MONGODB_URI" message until you set it.

Open **http://localhost:5173**, pick sources + cities, keep the prefilled
queries, and click **Start collecting**. Export with the CSV / Excel buttons.

> Out of the box (no keys), **OpenStreetMap** and **Yandex** work immediately,
> plus **Avito** import. Add a free 2GIS key to enable 2GIS.

---

## Getting the (free) 2GIS key

2GIS requires a key, but a **free demo key** is enough — no payment.

1. Go to the 2GIS Platform Manager: <https://platform.2gis.com/> (or
   <https://dev.2gis.com/>) and sign up.
2. Create a **demo key** for the **Catalog / Places** API (free, ~1 month,
   renewable).
3. Put it in `.env`:
   ```env
   TWOGIS_WEB_KEY=your_key_here
   TWOGIS_API_HOST=catalog.api.2gis.com
   ```

Alternatively, you can use the **public web key** that `2gis.ru` sends to your
browser: open `2gis.ru`, search something, and in DevTools → Network copy the
`key=` value from a `catalog.api.2gis.ru` request. Then set:
```env
TWOGIS_WEB_KEY=that_public_key
TWOGIS_API_HOST=catalog.api.2gis.ru
```

### Yandex

No key or signup — the Yandex source drives a real Chromium browser over
`maps.yandex.ru`. If Yandex shows a SmartCaptcha, set `YANDEX_HEADLESS=false`
in `.env` and solve it in the window that opens; the scraper then continues.
**It never auto-solves captchas.**

---

## `.env` reference

See [`.env.example`](.env.example). Summary:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5050` | Backend port |
| `MONGODB_URI` | *(empty)* | **Required.** MongoDB Atlas (or local) connection string |
| `MONGODB_DB` | `grableads` | Database name inside the cluster |
| `TWOGIS_WEB_KEY` | *(empty)* | Free 2GIS key; empty = 2GIS source skipped |
| `TWOGIS_API_HOST` | `catalog.api.2gis.com` | 2GIS host (use `.ru` with a web key) |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass mirror |
| `YANDEX_HEADLESS` | `true` | `false` to watch / solve captcha |
| `PROXY_URL` | *(empty)* | Optional single HTTP(S) proxy for all outbound calls |
| `REQ_PER_SEC` | `5` | Per-source rate limit |
| `ENRICH_EMAIL` | `false` | Default for the email-enrich toggle |

> **Overpass tip:** the public endpoint is occasionally overloaded (HTTP 502/504).
> The adapter retries with backoff; if it stays busy, switch `OVERPASS_URL` to a
> mirror, e.g. `https://overpass.kumi.systems/api/interpreter`.

---

## Project layout

```
/server   Express + TypeScript API, adapters, SQLite, exporters, tests
/client   React + Vite + Tailwind dashboard
```

- Backend API: `POST /api/jobs`, SSE `GET /api/jobs/:id/events`,
  `GET /api/jobs/:id/leads`, `GET /api/jobs/:id/export?format=csv|xlsx`,
  `POST /api/import/avito`, `GET /api/sources`.
- Data store: **MongoDB** (`jobs`, `leads`, `geo_cache` collections).

---

## Adding a new source adapter

Every source implements one interface (`server/src/types.ts`):

```ts
interface LeadSource {
  id: string;
  name: string;
  enabled(): boolean;
  search(params: SearchParams): AsyncGenerator<Lead>;
}
```

To add one:

1. Create `server/src/sources/mysource.ts` exporting a `LeadSource`.
   Reuse the helpers: `http` (proxy-aware axios), `enqueue`/`withBackoff`
   (rate limit + retry), `finalizeLead` (phone normalize + individual tag),
   `cityGeo` (per-city bbox/center).
2. Register it in `server/src/sources/index.ts` (add it to the `ALL` array).

That's it — the job runner, API and UI pick it up automatically.

---

## Tests

```bash
cd server && npm test
```

Covers phone normalization (`8…`/`+7…` → E.164), dedup-key precedence, the
`isIndividual` heuristic, and the XLSX exporter (bold/autofilter header, frozen
row, phone-as-text, website hyperlinks, Summary sheet).

---

## Excel export

The `.xlsx` has a **Leads** sheet (bold + auto-filtered header, frozen top row,
auto-sized columns, phone column stored as **text** so `+7…` is preserved,
clickable website hyperlinks) and a **Summary** sheet with counts per source /
city / category.

---

## Compliance note

- **Business data only.** The tool is for collecting business contact details
  for B2B outreach. A heuristic flags likely individuals / sole traders (ИП),
  and the UI has a toggle to exclude them — relevant to Russia's **152-FZ**
  personal-data law. Do not use it to build datasets about private individuals.
- **Respect API / site terms.** OpenStreetMap is open data. 2GIS and Yandex are
  accessed in ways that **may violate their Terms of Service** — this is
  intended for your own authorized lead research; use responsibly and at your
  own risk. Avito is **not scraped** (manual import only).
- **No captcha-solving, no detection-evasion.** Scrapers are rate-limited and
  pause/surface on captcha rather than defeating it.
# lead-generator
