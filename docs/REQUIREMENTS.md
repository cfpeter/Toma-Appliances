# Appliance Store — Requirements & Build Plan

**Status:** v2 — core requirements settled, ready to build
**Last updated:** 2026-08-30
**Project folder:** `/Users/bedopapajanian/Work/appliance-store`

---

## 1. Business Context

The owner buys appliances at wholesale liquidation auction (B-Stock and similar) —
truckloads and pallets of used / open-box / scratch & dent units from manufacturers
like Samsung. He resells them locally in the Greater Los Angeles area.

**The problem:** inventory currently lives in handwritten notes. There is no way to
know what's in stock, what it cost, what it sold for, or whether a given truckload
was profitable. Customers have no way to see what's available.

**The solution:** a public catalog website plus a private admin system.

### What this is NOT

This is deliberately **not** e-commerce. There is:

- No shopping cart
- No checkout
- No payment processing
- No customer accounts or customer login
- No shipping calculation
- No order management

The public site is a **catalog**. Customers browse, find something they want, and
**text or call**. The sale happens in person. This keeps the build small, removes all
PCI/payment liability, and matches how the business actually operates.

---

## 2. The Two Sides

| | Public Site | Admin |
|---|---|---|
| **Who** | Anyone, no login | Owner + staff, login required |
| **Purpose** | Browse inventory, contact the seller | Run the business |
| **Sees** | Photos, name, category, your price | Everything, including cost and profit |
| **Device** | Mostly phone | Phone (warehouse) + laptop (office) |

---

## 3. Confirmed Decisions

### 3.1 Product model

**A product is a MODEL with a QUANTITY**, not an individual physical unit.

A truckload might contain 4 identical Samsung dryers. That is **one product with
qty 4**, not four separate listings. Selling one decrements the quantity to 3.

Underneath each product sits a private **stock breakdown** — condition, how many at
that condition, what they cost, and which lot they came from. The public sees one
clean listing. The owner sees the detail.

**Condition is public** *(reversed 2026-09-13 — see decision 21)* — shown on every
listing, and the owner can override the imported grade per product. Recorded per
stock line for the owner, formerly never shown to
customers and not filterable. The structure still allows exposing it later by flipping
a switch, should that ever change.

### 3.2 The four prices

Every product carries four separate money figures, and they each do a different job.
Mixing them up is the single easiest way to make every report wrong.

| Field | Source | Example | Visibility |
|---|---|---|---|
| **Cost** | Allocated from what you paid for the lot | $178 | 🔒 Owner only |
| **MSRP** | `Unit Retail` column in the manifest | $719.99 | 🔒 Owner only |
| **Your price** | You set it, manually or from a suggestion | $425 | 🌐 Public |
| **Sold for** | What it actually went for | $400 | 🔒 Owner only |

> ⚠️ **Critical:** `Unit Retail` in the B-Stock manifest is the **manufacturer's MSRP,
> not your cost.** Verified against the sample file: `Ext. Retail = Qty × Unit Retail`
> on every row, totalling $54,705.39 — which matches the retail figure in the filename.
> Your real cost is your **winning bid on the truckload**, which does not appear in the
> manifest at all. See §7.3.

### 3.3 Item status

Every product has exactly one status:

| Status | Public sees it | Meaning |
|---|---|---|
| **Draft** | No | Imported or created, not priced yet |
| **Active** | Yes | Live and available |
| **Sold** | **Yes — with a SOLD badge** | All units sold |
| **Hidden** | No | Pulled from the site, kept in records |
| **Deleted** | No | Soft-deleted — invisible everywhere, history preserved |

**Quantity drives status.** 4 in stock, sell 1 → qty 3, still Active. When qty hits 0
it flips to **Sold** automatically. The owner can always override manually.

**Sold items stay on the public site** with a clear SOLD badge. Each product page
accumulates Google ranking over time, so removing them would throw that away and leave
dead links — and visible sold stock shows customers that inventory actually moves.

**Delete is a soft delete.** The record disappears from all screens but the underlying
import row and sales history survive, so deleting an item can never silently corrupt
last year's profit numbers.

### 3.4 Photos

- Multiple per item, up to ~10
- First photo is the thumbnail; drag to reorder
- **No watermark**
- Uploaded straight from the phone camera in the warehouse
- **Auto-compressed on upload** — a 4 MB iPhone photo becomes ~200 KB at web
  resolution, plus a small thumbnail. Invisible quality difference on screen,
  ~20× less storage, and faster pages (which helps Google ranking).

