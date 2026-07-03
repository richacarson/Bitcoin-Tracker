import { dayKey } from './util.js';

// Two records are the same economic event if they match on type, size and
// a 10-minute window — catches API + CSV double-imports of one exchange.
function dedupe(items) {
  const priority = { kraken: 0, coinbase: 0, 'kraken-csv': 1, 'coinbase-csv': 1, csv: 2, manual: 3 };
  const sorted = [...items].sort((a, b) => (priority[a.source] ?? 4) - (priority[b.source] ?? 4));
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const item of sorted) {
    const bucket = Math.round(new Date(item.date).getTime() / 600000);
    const keys = [0, -1, 1].map((o) => `${item.type}|${item.btc.toFixed(8)}|${bucket + o}`);
    if (keys.some((k) => seen.has(k))) { dropped++; continue; }
    seen.add(keys[0]);
    kept.push(item);
  }
  return { kept, dropped };
}

// FIFO cost-basis engine. Buys create lots (fee-inclusive cost); sells
// consume the oldest lots and realize gains. Transfers between your own
// venues (exchange -> Phantom) are not disposals and never touch basis.
export function computePortfolio({ trades, transfers, dailyPrices, currentPrice, balances }) {
  const { kept: cleanTrades, dropped } = dedupe(trades);
  const sorted = cleanTrades.sort((a, b) => new Date(a.date) - new Date(b.date));

  let lots = [];
  let realizedGain = 0, realizedProceeds = 0, realizedCostBasis = 0;
  let totalBuyBtc = 0, totalBuyUsd = 0, totalSellBtc = 0, totalSellUsd = 0, totalFeesUsd = 0;
  let unmatchedSellBtc = 0;
  const avgCostSeries = []; // running average cost after each trade
  const buys = [];

  for (const t of sorted) {
    totalFeesUsd += t.fee || 0;
    if (t.type === 'buy') {
      lots.push({ btc: t.btc, costPerBtc: t.usd / t.btc, date: t.date });
      totalBuyBtc += t.btc;
      totalBuyUsd += t.usd;
      buys.push({
        date: t.date,
        btc: t.btc,
        usd: t.usd,
        price: t.usd / t.btc, // effective price incl. fee
        source: t.source,
      });
    } else if (t.type === 'sell') {
      totalSellBtc += t.btc;
      totalSellUsd += t.usd;
      let remaining = t.btc;
      while (remaining > 1e-12 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.btc, remaining);
        const cost = take * lot.costPerBtc;
        realizedCostBasis += cost;
        realizedGain += (take / t.btc) * t.usd - cost;
        realizedProceeds += (take / t.btc) * t.usd;
        lot.btc -= take;
        remaining -= take;
        if (lot.btc <= 1e-12) lots.shift();
      }
      if (remaining > 1e-12) {
        // Sold coins we have no acquisition record for (missing history).
        unmatchedSellBtc += remaining;
        realizedProceeds += (remaining / t.btc) * t.usd;
        realizedGain += (remaining / t.btc) * t.usd;
      }
    }
    const heldBtc = lots.reduce((s, l) => s + l.btc, 0);
    const heldCost = lots.reduce((s, l) => s + l.btc * l.costPerBtc, 0);
    avgCostSeries.push({ date: t.date, avgCost: heldBtc > 0 ? heldCost / heldBtc : 0 });
  }

  const holdingsBtc = lots.reduce((s, l) => s + l.btc, 0);
  const costBasisUsd = lots.reduce((s, l) => s + l.btc * l.costPerBtc, 0);
  const avgCost = holdingsBtc > 0 ? costBasisUsd / holdingsBtc : 0;
  const netInvested = totalBuyUsd - totalSellUsd;

  // ── Where the BTC lives ────────────────────────────────────────────────
  const sentOut = { kraken: 0, coinbase: 0 };
  for (const tr of transfers) {
    const key = tr.source.startsWith('kraken') ? 'kraken' : tr.source.startsWith('coinbase') ? 'coinbase' : null;
    if (!key) continue;
    sentOut[key] += tr.type === 'send' ? tr.btc + (tr.networkFeeBtc || 0) : -tr.btc;
  }
  const locations = [];
  if (balances.kraken != null) locations.push({ name: 'Kraken', btc: balances.kraken, actual: true });
  if (balances.coinbase != null) locations.push({ name: 'Coinbase', btc: balances.coinbase, actual: true });
  if (balances.onchain != null) {
    locations.push({ name: 'Phantom (on-chain)', btc: balances.onchain, actual: true });
  } else if (sentOut.kraken + sentOut.coinbase > 0) {
    locations.push({ name: 'Withdrawn to wallet', btc: sentOut.kraken + sentOut.coinbase, actual: false });
  }
  const actualTotal = locations.length ? locations.reduce((s, l) => s + l.btc, 0) : null;
  const allActual = locations.length > 0 && locations.every((l) => l.actual);

  // Live balances are ground truth when we have all of them; the small gap
  // vs. computed holdings is withdrawal/network fees and dust.
  const currentBtc = allActual ? actualTotal : holdingsBtc;
  const currentValue = currentBtc * currentPrice;
  const unrealizedGain = currentValue - costBasisUsd * (holdingsBtc > 0 ? currentBtc / holdingsBtc : 0);

  // ── Daily series: cumulative net invested vs. portfolio value ─────────
  const daily = [];
  if (sorted.length) {
    const start = new Date(dayKey(new Date(sorted[0].date).getTime()));
    let i = 0, investedCum = 0, btcCum = 0;
    for (let d = start.getTime(); d <= Date.now(); d += 86400000) {
      const key = dayKey(d);
      while (i < sorted.length && dayKey(new Date(sorted[i].date).getTime()) <= key) {
        const t = sorted[i];
        investedCum += t.type === 'buy' ? t.usd : -t.usd;
        btcCum += t.type === 'buy' ? t.btc : -t.btc;
        i++;
      }
      const price = key === dayKey(Date.now()) ? currentPrice : dailyPrices[key];
      if (price != null) daily.push({ d: key, invested: investedCum, value: btcCum * price, btc: btcCum });
    }
  }

  return {
    summary: {
      currentBtc,
      computedBtc: holdingsBtc,
      currentPrice,
      currentValue,
      netInvested,
      totalBuyBtc,
      totalBuyUsd,
      totalSellBtc,
      totalSellUsd,
      totalFeesUsd,
      costBasisUsd,
      avgCost,
      unrealizedGain,
      unrealizedPct: costBasisUsd > 0 ? (unrealizedGain / costBasisUsd) * 100 : 0,
      realizedGain,
      realizedProceeds,
      buyCount: buys.length,
      firstBuy: buys[0]?.date || null,
      dedupedRecords: dropped,
      unmatchedSellBtc,
      reconcileDiffBtc: allActual ? actualTotal - holdingsBtc : null,
    },
    locations,
    buys,
    avgCostSeries,
    daily,
    trades: sorted,
    transfers: [...transfers].sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}
