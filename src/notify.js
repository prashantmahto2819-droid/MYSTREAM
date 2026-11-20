// Sends alerts to an HTTP endpoint (e.g. your Vivid Relay WhatsApp gateway).
// The request body is a JSON template; "{{to}}" and "{{message}}" are replaced
// inside string values only, so a message can never break the JSON.
export function renderTemplate(template, vars) {
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(JSON.parse(template));
}

export class Notifier {
  constructor({ cfg, store, fetchImpl = globalThis.fetch, log = console, now = Date.now }) {
    this.cfg = cfg;
    this.store = store;
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.last = new Map(); // dedupe key -> timestamp
  }

  recipients(userId) {
    const set = new Set(this.cfg.alertTo);
    const u = userId != null ? this.store.getUser(userId) : null;
    if (u?.phone) set.add(u.phone);
    return [...set];
  }

  /**
   * @param opts.key      if given, the same key is not sent again within the cooldown
   */
  async send(userId, message, { key } = {}) {
    if (!this.cfg.alertUrl) return { sent: 0, skipped: 'not configured' };
    if (key) {
      const t = this.last.get(key);
      if (t && this.now() - t < this.cfg.alertCooldownMs) return { sent: 0, skipped: 'cooldown' };
      this.last.set(key, this.now());
    }
    return this.deliver(this.recipients(userId), message);
  }

  /** Sends to specific numbers, with a pause between messages (unofficial WhatsApp gateways get blocked when flooded). */
  async sendTo(numbers, message, { gapMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (!this.cfg.alertUrl) return { sent: 0, skipped: 'not configured' };
    let sent = 0;
    for (const n of numbers) {
      sent += (await this.deliver([n], message)).sent;
      if (gapMs) await sleep(gapMs);
    }
    return { sent };
  }

  async deliver(to, message) {
    let sent = 0;
    for (const number of to) {
      try {
        const headers = { 'content-type': 'application/json' };
        if (this.cfg.alertAuth) headers.authorization = this.cfg.alertAuth;
        const res = await this.fetch(this.cfg.alertUrl, {
          method: 'POST', headers,
          body: JSON.stringify(renderTemplate(this.cfg.alertBodyTemplate, { to: number, message })),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) sent += 1;
        else this.log.warn?.(`alert webhook returned ${res.status}`);
      } catch (e) {
        this.log.warn?.(`alert webhook failed: ${e.message}`);
      }
    }
    return { sent };
  }
}