### 3.5 Users

**One role: full access.** Everyone who can log in sees everything — cost, profit,
reports, the lot. There is no staff tier and no restricted view. This is a one-person
business today, and splitting permissions would add complexity for no benefit.

The system still uses **real accounts rather than one shared login**, so a second
person can be added later without a rebuild:

- **No public signup.** Accounts are created by invitation only.
- Invite by email; the invitee sets their own password.
- Accounts can be deactivated instantly.
- A `role` column exists on the user record so a restricted tier *could* be added
  later — but no permission tiers are being built now.

### 3.6 Language

**English only.**

### 3.7 Recording a sale

Marking an item sold captures **quantity and sale price only**. The date is stamped
automatically. No customer name, no phone number, no buyer history — the business
doesn't need it, and storing personal data creates obligations it doesn't want.

---

## 4. Public Website

### 4.1 Pages

- **Home** — featured / newest arrivals, category entry points
- **Category** → **Subcategory** → **Product listing**
- **Product detail** — photo gallery, name, brand, model, price, contact buttons
- **About**
- **Store Hours**
- **Delivery Info**
- **Warranty / Returns**
- **Contact**

### 4.2 Browsing

- Category → subcategory navigation
- **Filters:** category, subcategory, brand, price range
- **Keyword search** across name, brand, model number, description
- **Sort:** newest, price low→high, price high→low
- **Quantity is shown as the actual number** — "4 in stock"

> **Condition IS shown publicly** as of 2026-09-13. It is still recorded per stock
> line for the owner only.

### 4.3 Contact — no forms

There is no contact form and no stored inquiries. Every product page has three
tap-to-act buttons: **Text · Call · Email**.

Tapping **Text** opens the customer's own messaging app with the message
**pre-filled**:

> "Hi, I'm interested in: Samsung 4.5 cu. ft. Front Load Washer (WF45T6000AW) — $425"
> `https://yoursite.com/laundry/washers/samsung-wf45t6000aw`

They just hit send. The owner instantly knows which item they mean. Email works the
same way, with the item in the subject line.

### 4.4 SEO

Full Google indexing is a priority. Nobody else in this market is putting liquidation
appliance inventory online with proper product pages.

- Clean URLs — `/laundry/washers/samsung-wf45t6000aw`
- Unique title and meta description per product, auto-generated
- **Product structured data** (JSON-LD) with price and availability, so listings can
  win rich results with the price showing directly in Google
- Auto-generated `sitemap.xml`, updated as inventory changes
- Descriptive image alt text
- Fast static delivery from CDN — page speed is a ranking factor
- **Google Business Profile** registered as a *service-area business* — this gives the
  address to Google for verification while keeping it hidden from the public listing.
  Best of both worlds for "appliance store near me" searches.

---

## 5. Admin — Mobile (Warehouse)

Designed for one-thumb use while standing in front of an appliance.

**Add a product:**
1. Tap **+ Add**
2. Camera opens — shoot 4–6 photos
3. Fill: brand · model · category · condition · quantity · price
4. Save

**Quick actions:**
- Search inventory
- **Mark sold** — enter what it actually sold for
- Adjust quantity
- Add photos to an existing item

**Installs to the home screen** like a real app — full screen, no browser bar. No App
Store, no approval process, no extra cost.

---

## 6. Admin — Desktop (Office)

- **Import manifests** (§7)
- **Bulk pricing grid** — one table, all newly imported items, tab down the column
  typing prices, save once. Pricing a 31-line truckload takes two minutes, not an hour.
- Full product editing — descriptions, categories, photo management
- **Dashboard and reports** (§8)
- **User management** — invite, deactivate

---

## 7. Import (B-Stock Manifests)

### 7.1 Source format

CSV download from B-Stock. Columns are consistent across lots.
Sample: `samples/bstock-manifest-ONT-6954689.csv` (31 line items, 61 units).

