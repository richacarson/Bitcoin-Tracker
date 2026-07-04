// Shared with the Supabase edge build, where manual entries come from the
// settings store instead of data/manual.json.
export function normalizeManual(entries, idPrefix) {
  const trades = [];
  const transfers = [];
  (Array.isArray(entries) ? entries : []).forEach((m, i) => {
    const btc = Math.abs(parseFloat(m.btc)) || 0;
    if (!btc || !m.date) return;
    const entry = {
      id: `${idPrefix}:${i}`,
      source: 'manual',
      date: new Date(m.date).toISOString(),
      type: m.type,
      btc,
      note: m.note,
    };
    if (m.type === 'buy' || m.type === 'sell') {
      const usd = Math.abs(parseFloat(m.usd)) || 0;
      trades.push({ ...entry, usd, fee: Math.abs(parseFloat(m.fee)) || 0, price: usd / btc });
    } else if (m.type === 'send' || m.type === 'receive') {
      transfers.push({ ...entry, networkFeeBtc: 0 });
    }
  });
  return { trades, transfers };
}
