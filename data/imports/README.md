# CSV imports

Drop exchange CSV exports in this folder and they'll be picked up on the next
page load. Recognized formats:

- **Coinbase transaction export** — coinbase.com → profile → Statements →
  generate a Transactions (CSV) report. Best way to capture old Coinbase
  history with exact fees.
- **Kraken trades export** — kraken.com → History → Export → Trades (CSV).
- **Generic** — any CSV with headers `date,type,btc,usd,fee` where type is
  `buy`, `sell`, `send`, or `receive`, and `usd` is the fee-inclusive total.

Records that duplicate something already synced via API (same type, same BTC
amount, within 10 minutes) are automatically merged, so it's safe to have both
API sync and a CSV covering the same period.

CSVs placed here are gitignored — they never leave your machine.
