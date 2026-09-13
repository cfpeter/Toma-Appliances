# Toma Appliances — Technical Plan

**Status:** v2 — Phases 0 and 1 built and verified against the live database
**Last updated:** 2026-08-30
**Companion doc:** [REQUIREMENTS.md](./REQUIREMENTS.md)

---

## 1. What We're Actually Building

Not e-commerce. Not a brochure site. It's **a public catalog with a private
back-office** — two apps that share one database.

```
┌─────────────────────────────────────────────────────────────┐
│                    tomaappliances.com                        │
│                  (Cloudflare Workers + CDN)                  │
├──────────────────────────┬──────────────────────────────────┤
│   PUBLIC CATALOG         │   ADMIN  /admin/*                │
│   No login               │   Login required                 │
│   Cached at the edge     │   Never cached                   │
│   SEO-critical           │   Mobile-first                   │
│   Static-ish HTML        │   React islands                  │
└──────────────┬───────────┴───────────────┬──────────────────┘
               │                           │
               ▼                           ▼
        ┌──────────────┐            ┌──────────────┐
        │  Supabase    │            │ Cloudflare   │
        │  Postgres    │            │     R2       │
        │  + Auth      │            │   (photos)   │
        └──────────────┘            └──────────────┘
```

The asymmetry matters. The public side is read-only, hit by strangers and Google, and
must be fast — so it gets cached aggressively at Cloudflare's edge and rarely touches
the database. The admin side is one person doing writes and never gets cached at all.
Building them as one project but treating them as opposites is the core decision here.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| **Framework** | **Astro 7** | Ships zero JS by default — the public catalog is plain HTML, which is exactly what Google wants. React only where it's needed. Already familiar from Boyles Flooring. |
| **Interactive UI** | **React 19** islands | Only inside `/admin`. The public site loads none of it. |
| **Language** | **TypeScript** (strict) | Money and inventory math — the compiler catching a `string` where a cent-count belongs is worth the setup. |
| **CSS** | **Tailwind v4** | Same as the flooring site. CSS-first config via `@theme`, no `tailwind.config.js`. |
| **UI primitives** | **Radix UI** (headless) | Only for dialogs, dropdowns, and popovers where accessibility is fiddly. Everything else is hand-written Tailwind. |
| **Charts** | **Recharts** | Dashboard only, lazy-loaded, admin-only — its bundle size never reaches a customer. |
| **Database** | **Supabase Postgres** | Real SQL for the reporting queries. Row Level Security as a backstop. |
| **Auth** | **Supabase Auth** + `@supabase/ssr` | Cookie sessions that work in the Workers runtime. Invite-only, no public signup. |
| **File storage** | **Cloudflare R2** | 10 GB free, **zero egress fees**. S3-compatible API. |
| **Hosting** | **Cloudflare Workers** (static assets) | Cloudflare's recommended path for new projects; the Git integration is the same one you'd know as Pages. |
| **DNS + domain** | **Cloudflare Registrar** | At-cost pricing, no renewal markup, DNS already in the same account. |
| **Code** | **GitHub** (private) | Auto-deploy on push. |
| **Lint/format** | **Biome** | One tool instead of ESLint + Prettier. Fast, near-zero config. |
| **Adapter** | `@astrojs/cloudflare` | Runs Astro SSR on the Workers runtime. |

### Rejected, and why

- **Next.js** — works on Cloudflare via OpenNext, but it's a heavier toolchain for a
  site that's 90% static product pages. Astro is the better fit and the one already known.
- **Vercel** — a second vendor, a second bill, a second dashboard, for zero gain when
  Cloudflare hosts this fine.
- **Supabase Storage for photos** — 1 GB free vs. R2's 10 GB, and it bills egress.
  On a photo-heavy public site egress is the bill that ambushes you.
- **Cloudflare Images** ($5/mo) — it does resizing for you, but generating three sizes
  in the browser before upload is free and works just as well at this scale.
