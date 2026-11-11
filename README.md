# Videvas inventory & cash ledger

A private workspace for a cosmetics, skincare, and bodycare shop, built with React, Vite, and Supabase. Each account owns one shop; signing into that account on another device opens the same records.

## Local setup

```powershell
npm.cmd install
Copy-Item .env.example .env.local
```

Fill in `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` with the public publishable key for Supabase project `tmixrlodofdycichecyj`. A legacy `anon` key also works. The project URL is `https://tmixrlodofdycichecyj.supabase.co`. Keep existing environment values when updating an existing file.

```powershell
npm.cmd run dev
```

Open **http://localhost:5173**. Missing cloud configuration shows a setup error. Shop records are saved through Supabase; they do not fall back to browser storage.

## Supabase setup

Correct project: [tmixrlodofdycichecyj](https://supabase.com/dashboard/project/tmixrlodofdycichecyj), under organization `cplzfcosundaffloplzp`.

1. Run the complete contents of [001_cloud_workspaces.sql](supabase/migrations/001_cloud_workspaces.sql) in that project's SQL Editor. The migration can be run again without erasing existing records.
2. Leave email sign-in enabled. With email confirmation enabled, users must confirm the email before signing in.
3. Under **Authentication → URL Configuration**, set Site URL to `https://videvas-cosmetics-site.vercel.app` and allow these redirect URLs:
   - `https://videvas-cosmetics-site.vercel.app/**`
   - `http://localhost:5173/**`
   - `http://127.0.0.1:5173/**`

The app supports account creation, email/password sign-in, password recovery with PKCE, and signing out of the current browser. Recovery links should be opened in the same browser that requested them so its verification code is available.

## Deployment

Production URL: [Videvas shop workspace](https://videvas-cosmetics-site.vercel.app).

The Vercel project is `videvas-cosmetics-site` under **videvascosmetics-1868**. Set both public Vite variables above for Production, Preview, and Development. Rebuild/redeploy after changing them; Vite embeds these public values into the build.

This workspace uses separate CLI credentials in the ignored `data/vercel-auth/` folder. Always specify them and the intended scope:

```powershell
npx.cmd vercel whoami --global-config data/vercel-auth
npx.cmd vercel deploy --prod --yes --scope videvascosmetics-1868 --global-config data/vercel-auth --logs
```

On a fresh checkout, use `npx.cmd vercel login --global-config data/vercel-auth`, then `npx.cmd vercel link --yes --project videvas-cosmetics-site --scope videvascosmetics-1868 --global-config data/vercel-auth`.

`vercel.json` configures the Vite build and `dist` output. `.vercelignore` excludes local environment files, browser profiles, backups, CLI credentials, and installed dependencies.

## Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:browser
node scripts/cloud-preflight.mjs
```

Unit tests cover the financial model, legacy workspaces, customers, cloud state handling, and the actual migration in an isolated PostgreSQL instance. They verify account isolation, direct-write denial, stale revisions, retry receipts, immutable history, and reset/import behavior.

The browser check uses installed Google Chrome with an isolated profile and test PostgreSQL database. It runs the real Supabase SDK with simulated Auth/email delivery and Realtime messages; it never writes to the real Supabase project. Checks include sign-in/signup/confirmation/recovery, cross-device sync, fallback refresh, account changes, lost responses, duplicate submits, offline drafts, customers, inventory, sales, refunds, ledger entries, imports, backups, CSV exports, and desktop/mobile layouts. Set `CHROME_PATH` for another Chromium executable. Screenshots and downloads are saved to the ignored `data/browser/` folder.

The final preflight requires internet access. It checks the intended project's public key and email auth, verifies that the RPC exists, and confirms that anonymous callers cannot read the shop. It does not create users or write shop records. Real email delivery and the first production sign-in are checked manually using the intended shop account.

## Using the shop

- Create your shop account, confirm the email if requested, then sign in. A new account starts empty.
- **Settings → Import browser records** explicitly copies records from the earlier browser version into an empty account. It names the destination account and requires typing `IMPORT`. The original browser copy is preserved. Browser storage is specific to each site address; use a JSON backup to bring records from another address or browser.
- **Settings → Load demo data** adds sample products, customers, sales, and expenses only to an empty workspace. Explicitly loaded demo data survives reloads and syncs across that account's devices. Use **Start fresh** before entering your own records.
- The default currency is **XOF — West African CFA francs**. Prices, costs, discounts, and payments use whole francs. Sample prices are illustrative.
- Add products with SKUs, categories, suppliers, prices, opening stock, and low-stock thresholds. Opening stock records goods already owned and does not create a payment.
- Add or edit customer names, phone numbers, email addresses, addresses, and notes. Search profiles, sort by spending or latest purchase, and view sales and refunds. Archive profiles to hide them from new sales; restore them whenever needed.
- Choose a customer when recording a sale, or record a walk-in sale. Spending includes discounts and deducts refunds. Renaming a profile preserves the name on past receipts. Older backups bring forward named sales into customer profiles.
- Receive paid stock purchases with batch quantities, costs, and optional expiry dates. Purchases update inventory and the cash ledger together.
- Record fully paid sales. Expired stock is excluded. Stock is consumed by earliest expiry, then oldest received date; cost of goods sold uses actual batch costs.
- Open a sale to record a full return and refund. Confirm that the goods were returned and the refund paid. The original sale remains in history, and a reversing cash entry restores the original batches. Partial returns are outside this version.
- Log paid operating expenses or other cash received. Stock adjustments require a reason and preserve movement history.
- Export inventory, customers, sales, ledger, and period reports to CSV. Download a JSON backup in Settings to retain a separate copy of the entire shop.
- Restoring a backup validates stock history, totals, and refunds, then requires typing `RESTORE`. Starting fresh requires typing `START FRESH`. Both replace records **in the account on all devices**, with a revision check to protect against intervening changes.

## Sync and privacy

Only confirmed cloud records are shown as saved. A save commits the complete shop atomically so stock, receipts, ledger, and movement history stay together. A second device cannot overwrite a newer revision. On a conflict, the latest records refresh and the draft stays open for review; financial entries are never silently reposted.

If a response is lost, **Check previous save** retries the same operation ID. Supabase's receipt prevents duplicate entries, including if another device wrote after the original save. New writes and sign-out from that tab are blocked until the uncertain save is resolved. Going offline retains open drafts and blocks posting; reconnect before saving. Other tabs can still change accounts; old responses cannot show or write records under the new account.

Realtime revision messages refresh other devices. Focus, reconnect, and a 45-second foreground check provide a fallback. Staff invitations and collaboration across separate accounts are outside this version; each login owns its own private shop.

Row-level security limits reads to the signed-in owner. Authenticated users cannot write tables directly; owner-checked RPCs handle atomic saves. Posted transaction and movement prefixes are immutable during ordinary saves. The browser validates complete financial consistency; SQL additionally validates document shape, identifiers, amounts, size, and history preservation.

The underlying `videvas_workspaces` table stores the atomic JSON document, revision, and update time. Read-only projections (`videvas_products`, `videvas_customers`, `videvas_transactions`, `videvas_stock_movements`) make records readable in the Supabase dashboard. `videvas_operations` stores retry receipts; `videvas_workspace_changes` carries small revision notifications.

## Accounting scope

Amounts are stored as integer hundredths of the selected currency. XOF amounts must be divisible by 100, and discounts are allocated in whole francs. Two-decimal currencies allocate discounts in cents. Currency changes do not convert existing values; after posting transactions, start a fresh workspace before changing currency.

Cash flow is recorded cash received minus cash paid, not a bank balance. Net sales exclude refunds; gross profit deducts actual product costs; operating profit also deducts operating expenses. Inventory purchases affect cash when paid and profit when goods are sold. Inventory adjustments change stock value and history but do not post profit write-offs. Taxes, unpaid invoices, debt, opening cash balances, and statutory accounting are outside this version.

Payment methods label manually recorded payments. There is no external payment processing. Product thumbnails are CSS illustrations.

