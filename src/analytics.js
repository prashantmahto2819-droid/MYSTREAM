// Turns activity log rows into per-day totals: how many lives and how many minutes were streamed.
export function summarize(rows, { days = 14, now = Date.now() } = {}) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push({ date: day(now - i * 86400000), lives: 0, minutes: 0, peak: 0 });
  const byDate = new Map(out.map((d) => [d.date, d]));
  for (const r of rows) {
    const d = byDate.get(String(r.ts).slice(0, 10)); if (!d) continue;
    if (r.action === 'studio_started' || r.action === 'obs_live_started') d.lives += 1;
    if (r.action === 'live_summary') { const m = /peak (\d+)/.exec(r.detail || ''); if (m) d.peak = Math.max(d.peak, Number(m[1])); }
    if (r.action === 'studio_stopped') { const m = /(\d+)s\b/.exec(r.detail || ''); if (m) d.minutes += Math.round(Number(m[1]) / 60); }
  }
  return { days: out, totals: { lives: out.reduce((a, d) => a + d.lives, 0), minutes: out.reduce((a, d) => a + d.minutes, 0), peak: Math.max(0, ...out.map((d) => d.peak)) } };
}