- **Cloudflare D1** — Cloudflare's own SQLite database, and a genuinely tempting
  "everything under one roof" option with a generous free tier (5 GB, 5M reads/day).
  Rejected for one decisive reason: **D1 is only a database.** No user accounts, no
  password handling, no sessions, no reset emails, no invite flow — all of it would be
  hand-built, and authentication is the last thing worth hand-building. It also has no
  row-level security, so every "the public must not see costs" check would live in
  application code and would have to be correct every single time, with no database
  backstop. The all-Cloudflare route (D1 + Better Auth) is viable but trades a proven
  free auth system for a third-party library plus roughly two extra weeks of work, and
  still isn't truly single-vendor. Both options cost $0, so this came down purely to
  what's included — revisit only if the Supabase dependency becomes a real problem.
- **shadcn/ui** — copies a large component library into the repo. Overkill for roughly
  a dozen admin screens.

---

## 3. Rendering Strategy — the key decision

Different rules for the two halves:

### Public pages — SSR, then cached hard at the edge

```
Cache-Control: public, s-maxage=60, stale-while-revalidate=86400
```

Cloudflare serves cached HTML from the edge for 60 seconds, and keeps serving the
stale copy while it fetches a fresh one in the background. Practically:

- A visitor almost always gets HTML straight from a nearby Cloudflare server — no
  database call, no cold start, sub-100 ms
- Supabase sees a trickle of traffic no matter how popular the site gets
- Publishing a change appears within a minute, with **no rebuild**

**Why not fully static?** Because quantities and statuses change constantly. Marking a
dryer sold shouldn't require a site rebuild and a two-minute wait. Edge caching gets
static-level speed without the staleness.

For anything that must be instant (publishing a new product), the deploy also supports
**purge-by-URL** through the Cloudflare API — we call it on publish and the page
updates immediately.

### Admin pages — never cached

```
Cache-Control: private, no-store
```

Always fresh, always authenticated, never stored at the edge or in the browser.

---

## 4. Project Structure

```
toma-appliances/
├── docs/
│   ├── REQUIREMENTS.md
│   └── TECHNICAL_PLAN.md
├── samples/                      # real B-Stock manifests for testing
├── supabase/
│   └── migrations/               # versioned SQL — the schema lives in git
├── src/
│   ├── pages/
│   │   ├── index.astro
│   │   ├── [category]/
│   │   │   ├── index.astro
│   │   │   └── [subcategory]/
│   │   │       ├── index.astro
│   │   │       └── [product].astro
│   │   ├── about.astro, hours.astro, delivery.astro,
│   │   │   warranty.astro, contact.astro
│   │   ├── sitemap.xml.ts
│   │   ├── admin/
│   │   │   ├── index.astro           # dashboard
│   │   │   ├── products/
│   │   │   ├── import/
│   │   │   ├── lots/
│   │   │   ├── reports/
│   │   │   └── settings/
│   │   └── api/                      # server endpoints
│   │       ├── upload-url.ts         # presigned R2 upload
│   │       ├── purge-cache.ts
│   │       └── ...
│   ├── components/
│   │   ├── public/               # .astro — zero JS
│   │   └── admin/                # .tsx — React islands
│   ├── lib/
│   │   ├── supabase/             # client, server, types
│   │   ├── import/               # CSV parse, match, allocate
│   │   ├── money.ts              # cents helpers
│   │   ├── slug.ts
│   │   └── r2.ts
│   ├── middleware.ts             # auth guard for /admin/*
│   └── styles/global.css         # Tailwind v4 @theme
├── public/                       # favicon, manifest, icons
├── astro.config.mjs
├── wrangler.toml
└── .env.example
```

---

## 5. Database Schema

Postgres, in `supabase/migrations/` so the schema is versioned in git — never
hand-edited in a dashboard.

### Core tables

