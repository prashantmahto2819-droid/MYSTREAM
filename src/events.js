// Public "event" (webinar) pages: a shareable link with a countdown, a registration form and an
// embedded player of one of the platforms the live goes to. Only YouTube / Twitch / Facebook embeds are allowed.
import crypto from 'node:crypto';

export const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Turns a pasted link into { type, ref } or null. ref is an id / channel / full facebook URL. */
export function parseEmbed(input) {
  const raw = clean(input, 300);
  if (!raw) return { type: '', ref: '' };
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.replace(/^www\.|^m\./, '');
  if (h === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? { type: 'youtube', ref: id } : null;
  }
  if (h === 'youtube.com') {
    const m = /^\/(?:live|embed|shorts)\/([\w-]{11})/.exec(u.pathname);
    const id = m ? m[1] : u.pathname === '/watch' ? u.searchParams.get('v') : null;
    return id && /^[\w-]{11}$/.test(id) ? { type: 'youtube', ref: id } : null;
  }
  if (h === 'twitch.tv') {
    const ch = u.pathname.slice(1).split('/')[0];
    return /^\w{3,25}$/.test(ch) ? { type: 'twitch', ref: ch.toLowerCase() } : null;
  }
  if (h === 'facebook.com' || h === 'fb.watch') return { type: 'facebook', ref: `https://${u.hostname}${u.pathname}${u.search}`.slice(0, 300) };
  return null;
}

/** The iframe address for a stored embed. `host` is this site's host name (Twitch requires it). */
export function embedUrl(type, ref, host) {
  if (type === 'youtube' && /^[\w-]{11}$/.test(ref)) return `https://www.youtube.com/embed/${ref}?autoplay=1&rel=0`;
  if (type === 'twitch' && /^\w{3,25}$/.test(ref)) return `https://player.twitch.tv/?channel=${ref}&parent=${encodeURIComponent(host.split(':')[0])}&autoplay=true`;
  if (type === 'facebook') return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(ref)}&show_text=false&autoplay=true`;
  return '';
}

export const newSlug = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();

export function validateEvent(b, now = Date.now(), allowPast = false) {
  const title = clean(b.title, 100);
  if (!title) return { error: 'Title is required' };
  const startAt = Number(b.start_at);
  if (!Number.isFinite(startAt) || (!allowPast && startAt < now - 24 * 3600 * 1000) || startAt > now + 400 * 24 * 3600 * 1000) return { error: 'Pick a valid start time' };
  const embed = parseEmbed(b.embed_url);
  if (!embed) return { error: 'Embed link must be a YouTube, Twitch or Facebook https link' };
  return {
    value: {
      title, description: clean(b.description, 600), startAt: Math.round(startAt),
      embedType: embed.type, embedRef: embed.ref, askPhone: b.ask_phone ? 1 : 0, remindMinutes: Math.min(Math.max(Number(b.remind_minutes) || 15, 1), 1440),
    },
  };
}

/** Sends the owner a reminder shortly before an event starts. */
export class EventReminders {
  constructor({ store, notifier, now = Date.now, log = console, baseUrl = '' }) { this.baseUrl = baseUrl; this.store = store; this.notifier = notifier; this.now = now; this.log = log; }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 30000); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); }
  async tick() {
    for (const ev of this.store.listEventsToRemind(this.now())) {
      this.store.markEventReminded(ev.id);
      const n = this.store.countRegistrations(ev.id);
      const mins = Math.max(0, Math.round((ev.start_at - this.now()) / 60000));
      this.store.addActivity(ev.user_id, 'event_reminder', ev.title);
      await this.notifier.send(ev.user_id, `⏰ इवेंट "${ev.title}" ${mins} मिनट में शुरू होगा. रजिस्ट्रेशन: ${n}.`).catch(() => {});
      // People who registered with a phone number asked for this event's reminder: tell them too (max 200, slowly, in the background).
      const phones = [...new Set(this.store.listRegistrations(ev.id).map((r) => normalizePhone(r.phone)).filter(Boolean))].slice(0, 200);
      if (phones.length && this.notifier.sendTo) {
        const link = this.baseUrl ? `\n${this.baseUrl}/e/${ev.slug}` : '';
        this.notifier.sendTo(phones, `⏰ "${ev.title}" ${mins} मिनट में शुरू होगा.${link}`).catch(() => {});
      }
    }
  }
}

/** Digits only, country code included; a bare 10-digit number is taken as Indian (+91). */
export function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
