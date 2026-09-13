# Toma Appliances

Public appliance catalog + private back-office for a liquidation appliance business
in Greater Los Angeles.

**Not e-commerce** — no cart, no checkout, no payments. Customers browse and then
text or call; the sale happens in person.

## Docs

- [Requirements](docs/REQUIREMENTS.md) — what we're building and why
- [Technical Plan](docs/TECHNICAL_PLAN.md) — architecture, schema, decisions

## Stack

Astro 7 · React 19 (admin only) · Tailwind v4 · TypeScript · Supabase (Postgres +
Auth) · Cloudflare R2 (photos) · Cloudflare Workers (hosting) · Biome

## Getting started

Requires **Node >= 22.12** (Astro 7 will refuse to run on older versions).

```bash
npm install
cp .env.example .env   # then fill in the Supabase values
npm run dev            # http://localhost:4322
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run check` | Astro + TypeScript diagnostics |
| `npm run lint` | Biome lint + format check |
| `npm run format` | Biome autofix |
| `npm test` | Full test suite (44 tests) |

## Tests

```bash
npm test
```

Integration tests run against the **real Supabase database**, each inside a
transaction that is rolled back — so they never leave data behind and never
need a separate test database. The logic under test lives in Postgres functions
(cost allocation, commit, revert, delete), so mocking the database would test
nothing that matters.

- `tests/delete-lot.test.ts` — deleting and archiving lots
- `tests/import-flow.test.ts` — commit, revert, cost allocation, stock status
- `tests/parse.test.ts` — manifest parsing and money handling (no database)

## Notes

- **Never gitignore `src/`** — Tailwind v4 skips gitignored paths when scanning for
  class names, producing a completely unstyled site that still builds "successfully".
- **All money is stored as integer cents.** See Technical Plan §5.
- `.env` is gitignored and must never be committed.
- This repo uses a dedicated SSH deploy key via the `github-toma` host alias.