```
profiles          id, email, name, role, active, created_at
                  → mirrors auth.users; role exists for future use,
                    everyone is full-access today

categories        id, parent_id, name, slug, sort_order, active
                  → self-referencing; Laundry → Washers

products          id, item_no, upc, brand, model, name, slug,
                  description, category_id, condition,
                  msrp_cents, price_cents, status,
                  created_at, updated_at
                  → item_no is the B-Stock match key (unique)
                  → condition is PRIVATE, never rendered publicly
                  → status: draft | active | sold | hidden | deleted

product_photos    id, product_id, r2_key, sort_order, alt_text, width, height

lots              id, lot_code, source, vendor, purchase_date,
                  bid_cents, premium_cents, freight_cents,
                  landed_cost_cents, notes
                  → one truckload / pallet purchase

stock_lines       id, product_id, lot_id, condition,
                  qty_received, unit_cost_cents
                  → the private layer under each product;
                    unit_cost_cents comes from lot allocation

sales             id, product_id, stock_line_id, qty,
                  sale_price_cents, sold_at, created_by
                  → qty + price only, per the requirements

imports           id, lot_id, filename, row_count, imported_at, imported_by
import_rows       id, import_id, raw jsonb, item_no, matched_product_id, action
                  → raw holds the ENTIRE original CSV row, forever

category_map      id, source_category, source_seller_category, category_id
                  → LAUNDRY_APPLIANCES + Washers → Laundry/Washers

settings          key, value jsonb
                  → markup rules, business info, hours, contact
```

### Three rules that are not negotiable

**1. All money is integer cents.** `price_cents INTEGER`, never `FLOAT` or `NUMERIC`
guessing. Floating-point money silently drifts, and cost allocation across 61 units
divides repeatedly — exactly where drift shows up. All arithmetic in cents, formatted
for display only.

**2. Quantity is derived, never stored.**

```sql
qty_available = SUM(stock_lines.qty_received) - SUM(sales.qty)
```

A `qty` column that gets written by three different code paths *will* drift out of sync
with reality. A view can't. At 500 products the performance difference is nil.

**3. Nothing is ever hard-deleted.** `status = 'deleted'` hides it everywhere. Sales
and import history stay intact so last year's profit report keeps telling the truth.

### Cost allocation

```
unit_cost_cents = landed_cost_cents
                × (msrp_cents × qty) ÷ lot_total_retail_cents
                ÷ qty
```

Computed once when the lot cost is entered, then written to `stock_lines`. Frozen at
that moment — later edits to MSRP must not silently rewrite the cost of goods already
sold.

### Row Level Security

RLS is on for every table. Policy today: **authenticated users get full access, the
public gets read-only access to `status IN ('active','sold')` products and their
photos.** Everything else — costs, lots, sales, imports — is invisible without a login,
enforced by the database itself rather than by remembering to check in the UI.

---

## 6. Auth

- Supabase Auth, email + password
- `@supabase/ssr` for cookie-based sessions (works in the Workers runtime; the
  localStorage-based browser client does not)
- `src/middleware.ts` guards every `/admin/*` route and redirects to login
- **Signup disabled in the Supabase dashboard.** Accounts exist only by invitation.
- RLS as the second layer, so a routing mistake can't leak data

---

## 7. Image Pipeline

The part most likely to be slow and expensive if done naively, so:

**In the browser, before anything uploads:**
1. Read the camera photo (often 4 MB, 4032 px wide)
2. Resize to three WebP versions on a canvas:
   - `thumb` 400 px (~25 KB) — grids
   - `card` 800 px (~70 KB) — listings
   - `full` 1600 px (~180 KB) — detail view
3. Upload all three

**Why client-side:** the phone does the work for free, and the warehouse only uploads
~275 KB instead of 4 MB. On bad wifi that's the difference between usable and not.