| CSV Column | Maps to | Notes |
|---|---|---|
| `Item #` | 🔑 **Product match key** | Stable per model — the dedupe key |
| `Lot ID` | Purchase lot | `ONT-6954689` groups the truckload |
| `Item Description` | → parsed → model + name | Cryptic, needs parsing |
| `Qty` | Stock quantity | |
| `Unit Retail` | MSRP (private) | Drives cost allocation |
| `Ext. Retail` | Recomputed, not trusted | |
| `UPC` | Product | Has a trailing comma to strip |
| `Vendor` | Lot metadata | Often truncated |
| `Brand` | Brand | Clean as-is |
| `Category` | → top-level category | `LAUNDRY_APPLIANCES` → Laundry |
| `Seller Category` | → subcategory | Washers / Dryers |
| `Condition` | Condition | `USED` throughout the sample |
| `Notes/Comments` | Product notes | Empty in the sample |
| `Pallet ID` | Lot metadata | Unreliable, see §7.5 |

**Every imported row is stored raw and untouched**, with all IDs and all fields —
including ones we don't currently display. If B-Stock sends 30 fields and we show 8,
the other 22 are still there. The live catalog is built *from* that raw layer, never
replacing it. Nothing ever has to be re-imported.

### 7.2 Matching — the Item # advantage

`1446987` is Samsung's WF45T6000AW. Buy that same washer on a different truckload next
month and it arrives with the same `Item #` — so the system recognizes it and **adds to
the existing product's quantity** instead of creating a duplicate listing.

Match order: `Item #` → `UPC` → parsed model number.

### 7.3 Lot cost allocation

The manifest never contains what you paid. After importing, the owner enters the real
numbers for that lot:

```
Winning bid        $11,500
Buyer premium      $ 1,150
Freight            $   900
─────────────────────────
Landed cost        $13,550
```

The system spreads that across all 61 units **proportional to retail value** —
expensive units absorb more cost, cheap ones less.

Example: the $719.99 washer represents 1.316% of the lot's $54,705.39 retail, so it
absorbs 1.316% of $13,550 = **$178 cost per unit**. List at $425, sell at $400, and the
dashboard reports **$222 real profit** — not a guess.

This also produces **profit per truckload**, so the owner learns which auctions and
which sellers are actually worth bidding on.

### 7.4 Review before publish

**Nothing publishes automatically.** After upload, a review table appears — one row per
line item, with a suggested action the owner can override:

- 🟢 **New** — unseen `Item #`, creates a product
- 🔵 **Match** — already in catalog, adds to quantity
- ⚪ **Skip** — not wanted (e.g. a $32.99 stack kit)

Rows are flagged when something looks off: no model number extracted, unmapped
category, price far outside the usual range.

On confirm, everything lands as **Draft** — invisible to the public until priced.

### 7.5 Known data-quality issues

Real problems found in the sample file that the importer must handle:

1. **Descriptions are not customer-facing.** `SS WF45T6000AW 4.5CUFT` must become
   *"Samsung 4.5 cu. ft. Front Load Washer — Model WF45T6000AW"*. Model number and
   capacity parse reliably; brand and appliance type come from the category. The owner
   reviews and corrects outliers.
2. **Not everything is an appliance.** The sample contains a $32.99 stack kit and four
   laundry pedestals, dumped under a junk subcategory called "Appliances." These need
   to route to **Accessories**, not sit beside the dryers.
3. **The file contradicts itself.** `Pallet ID` reads "51 Units" but the rows sum to
   **61**, matching the filename. Rule: always compute from the rows, never trust
   embedded text.
4. **UPCs carry a trailing comma** — `"499996773973,"` — and may hold multiple values.
5. **Category values are raw enums** (`MIXED_MAJOR_APPLIANCES`). A category mapping
   table, editable by the owner, translates source values to clean public categories.
6. **Two descriptions contain an unexplained `@`** — see open question 6.

### 7.6 Suggested pricing

The system pre-fills a suggested price that the owner overwrites at will.

- **Preferred rule:** cost × markup multiplier (honest about real margin)
- **Fallback** before lot cost is entered: percentage of MSRP
- Configurable globally, with per-category overrides

---

## 8. Reporting

All reports are **owner-only** — they contain cost and profit.

**Dashboard:**
- Units in stock · inventory value at cost · potential value at listed prices
- Sold this month — units, revenue, profit
- Sales chart over time
- **Growth vs. previous month**
- Top categories, best and worst movers
- Recent activity

**Reports (date-range selectable, each with a Download CSV button):**
- Monthly sales — item, qty, listed price, actual sale price, cost, profit, date
- Profit per truckload
- Current inventory

