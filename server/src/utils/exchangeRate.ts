const cache: Record<string, { rate: number; expires: number }> = {};
const TTL = 3_600_000;

export async function fetchExchangeRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  const key = `${from}_${to}`;
  const now = Date.now();
  if (cache[key] && cache[key].expires > now) return cache[key].rate;
  try {
    const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`);
    if (!resp.ok) return null;
    const data = await resp.json() as { rates?: Record<string, number> };
    const rate = data.rates?.[to];
    if (!rate) return null;
    cache[key] = { rate, expires: now + TTL };
    return rate;
  } catch {
    return null;
  }
}
