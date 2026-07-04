import { fetchJson } from './util.js';

// Balance of self-custody (Phantom) addresses via mempool.space — public
// API, no key. Addresses only reveal what's already public on-chain.
export async function fetchOnchainBalance(addresses) {
  let sats = 0;
  const perAddress = [];
  for (const address of addresses) {
    const stats = await fetchJson(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
    const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
    const pending = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
    sats += confirmed + pending;
    perAddress.push({ address, btc: (confirmed + pending) / 1e8 });
  }
  return { btc: sats / 1e8, perAddress };
}