**Upload path:** the browser POSTs the three WebPs to `/api/admin/photos`, which writes
them through the **R2 binding** (`env.PHOTOS`) and then inserts one `product_photos`
row. If the row fails to insert, the objects just written are deleted again — an
object nothing points at is invisible, un-deletable through the UI, and still billed.

Presigned direct-to-R2 uploads were the original plan, to keep bytes out of the
Worker. Dropped, because the resize step already got the payload down to ~275 KB, and
a binding needs no account ID, no access keys, no CORS configuration, and — via
`platformProxy` — **works in `astro dev` against a local store**, so photo upload could
be built and tested before any Cloudflare account existed. Revisit only if originals
ever need uploading.

**Serving:** `/img/<key>` reads from the binding, with `immutable` cache headers, so it
works locally and on a fresh deploy. Once the bucket is bound to
`img.tomaappliances.com`, `PUBLIC_IMAGE_BASE_URL` points there and that route goes
quiet. Zero egress cost either way.

**Auth:** `/api/admin/*` is behind the same session guard as `/admin/*` (see
`src/middleware.ts`) and answers 401 as JSON rather than redirecting to a login page.

**Key layout:** `products/{product_id}/{uuid}-{size}.webp`

---

## 8. Import Pipeline

Five stages, in `src/lib/import/`:

1. **Parse** — CSV → rows. Strip trailing commas from UPCs, coerce numbers, keep the
   raw row untouched alongside the cleaned one.
2. **Extract** — pull the model number out of `Item Description` via regex
   (`SS WF45T6000AW 4.5CUFT` → `WF45T6000AW` + `4.5 cu. ft.`), then build a readable
   name from brand + capacity + category.
3. **Match** — `item_no` → `upc` → model. Produces `new` / `match` / `skip`.
4. **Review** — the human step. Nothing writes to `products` until confirmed.
5. **Commit** — write `import_rows` (raw preserved), create or update products as
   Draft, create `stock_lines`, then allocate lot cost once the bid is entered.

**Validation flags** surfaced on the review screen: no model number extracted,
unmapped category, MSRP wildly outside the norm, quantity of zero, duplicate `item_no`
within the same file.

---

## 8a. Verified Against Two Real Manifests

Both sample lots — a pure-Samsung truckload (`ONT-6954689`, 31 lines / 61 units) and a
mixed LG / Samsung / Electrolux load (`BRI-6798213`, 48 lines / 56 units) — were parsed
and compared. What that changed:

- **Column layout is identical across marketplaces.** One parser covers all of B-Stock;
  source profiles are needed only for category mapping and description conventions,
  not for columns.
- **`Item #` is stable across auctions.** Four Item #s appear in both manifests with
  matching descriptions — confirming it as the dedupe key.
- **⚠️ But MSRP is NOT stable.** Item #1932499 is `$1,179.99` in one manifest and
  `$1,329.99` in the other. Allocation therefore reads `stock_lines.msrp_cents` — that
  lot's own figure — never the product's latest value.
- **Condition vocabulary is richer than expected** — `USED` and `USED_FAIR` across just
  two lots, so `condition_raw` keeps the manifest's exact wording beside the mapped enum.
- **The `Brand` column is sometimes blank** (6 Electrolux rows). Fallback chain:
  `Brand` → description prefix (`SS`, `LG`, `EL`, `MD`, `GE`, `HS`) → `Vendor`.
- **Categories observed and seeded:** `LAUNDRY_APPLIANCES` (Washers, Dryers, Laundry
  Suites), `KITCHEN_APPLIANCES` (Refrigerators, Ranges, Dishwashers, Freezers),
  `MIXED_MAJOR_APPLIANCES` (Appliances, Major Appliances).

**Cost allocation was tested end-to-end** against the real Samsung manifest with a
$13,550 landed cost: 31 line items, 61 units, $54,705.39 total MSRP (matching the
filename exactly), and the $719.99 washer landing at **$178.33 per unit**. The test ran
inside a rolled-back transaction — nothing was written.

