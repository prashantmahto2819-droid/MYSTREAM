import { randomToken } from './crypto.js';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const FB_VERSION = 'v19.0';
const FB_SCOPE = 'pages_show_list,pages_read_engagement,pages_manage_posts,publish_video';
const TWITCH_SCOPE = 'channel:read:stream_key channel:manage:broadcast';

export class OAuthError extends Error {}

/**
 * "Connect YouTube / Facebook": after the user signs in with Google or Facebook we can create a
 * live broadcast ourselves and receive its stream key, so keys never need to be copied by hand.
 * Tokens are stored encrypted. Everything goes through fetchImpl so it can be tested offline.
 */
export function makeOAuth({ cfg, store, vault, fetchImpl = fetch, now = Date.now }) {
  const states = new Map(); // state -> { userId, provider, exp }
  const KEYS = ['googleClientId', 'googleClientSecret', 'facebookAppId', 'facebookAppSecret', 'twitchClientId', 'twitchClientSecret', 'publicBaseUrl'];
  // values saved from the dashboard (encrypted) win over the .env file
  const cv = (k) => {
    try { const raw = store.getSetting?.(`oauth_${k}`); if (raw) return vault.decrypt(raw); } catch { /* fall back to env */ }
    return cfg[k] || '';
  };
  const redirect = (provider) => `${cv('publicBaseUrl')}/api/oauth/${provider}/callback`;

  const configured = () => ({
    google: !!(cv('googleClientId') && cv('googleClientSecret') && cv('publicBaseUrl')),
    facebook: !!(cv('facebookAppId') && cv('facebookAppSecret') && cv('publicBaseUrl')),
    twitch: !!(cv('twitchClientId') && cv('twitchClientSecret') && cv('publicBaseUrl')),
    redirects: { google: redirect('google'), facebook: redirect('facebook'), twitch: redirect('twitch') },
  });

  const call = async (url, opts = {}, what = 'request') => {
    const res = await fetchImpl(url, opts);
    const text = await res.text();
    let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    if (!res.ok) {
      const msg = json.error?.message || json.error_description || (typeof json.error === 'string' ? json.error : '') || text.slice(0, 200);
      throw new OAuthError(`${what} failed (${res.status}): ${msg}`);
    }
    return json;
  };
  const form = (o) => new URLSearchParams(o).toString();

  function authUrl(provider, userId) {
    const c = configured();
    if (!c[provider]) throw new OAuthError(`${provider} is not set up on this server`);
    for (const [k, v] of states) if (v.exp < now()) states.delete(k);
    const state = randomToken(16);
    states.set(state, { userId, provider, exp: now() + 10 * 60000 });
    if (provider === 'google') {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + form({
        client_id: cv('googleClientId'), redirect_uri: redirect('google'), response_type: 'code', scope: GOOGLE_SCOPE,
        access_type: 'offline', prompt: 'consent', state,
      });
    }
    if (provider === 'twitch') {
      return 'https://id.twitch.tv/oauth2/authorize?' + form({ client_id: cv('twitchClientId'), redirect_uri: redirect('twitch'), response_type: 'code', scope: TWITCH_SCOPE, state, force_verify: 'true' });
    }
    return `https://www.facebook.com/${FB_VERSION}/dialog/oauth?` + form({ client_id: cv('facebookAppId'), redirect_uri: redirect('facebook'), scope: FB_SCOPE, state, response_type: 'code' });
  }

  const save = (userId, provider, remoteId, accountName, token) => store.upsertConnection({ userId, provider, remoteId, accountName, tokenEnc: vault.encrypt(JSON.stringify(token)) });

  /** Finishes the sign-in. Returns the connection ids that were saved. */
  async function handleCallback(provider, { code, state, error }, userId) {
    const st = states.get(state || '');
    states.delete(state || '');
    if (!st || st.exp < now() || st.provider !== provider || st.userId !== userId) throw new OAuthError('Sign-in expired. Please try again.');
    if (error || !code) throw new OAuthError(error === 'access_denied' ? 'You cancelled the sign-in.' : 'Sign-in failed.');

    if (provider === 'google') {
      const tok = await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ code, client_id: cv('googleClientId'), client_secret: cv('googleClientSecret'), redirect_uri: redirect('google'), grant_type: 'authorization_code' }) }, 'Google sign-in');
      if (!tok.refresh_token) throw new OAuthError('Google did not give permanent access. Remove the app at myaccount.google.com/permissions and connect again.');
      const ch = await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tok.access_token}` } }, 'Reading your channel');
      const item = ch.items?.[0];
      if (!item) throw new OAuthError('This Google account has no YouTube channel.');
      return [save(userId, 'google', item.id, item.snippet?.title || 'YouTube channel', { refresh: tok.refresh_token, access: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000 })];
    }

    if (provider === 'twitch') {
      const tok = await call('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: cv('twitchClientId'), client_secret: cv('twitchClientSecret'), code, grant_type: 'authorization_code', redirect_uri: redirect('twitch') }) }, 'Twitch sign-in');
      const me = await call('https://api.twitch.tv/helix/users', { headers: { authorization: `Bearer ${tok.access_token}`, 'client-id': cv('twitchClientId') } }, 'Reading your Twitch channel');
      const u = me.data?.[0]; if (!u) throw new OAuthError('Could not read your Twitch channel.');
      return [save(userId, 'twitch', u.id, u.display_name || u.login, { refresh: tok.refresh_token, access: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000, login: u.login })];
    }

    const short = await call(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?` + form({ client_id: cv('facebookAppId'), client_secret: cv('facebookAppSecret'), redirect_uri: redirect('facebook'), code }), {}, 'Facebook sign-in');
    const long = await call(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?` + form({ grant_type: 'fb_exchange_token', client_id: cv('facebookAppId'), client_secret: cv('facebookAppSecret'), fb_exchange_token: short.access_token }), {}, 'Facebook token');
    const pages = await call(`https://graph.facebook.com/${FB_VERSION}/me/accounts?` + form({ access_token: long.access_token, limit: '100' }), {}, 'Reading your pages');
    if (!pages.data?.length) throw new OAuthError('No Facebook Page found. Only Pages you manage can go live from here.');
    return pages.data.map((p) => save(userId, 'facebook', p.id, p.name, { page: p.access_token }));
  }

  const readToken = (conn) => JSON.parse(vault.decrypt(conn.token_enc));
  async function googleAccess(conn) {
    const t = readToken(conn);
    if (t.exp > now() + 60000) return t.access;
    const r = await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: cv('googleClientId'), client_secret: cv('googleClientSecret'), refresh_token: t.refresh, grant_type: 'refresh_token' }) }, 'Refreshing Google access');
    store.updateConnectionToken(conn.id, vault.encrypt(JSON.stringify({ ...t, access: r.access_token, exp: now() + (r.expires_in || 3600) * 1000 })));
    return r.access_token;
  }

  /** Creates a YouTube broadcast + stream, binds them and returns where to send video. */
  async function createYouTube(conn, { title, privacy = 'unlisted', startAt = null, description = '' }) {
    const access = await googleAccess(conn);
    const h = { authorization: `Bearer ${access}`, 'content-type': 'application/json' };
    const api = 'https://www.googleapis.com/youtube/v3';
    const stream = await call(`${api}/liveStreams?part=snippet,cdn,contentDetails`, { method: 'POST', headers: h, body: JSON.stringify({
      snippet: { title }, cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' }, contentDetails: { isReusable: false } }) }, 'Creating YouTube stream');
    const bc = await call(`${api}/liveBroadcasts?part=snippet,status,contentDetails`, { method: 'POST', headers: h, body: JSON.stringify({
      snippet: { title, description, scheduledStartTime: new Date(startAt || now() + 60000).toISOString() },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true } }) }, 'Creating YouTube broadcast');
    await call(`${api}/liveBroadcasts/bind?` + form({ id: bc.id, part: 'id,contentDetails', streamId: stream.id }), { method: 'POST', headers: h }, 'Linking stream');
    const info = stream.cdn?.ingestionInfo;
    if (!info?.ingestionAddress || !info?.streamName) throw new OAuthError('YouTube did not return a stream key.');
    return { rtmpUrl: info.ingestionAddress, streamKey: info.streamName, platform: 'youtube', watchUrl: `https://youtu.be/${bc.id}`, name: `YouTube: ${title}` };
  }

  async function createFacebook(conn, { title, description = '' }) {
    const t = readToken(conn);
    const v = await call(`https://graph.facebook.com/${FB_VERSION}/${conn.remote_id}/live_videos`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ access_token: t.page, title, description, status: 'LIVE_NOW' }) }, 'Creating Facebook live');
    const full = v.secure_stream_url || v.stream_url || '';
    const i = full.lastIndexOf('/rtmp/');
    if (i < 0) throw new OAuthError('Facebook did not return a stream key.');
    return { rtmpUrl: full.slice(0, i + 6), streamKey: full.slice(i + 6), platform: 'facebook', watchUrl: `https://www.facebook.com/${v.id}`, name: `Facebook: ${title}` };
  }

  async function twitchAccess(conn) {
    const t = readToken(conn);
    if (t.exp > now() + 60000) return t.access;
    const r = await call('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: cv('twitchClientId'), client_secret: cv('twitchClientSecret'), grant_type: 'refresh_token', refresh_token: t.refresh }) }, 'Refreshing Twitch access');
    store.updateConnectionToken(conn.id, vault.encrypt(JSON.stringify({ ...t, access: r.access_token, refresh: r.refresh_token || t.refresh, exp: now() + (r.expires_in || 3600) * 1000 })));
    return r.access_token;
  }
  async function createTwitch(conn, { title }) {
    const access = await twitchAccess(conn); const t = readToken(conn);
    const h = { authorization: `Bearer ${access}`, 'client-id': cv('twitchClientId') };
    const k = await call(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(conn.remote_id)}`, { headers: h }, 'Reading your Twitch stream key');
    const key = k.data?.[0]?.stream_key; if (!key) throw new OAuthError('Twitch did not return a stream key.');
    try { await call(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(conn.remote_id)}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ title }) }, 'Setting the Twitch title'); } catch { /* the title is optional */ }
    return { rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: key, platform: 'twitch', watchUrl: `https://www.twitch.tv/${t.login || ''}`, name: `Twitch: ${title}` };
  }

  // ---- YouTube live chat (read) ----
  const chatIds = new Map(); // connection id -> { id, exp }
  async function youtubeChat(conn, pageToken = '') {
    if (conn.provider !== 'google') throw new OAuthError('Chat is only available for YouTube accounts.');
    const access = await googleAccess(conn);
    const h = { authorization: `Bearer ${access}` };
    const api = 'https://www.googleapis.com/youtube/v3';
    let cached = chatIds.get(conn.id);
    if (!cached || cached.exp < now()) {
      const r = await call(`${api}/liveBroadcasts?` + form({ part: 'snippet', broadcastStatus: 'active', mine: 'true' }), { headers: h }, 'Finding your live');
      const id = r.items?.[0]?.snippet?.liveChatId;
      if (!id) throw new OAuthError('No live broadcast is active on this channel right now.');
      cached = { id, exp: now() + 5 * 60000 }; chatIds.set(conn.id, cached);
    }
    const q = { liveChatId: cached.id, part: 'snippet,authorDetails', maxResults: '200' };
    if (pageToken) q.pageToken = pageToken;
    const r = await call(`${api}/liveChat/messages?` + form(q), { headers: h }, 'Reading chat');
    return {
      messages: (r.items || []).filter((m) => m.snippet?.displayMessage).map((m) => ({ id: m.id, author: m.authorDetails?.displayName || '', text: m.snippet.displayMessage })),
      next: r.nextPageToken || '', waitMs: Math.max(Number(r.pollingIntervalMillis) || 5000, 3000),
    };
  }

  const create = (conn, opts) => (conn.provider === 'google' ? createYouTube(conn, opts) : conn.provider === 'twitch' ? createTwitch(conn, opts) : createFacebook(conn, opts));

  /** What the admin has set up (never the secrets themselves). */
  function setupStatus() {
    return { publicBaseUrl: cv('publicBaseUrl'), set: Object.fromEntries(KEYS.filter((k) => k !== 'publicBaseUrl').map((k) => [k, !!cv(k)])), redirects: configured().redirects, configured: (({ redirects, ...rest }) => rest)(configured()) };
  }
  function saveSetup(values = {}) {
    for (const k of KEYS) {
      if (values[k] === undefined) continue;
      let v = String(values[k]).trim().slice(0, 400); if (!v) continue;
      if (k === 'publicBaseUrl') { v = v.replace(/\/+$/, ''); if (!/^https?:\/\/[^\s/]+$/.test(v)) throw new OAuthError('The site address must look like https://live.example.com'); }
      store.setSetting(`oauth_${k}`, vault.encrypt(v));
    }
    for (const k of values.clear || []) if (KEYS.includes(k)) store.deleteSetting(`oauth_${k}`);
  }
  return { configured, authUrl, handleCallback, create, youtubeChat, setupStatus, saveSetup, states };
}