**Export scope is deliberately narrow.** No marketplace exports, no accounting
integration, no Facebook/eBay feeds. Reports out as CSV, nothing more.

---

## 9. Technical Stack

| Job | Service | Free tier | Cost |
|---|---|---|---|
| Database + Auth | **Supabase** | 500 MB | **$0** — expect ~20–50 MB |
| Photo storage | **Cloudflare R2** | 10 GB | **$0** — ~50,000 photos |
| Hosting | **Cloudflare Pages** | Unlimited bandwidth | **$0** |
| Domain | **Cloudflare Registrar** | — | **~$10/year** |
| Framework | **Astro** + React islands | — | — |
| Code | **GitHub** (private repo) | — | **$0** |

**Total: $0/month, ~$10/year.** Stays free well past 2,000 products.

**Why photos go in R2, not Supabase Storage:** 10 GB free instead of 1 GB, and — more
importantly — **zero bandwidth charges, permanently**. On a photo-heavy public site,
egress fees are the bill that sneaks up on you. If storage ever exceeds 10 GB it's
pay-as-you-go at $0.015/GB (100 GB ≈ $1.50/month). No forced plan upgrade.

**Why Supabase:** the database is the easy part. The real value is **authentication** —
multi-user, roles, email invites, password resets, and row-level security enforcing
"staff cannot see cost" at the database itself. Weeks of work, dangerous to hand-roll,
free here.

**Why Astro:** best-in-class for fast, SEO-heavy static product pages, with React
islands for the interactive admin. Deploys natively to Cloudflare Pages. Already
familiar from the Boyles Flooring project.

**Known gotcha:** Supabase pauses free projects after 7 days of inactivity. Mitigated
with a scheduled ping.

### 9.1 Deployment

GitHub holds the code; Cloudflare Pages runs the site. Connected once, then every
`git push` deploys automatically — live in about a minute. Failed builds leave the
previous version up, so a bad push can't take the site down. Branch pushes produce
private preview URLs for checking changes before they go public.

> 🔐 **Secrets never enter the repository.** Supabase and R2 keys live in Cloudflare
> environment variables. A leaked service key means full read/delete access to the
> database.

> 🔑 **SSH note:** the GitHub key on this machine is scoped to a single repo. This new
> repo needs its own deploy key and its own `Host` alias in `~/.ssh/config`, or pushes
> fail with a misleading permission error.

### 9.2 Scale assumptions

- **100–500 products** initially, not thousands
- Quantity per product can be high (truckloads of identical units)
- 2–3 admin users
- Existing inventory lives in handwritten notes → entered by hand via the mobile
  admin. Manifest import serves *future* purchases.

---

## 10. Build Phases

### Phase 0 — Foundation
- Choose and register the domain on Cloudflare
- Create Supabase project, R2 bucket, private GitHub repo
- Astro project scaffold, Tailwind, deployment pipeline to Cloudflare Pages
- Custom domain + SSL, environment variables wired
- **Done when:** a placeholder page is live on the real domain and `git push` deploys it

### Phase 1 — Data & Login
- Full database schema: products, stock lines, lots, imports, sales, users, categories
- Role-based security policies (owner vs staff) enforced at the database
- Login, password reset, invite flow
- **Multi-user is designed in from here** — retrofitting it later is the one genuinely
  expensive mistake available. The invite *UI* can wait; the schema cannot.
- **Done when:** the owner can log in and the data structure is final

### Phase 2 — Admin Core (mobile-first)
- Add / edit / delete products
- Camera photo upload with auto-compression to R2, gallery reordering
- Category and subcategory management
- Quantity and status handling, mark-as-sold
- Search within admin
- Install-to-home-screen
- **Done when:** the owner can enter his notebook inventory from his phone

### Phase 3 — Public Website 🚀 *first customer-visible milestone*
- Home, category, subcategory, product detail pages
- Filters, keyword search, sorting
- Text / Call / Email buttons with pre-filled item details
- About, Hours, Delivery, Warranty, Contact pages
- Full SEO: structured data, sitemap, meta tags, clean URLs
- Google Business Profile setup
- **Done when:** the site is live, indexed, and customers can text about items

### Phase 4 — Manifest Import
- CSV upload and parsing
- Description parser → model number + human-readable name
- Category mapping table
- Match / create / skip review screen with quality flags
- Raw import layer preserving every field
- Lot entry with cost allocation
- Bulk pricing grid
- **Done when:** a truckload goes from CSV to priced, live listings in minutes