## 9. URLs

| Path | Purpose |
|---|---|
| `/` | Home — newest arrivals, categories |
| `/laundry` | Category |
| `/laundry/washers` | Subcategory, filterable |
| `/laundry/washers/samsung-wf45t6000aw` | Product detail |
| `/about`, `/hours`, `/delivery`, `/warranty`, `/contact` | Info pages |
| `/sitemap.xml`, `/robots.txt` | SEO |
| `/admin/*` | Back office |
| `/api/*` | Server endpoints |

Slugs are generated as `brand-model`, deduped with a numeric suffix, and **frozen once
published** — changing a live URL throws away its Google ranking.

---

## 10. Environment & Secrets

Every variable here is read by something. Blanks that nothing consumes were
removed — an empty variable with no reader is just an invitation to go hunting
for a value that was never needed.

```
# The deployed Worker needs these
PUBLIC_SUPABASE_URL              # safe in the browser
PUBLIC_SUPABASE_PUBLISHABLE_KEY  # sb_publishable_… — safe; RLS protects the data
PUBLIC_SITE_URL                  # canonical origin
PUBLIC_IMAGE_BASE_URL            # blank ⇒ /img serves from the R2 binding;
                                 # set to https://img.<domain> once one exists

# Local tooling only — migrations, the importer, the test suite. Never deployed.
SUPABASE_DB_HOST                 # pooler host (IPv4)
SUPABASE_DB_PASSWORD             # 🔴 SECRET
SUPABASE_SECRET_KEY              # 🔴 SECRET — no longer read by the app
```

