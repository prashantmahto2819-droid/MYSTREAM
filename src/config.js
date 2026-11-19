const gb = (v, dflt) => Math.round(Number(v || dflt) * 1024 ** 3);

// All settings come from environment variables (see .env.example).
export function loadConfig(e = process.env) {
  const secret = e.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('APP_SECRET must be set to a random string of 16+ characters');
  }
  return {
    port: Number(e.PORT || 3000),
    host: e.HOST || '0.0.0.0',
    dataDir: e.DATA_DIR || './data',
    secret,
    mediamtxApi: (e.MEDIAMTX_API || 'http://mediamtx:9997').replace(/\/$/, ''),
    mediamtxRtmp: (e.MEDIAMTX_RTMP || 'rtmp://mediamtx:1935').replace(/\/$/, ''),
    publicRtmpUrl: (e.PUBLIC_RTMP_URL || 'rtmp://localhost/live').replace(/\/$/, ''),
    ffmpegBin: e.FFMPEG_BIN || 'ffmpeg',
    pollMs: Number(e.POLL_MS || 2000),
    backoffBaseMs: Number(e.BACKOFF_BASE_MS || 2000),
    backoffMaxMs: Number(e.BACKOFF_MAX_MS || 30000),
    stableMs: Number(e.STABLE_MS || 4000),
    maxDestinationsPerUser: Number(e.MAX_DESTINATIONS || 10),
    adminEmail: e.ADMIN_EMAIL || '',
    adminPassword: e.ADMIN_PASSWORD || '',

    // video uploads / scheduling
    ffprobeBin: e.FFPROBE_BIN || 'ffprobe',
    maxUploadBytes: gb(e.MAX_UPLOAD_GB, 20),
    userQuotaBytes: gb(e.USER_QUOTA_GB, 30),
    diskReserveBytes: gb(e.DISK_RESERVE_GB, 3),
    lateStartMs: Number(e.LATE_START_MINUTES || 10) * 60000,
    schedulePollMs: Number(e.SCHEDULE_POLL_MS || 5000),

    // "Connect YouTube / Facebook" (optional). PUBLIC_BASE_URL is the https address of the dashboard.
    publicBaseUrl: (e.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    googleClientId: e.GOOGLE_CLIENT_ID || '',
    googleClientSecret: e.GOOGLE_CLIENT_SECRET || '',
    facebookAppId: e.FACEBOOK_APP_ID || '',
    facebookAppSecret: e.FACEBOOK_APP_SECRET || '',
    twitchClientId: e.TWITCH_CLIENT_ID || '',
    twitchClientSecret: e.TWITCH_CLIENT_SECRET || '',

    // recording of lives
    recordingKeepDays: Number(e.RECORDING_KEEP_DAYS || 7),
    recordingMaxHours: Number(e.RECORDING_MAX_HOURS || 6),

    // WhatsApp (or any HTTP) alerts - see README
    alertUrl: e.ALERT_WEBHOOK_URL || '',
    alertAuth: e.ALERT_WEBHOOK_AUTH || '',
    alertBodyTemplate: e.ALERT_BODY_TEMPLATE || '{"to":"{{to}}","message":"{{message}}"}',
    alertTo: (e.ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    alertCooldownMs: Number(e.ALERT_COOLDOWN_MINUTES || 5) * 60000,
  };
}
