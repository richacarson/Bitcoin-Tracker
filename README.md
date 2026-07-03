# ₿ Bitcoin Tracker

A self-hosted dashboard for your BTC stack. It pulls your full purchase
history from **Kraken** and **Coinbase**, follows the coins you've moved to
**Phantom** (self-custody), and computes an accurate, fee-inclusive cost
basis: average cost per BTC, net invested, unrealized and realized P/L, and
where every sat currently lives.

Everything runs locally. API keys stay in a `.env` file on your machine, are
only ever used server-side, and all keys are **read-only** — the app cannot
trade or withdraw, ever.

![Dashboard](docs/screenshot.png)

## Quick start

```bash
npm install
npm start          # → http://localhost:3000
```

With no keys configured you'll see a **demo portfolio** so you can explore the
dashboard. To connect your real accounts:

```bash
cp .env.example .env
# fill in the keys (walkthrough below), then restart:
npm start
```

The first sync pulls your entire trade history (Kraken paginates slowly due to
rate limits — a few years of daily DCA can take a couple of minutes). After
that, syncs are incremental and fast. Use the **Sync now** button any time.

## Getting your API keys (5 minutes)

### Kraken (your daily DCA history)

1. Log in at kraken.com, click your profile icon (top right) → **Settings** → **API**.
2. Click **Create API key** (choose *Spot trading API* if asked).
3. Give it a name like `btc-tracker` and check **only** these permissions:
   - ✅ **Query funds** (reads your balance)
   - ✅ **Query closed orders & trades** (reads your buy history)
   - ✅ **Query ledger entries** (reads deposits/withdrawals, so transfers to
     Phantom are tracked)
   - ❌ Leave everything else unchecked — especially anything under Trade,
     Withdraw, or Export.
4. Click **Generate key**, then copy the **API Key** into `KRAKEN_API_KEY`
   and the **Private Key** into `KRAKEN_API_SECRET` in your `.env`.

### Coinbase (your early purchases)

Coinbase API keys are created in their developer portal (CDP), but it's still
just a few clicks:

1. Log in at coinbase.com → click your avatar → **Settings** → **API** →
   **Create API key** (this opens portal.cdp.coinbase.com; sign in with the
   same account).
2. Name it `btc-tracker`. Under permissions choose **View (read-only)** only.
   Do **not** enable trade or transfer.
3. Create the key. You'll be shown:
   - a key **name** like `organizations/xxxx-…/apiKeys/yyyy-…` → paste into
     `COINBASE_API_KEY_NAME`
   - a **private key** (a `-----BEGIN EC PRIVATE KEY-----` block, or a base64
     string for Ed25519 keys) → paste into `COINBASE_API_PRIVATE_KEY`.
     If it's a PEM block, put it in quotes on one line with `\n` for the line
     breaks (the download file from Coinbase already shows it this way).
4. Save `.env` and restart.

**Alternative (no API key):** Coinbase's CSV export works great for old
history — coinbase.com → profile → **Statements** → generate a
**Transactions** report (CSV) → drop the file into `data/imports/`. This is
actually the most fee-accurate source for early "simple" buys.

### Phantom (self-custody)

No API key needed — your Phantom BTC is tracked on-chain:

1. Open Phantom → switch to your **Bitcoin** account → **Receive**.
2. Copy the address (starts with `bc1…`). If Phantom shows both a *Native
   SegWit* and a *Taproot* address, copy both.
3. Put them in `.env`, comma-separated:
   `PHANTOM_BTC_ADDRESSES=bc1q...,bc1p...`

Balances are read from the public mempool.space API. Note that on-chain
addresses are already public information; sharing them reveals balances but
nothing more. Transfers from an exchange to your own wallet are **not sales**
— your cost basis carries over, and the dashboard treats them as "same coins,
different pocket."

## Lump sums & anything else

- **Manual entries:** copy `data/manual.example.json` to `data/manual.json`
  and add one object per purchase (`usd` = total paid including fees).
- **CSV imports:** drop Coinbase/Kraken exports (or a generic
  `date,type,btc,usd,fee` CSV) into `data/imports/`. See
  `data/imports/README.md`.
- Duplicates between API sync and CSV imports are detected and merged
  automatically.

## How the numbers are computed

- **Cost basis** is FIFO (first-in, first-out) and **fee-inclusive**: a $25
  buy with a $0.10 fee creates a lot that cost $25.
- **Average cost** = remaining cost basis ÷ BTC still held.
- **Sells** consume the oldest lots and produce **realized P/L**; what's left
  is your **unrealized P/L** at the current price.
- **Transfers** (exchange → Phantom) never touch cost basis.
- **Holdings** use live balances (Kraken + Coinbase + on-chain) when all
  sources are connected; the small gap vs. the trade ledger (withdrawal
  network fees, dust) is shown in *Where it lives*.
- Numbers are informational — not tax advice.

## Privacy & security

- Keys live in `.env` (gitignored) and never leave your machine except to
  call Kraken/Coinbase directly over HTTPS.
- All keys are read-only; the app has no ability to trade or move funds.
- The browser only ever receives computed numbers, never credentials.
- Synced history and price data are cached in `data/` (gitignored).

## Project layout

```
server.js          Express server + sync orchestration
lib/kraken.js      Kraken private API (trades, ledger, balance)
lib/coinbase.js    Coinbase CDP-key API (buys/sells/sends, balance)
lib/onchain.js     mempool.space balance for Phantom addresses
lib/prices.js      current price + daily history (cached)
lib/imports.js     CSV + manual-entry ingestion
lib/costbasis.js   FIFO cost-basis engine
public/            the dashboard (vanilla JS, no build step)
```