### Phase 5 — Sales & Reporting
- Record sales with actual sale price
- Owner dashboard with charts
- Monthly sales, profit-per-truckload, inventory reports
- CSV download on every report
- **Done when:** the owner can answer "did that truckload make money?"

### Phase 6 — Polish
- User management UI — invite, deactivate (all accounts full-access)
- Performance and SEO tuning
- Refinements from real-world use
- **Done when:** the system is smooth enough to stop thinking about

---

## 11. Remaining Inputs

Nothing here blocks the build. These are inputs needed at the moment a specific phase
reaches them — they'll be raised then, not before.

### Before Phase 3 (public launch) — content

| Item | Default if unspecified |
|---|---|
| **Business name + domain** | Required — nothing can go live without it |
| **Address** | Hidden. Site shows "Greater Los Angeles — by appointment" |
| **Delivery policy** | Page written as "contact us for delivery options" |
| **Warranty / returns policy** | Page written as "sold as-is — see item condition" |
| **Store hours** | "By appointment" |
| **Info page editing** | Written into the code; changed on request |

### Before Phase 4 (import)

| Item | Default if unspecified |
|---|---|
| **Meaning of `@`** in two descriptions | Stripped from the display name, preserved in raw data |
| **Accessories** (pedestals, stack kits) | Imported into an **Accessories** category, published like anything else |
| **Pricing markup rule** | Cost × 2.5 when lot cost is known, else 35% of MSRP — adjustable in settings |
| **Buyer premium %** | Entered manually per lot |
| **`Item #` stability across auctions** | Assumed stable; a mismatch surfaces on the review screen as a new product, which is harmless |

### Setup

| Item | Notes |
|---|---|
| **Cloudflare account** | Needed at Phase 0 for domain, Pages, R2 |
| **GitHub account** | Assumed `garabedo23@gmail.com` unless told otherwise |
| **Photos per item** | Up to 10 supported; no decision needed |
| **Inventory CSV backup export** | Not building unless asked |
| **Activity log** | Not building — single user, no value |

## 12. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Catalog only, no e-commerce | Sales happen in person; removes all payment liability |
| 2 | Product = model + quantity | Truckloads contain multiple identical units |
| 3 | Private stock lines under each product | Condition/cost detail without cluttering the public page |
| 4 | Four distinct price fields | Conflating them makes every report wrong |
| 5 | `Unit Retail` is MSRP, not cost | Verified: `Ext. Retail = Qty × Unit Retail`, totals match filename |
| 6 | Lot cost allocation by retail share | The only way to get true per-unit cost from a lump-sum bid |
| 7 | Raw import layer preserved permanently | Never lose a field; never need to re-import |
| 8 | `Item #` as match key | Same model across lots merges automatically |
| 9 | Import always reviewed before publish | Manifest data is messy; nothing goes live unchecked |
| 10 | Soft delete only | Hard delete would corrupt historical profit reporting |
| 11 | Multi-user schema from day one | The one thing that is expensive to retrofit |
| 12 | Database-level permissions | A UI bug must not be able to leak cost data |
| 13 | Photos in R2, not Supabase Storage | 10× free storage, zero egress fees |
| 14 | Photos auto-compressed on upload | ~20× storage savings, faster pages, better SEO |
| 15 | No contact form | Pre-filled SMS is faster for the customer and clearer for the owner |
| 16 | Sold items stay public with a badge | Preserves accumulated Google ranking; proves stock moves |
| 17 | ~~Condition private, not filterable~~ | **Reversed by 21** |
| 18 | Sales record qty + price only | No customer data means no privacy obligations |
| 19 | Single full-access role | One-person business; permission tiers are complexity without benefit |
| 20 | Exact quantity shown publicly | Customers know how many are available before they call |
| 21 | Condition shown publicly, owner-editable | Reverses 17. A liquidation buyer's first question is what shape it's in; hiding it only produces a call that ends in disappointment. Manifests grade everything `USED`, so the owner corrects it by eye after unloading |
| 22 | Sales snapshot the asking price and the unit cost | Prices are negotiated at the door and `products.price_cents` moves afterwards. Without a snapshot the discount is unrecoverable a week later |
| 23 | Stock can never go negative | A double-click on "Mark sold" used to record two sales and leave −1 in stock, which then flowed into the public catalog |