Removed as dead: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` (wrangler's
own OAuth session does this work), `R2_BUCKET` and `CLOUDFLARE_ACCOUNT_ID`
(the bucket is named in `wrangler.jsonc`, the account comes from `wrangler
whoami`), and the R2 access keys (the binding needs none).

`import.meta.env` reads non-public variables from the Worker environment at
runtime — verified against a production build, the values are not compiled
into the bundle — so `wrangler secret put` is the way to supply them.

`.env` is gitignored; `.env.example` is committed with empty values. Secrets live in
Cloudflare's dashboard, never in the repo. **The secret key bypasses Row Level
Security entirely** — anyone holding it can read and delete everything, so it is used
only in server endpoints and never sent to a browser.

> **Note on key naming:** Supabase renamed its API keys. New projects issue
> `sb_publishable_…` and `sb_secret_…`; older projects call the same two keys "anon"
> and "service_role" and issue them as long JWTs. Same roles, different names — this
> project uses the new naming.

---

## 11. Deployment

**GitHub (private) → Cloudflare, automatic on push.**

- `main` → production at `tomaappliances.com`
- any other branch → a private preview URL, so changes can be checked on a phone
  before customers see them
- Build: `npm run build` → `dist/`
- A failed build leaves the previous version live; a bad push cannot take the site down

Database changes ship as SQL migration files in `supabase/migrations/`, applied via the
Supabase CLI — reviewable in git, repeatable, and never a mystery click in a dashboard.

> 🔑 **SSH reminder:** the GitHub key on this machine is scoped to a single repo. This
> new repo needs its own deploy key and its own `Host` alias in `~/.ssh/config`, or the
> first push fails with a misleading permission error.

---

## 12. Conventions & Known Traps

- **Money in cents, everywhere.** See §5.
- **⚠️ `preview_bucket_name` renames the LOCAL R2 store, not just the remote one.**
  Miniflare keys its on-disk store by that name and indexes objects in a sqlite file
  named after a hash of it, so adding or removing the field strands every object
  already written: the blobs stay on disk, unreachable, and rows in `product_photos`
  become broken images. Leave it unset so the local namespace matches `bucket_name`.
- **⚠️ Disabling a submit button in its own `submit` handler drops its
  `name`/`value`.** A disabled control is excluded from the submitted form data, and
  that includes the button just pressed. The busy-state helper disabled every button
  in the form, so `intent=sell` never reached the server and the handler fell through
  to its default branch — which blanked every product field the sale form did not
  contain. `markBusy` now copies the submitter's name/value into a hidden input first,
  and POST handlers refuse a submission missing the fields they intend to write.
- **⚠️ `security_invoker` views silently zero out aggregates.** `product_stock` sums
  `stock_lines` and `sales`; as an invoker view it recomputed under the caller's RLS,
  and `anon` has no policy on either table, so every public quantity read 0 while the
  admin saw the right number. Nothing errors — the join just finds nothing. Anything
  the public reads goes through `catalog`, which is a definer view whose own `where`
  clause is the gate. Test permission-sensitive SQL **as `anon`**, not as the owner.
- **Revoke, don't just rely on RLS.** Supabase grants `anon` a blanket table grant on
  the public schema, so a single mistaken `create policy … to anon` would have exposed
  purchase prices. Cost-bearing tables are revoked outright (0018).
- **⚠️ Never gitignore `src/`.** Tailwind v4 skips gitignored paths when scanning for
  class names, so an over-broad ignore rule ships a completely unstyled site — and it
  builds "successfully" while doing it.
- **Workers is not Node.** No `fs`, no `Buffer` by default. Every dependency must be
  edge-compatible; check before adding one.
- **Supabase free tier pauses after 7 days idle.** A Cloudflare Cron Trigger pings it
  weekly. Free, and prevents a dead site during a slow stretch.
- **Astro 7 requires Node >= 22.12** and refuses to start on anything older.
- **The direct database host `db.<ref>.supabase.co` is IPv6-only** and unreachable from
  an IPv4-only network, failing with a misleading DNS error. Migrations connect through
  the IPv4 pooler instead: `aws-0-us-west-1.pooler.supabase.com:5432` (session mode —
  port 6543 is transaction mode and cannot run DDL). Stored as `SUPABASE_DB_HOST`.
- **Homebrew cannot build from source here** — Xcode 15.2 is too old for current
  formulae. The Supabase CLI is installed as an npm devDependency instead of via brew.
- **Integer-cent allocation always leaves a remainder** (measured: 2¢ across 61 units
  on a $13,550 truckload). Recorded in `lots.allocation_residual_cents` rather than
  hidden inside a fudged unit cost, so lot P&L reconciles exactly.
- **Public pages must ship zero JavaScript.** No React on the customer side. Filters
  and search work as plain form submissions with server-rendered results — faster,
  and Google indexes every filtered view.
- **Generated types.** `supabase gen types typescript` produces the TS definitions, so
  a schema change surfaces as a compile error rather than a runtime surprise.

---

## 13. Phase 0 & 1 — Concrete Task List

### Phase 0 — Foundation
1. Register `tomaappliances.com` on Cloudflare *(check availability first)*
2. Create the private GitHub repo `toma-appliances`, add deploy key + SSH host alias
3. Create the Supabase project (US West, closest to LA)
4. Create the R2 bucket + bind `img.tomaappliances.com`
5. Scaffold Astro + TypeScript + Tailwind v4 + Biome + Cloudflare adapter
6. Connect GitHub → Cloudflare, wire environment variables
7. Attach the custom domain, verify SSL
8. **Done when:** a placeholder page is live on the real domain and `git push` deploys it

### Phase 1 — Data & Login
1. Write the migration for all tables in §5
2. Views for `qty_available` and product listings
3. RLS policies — public reads active/sold products, authenticated reads everything
4. Seed the category tree and the `category_map` for the known B-Stock values
5. Supabase Auth wiring, `@supabase/ssr`, `middleware.ts` guard
6. Login page, password reset, disable public signup
7. Generate TypeScript types
8. **Done when:** login works and the schema is final
