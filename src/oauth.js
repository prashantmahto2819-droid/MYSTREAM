import { randomToken } from './crypto.js';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const FB_VERSION = 'v19.0';
const FB_SCOPE = 'pages_show_list,pages_read_engagement,pages_manage_posts,publish_video';

export class OAuthError extends Error {}

/**
 * "Connect YouTube / Facebook": after the user signs in with Google or Facebook we can create a
 * live broadcast ourselves and receive its stream key, so keys never need to be copied by hand.
 * Tokens are stored encrypted. Everything goes through fetchImpl so it can be tested offline.
 */
export function makeOAuth({ cfg, store, vault, fetchImpl = fetch, now = Date.now }) {
  const states = new Map(); // state -> { userId, provider, exp }
  const redirect = (provider) => `${cfg.publicBaseUrl}/api/oauth/${provider}/callback`;

  const configured = () => ({
    google: !!(cfg.googleClientId && cfg.googleClientSecret && cfg.publicBaseUrl),
    facebook: !!(cfg.facebookAppId && cfg.facebookAppSecret && cfg.publicBaseUrl),
    redirects: { google: redirect('google'), facebook: redirect('facebook') },
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
        client_id: cfg.googleClientId, redirect_uri: redirect('google'), response_type: 'code', scope: GOOGLE_SCOPE,
        access_type: 'offline', prompt: 'consent', state,
      });
    }
    return `https://www.facebook.com/${FB_VERSION}/dialog/oauth?` + form({ client_id: cfg.facebookAppId, redirect_uri: redirect('facebook'), scope: FB_SCOPE, state, response_type: 'code' });
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
        body: form({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: redirect('google'), grant_type: 'authorization_code' }) }, 'Google sign-in');
      if (!tok.refresh_token) throw new OAuthError('Google did not give permanent access. Remove the app at myaccount.google.com/permissions and connect again.');
      const ch = await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tok.access_token}` } }, 'Reading your channel');
      const item = ch.items?.[0];
      if (!item) throw new OAuthError('This Google account has no YouTube channel.');
      return [save(userId, 'google', item.id, item.snippet?.title || 'YouTube channel', { refresh: tok.refresh_token, access: tok.access_token, exp: now() + (tok.expires_in || 3600) * 1000 })];
    }

    const short = await call(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?` + form({ client_id: cfg.facebookAppId, client_secret: cfg.facebookAppSecret, redirect_uri: redirect('facebook'), code }), {}, 'Facebook sign-in');
    const long = await call(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?` + form({ grant_type: 'fb_exchange_token', client_id: cfg.facebookAppId, client_secret: cfg.facebookAppSecret, fb_exchange_token: short.access_token }), {}, 'Facebook token');
    const pages = await call(`https://graph.facebook.com/${FB_VERSION}/me/accounts?` + form({ access_token: long.access_token, limit: '100' }), {}, 'Reading your pages');
    if (!pages.data?.length) throw new OAuthError('No Facebook Page found. Only Pages you manage can go live from here.');
    return pages.data.map((p) => save(userId, 'facebook', p.id, p.name, { page: p.access_token }));
  }

  const readToken = (conn) => JSON.parse(vault.decrypt(conn.token_enc));
  async function googleAccess(conn) {
    const t = readToken(conn);
    if (t.exp > now() + 60000) return t.access;
    const r = await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' }) }, 'Refreshing Google access');
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

  const create = (conn, opts) => (conn.provider === 'google' ? createYouTube(conn, opts) : createFacebook(conn, opts));
  return { configured, authUrl, handleCallback, create, youtubeChat, states };
}
