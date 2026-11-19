import net from 'node:net';

export const PRESETS = [
  { id: 'youtube', label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2' },
  { id: 'youtube-secure', label: 'YouTube (RTMPS)', url: 'rtmps://a.rtmps.youtube.com:443/live2' },
  { id: 'facebook', label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  { id: 'twitch', label: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
  { id: 'kick', label: 'Kick', url: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app' },
  { id: 'instagram', label: 'Instagram Live (paste server URL)', url: '' },
  { id: 'x', label: 'X / Twitter Live (paste server URL)', url: '' },
  { id: 'linkedin', label: 'LinkedIn Live (paste server URL)', url: '' },
  { id: 'tiktok', label: 'TikTok Live (paste server URL)', url: '' },
  { id: 'rumble', label: 'Rumble (paste server URL)', url: '' },
  { id: 'amazon', label: 'Amazon Live (paste server URL)', url: '' },
  { id: 'telegram', label: 'Telegram (paste server URL)', url: '' },
  { id: 'custom', label: 'Custom RTMP', url: '' },
];

const PLATFORM_IDS = new Set(PRESETS.map((p) => p.id));

export function cleanPlatform(v) {
  return PLATFORM_IDS.has(v) ? v : 'custom';
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || !h.includes('.') && !net.isIP(h)) {
    return true; // "localhost", docker service names like "mediamtx", ...
  }
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return true;
  return false;
}

/** Returns { ok: true, url } or { ok: false, error }. */
export function validateRtmpUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return { ok: false, error: 'Enter a valid RTMP URL' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Enter a valid RTMP URL' }; }
  if (u.protocol !== 'rtmp:' && u.protocol !== 'rtmps:') {
    return { ok: false, error: 'URL must start with rtmp:// or rtmps://' };
  }
  if (u.username || u.password) return { ok: false, error: 'Do not put a password in the URL' };
  if (isPrivateHost(u.hostname)) return { ok: false, error: 'Internal/private addresses are not allowed' };
  return { ok: true, url: raw };
}

export function validateStreamKey(input) {
  const k = String(input ?? '').trim();
  if (!k || k.length > 500 || /[\s\u0000-\u001f]/.test(k)) return { ok: false, error: 'Enter a valid stream key' };
  return { ok: true, key: k };
}

export function validateName(input, label = 'Name') {
  const n = String(input ?? '').trim();
  if (!n || n.length > 80) return { ok: false, error: `${label} is required (max 80 characters)` };
  return { ok: true, value: n };
}

export function validateEmail(input) {
  const e = String(input ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200
    ? { ok: true, value: e }
    : { ok: false, error: 'Enter a valid email' };
}

export function validatePassword(input) {
  const p = String(input ?? '');
  return p.length >= 8 && p.length <= 200
    ? { ok: true, value: p }
    : { ok: false, error: 'Password must be at least 8 characters' };
}
