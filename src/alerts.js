// Turns relay / scheduler events into activity-log lines and WhatsApp (webhook) alerts.
const quiet = (p) => p?.catch?.(() => {});

export function relayEventHandler({ store, notifier }) {
  return (ev) => {
    if (ev.type === 'ingest_started') {
      store.addActivity(ev.userId, 'obs_live_started', `${ev.detail} destinations`);
      quiet(notifier.send(ev.userId, `🔴 ${ev.name} का OBS से लाइव शुरू हुआ (${ev.detail} चैनल पर)`, { key: `ingest:${ev.userId}` }));
      return;
    }
    if (ev.type === 'ingest_dropped') {
      store.addActivity(ev.userId, 'obs_stream_dropped');
      quiet(notifier.send(ev.userId, `⚠️ ${ev.name} की OBS स्ट्रीम कट गई. सभी चैनल पर लाइव रुक गया है.`, { key: `drop:${ev.userId}` }));
      return;
    }
    store.addActivity(ev.userId, `relay_${ev.type}`, `${ev.name}${ev.detail ? ': ' + ev.detail : ''}`);
    if (ev.type === 'slow') {
      quiet(notifier.send(ev.userId, `🐢 ${ev.name}: इंटरनेट धीमा है (${ev.detail}), लाइव अटक सकता है.`, { key: `slow:${ev.destId}` }));
    }
    if (ev.type === 'error') {
      quiet(notifier.send(ev.userId, `⚠️ ${ev.name}: स्ट्रीम में दिक्कत आई है. ${ev.detail || ''}`.trim(), { key: `relay:${ev.destId}` }));
    }
  };
}

export function playerEventHandler({ store, notifier }) {
  return (ev) => {
    const t = ev.schedule?.title || '';
    const log = (action, detail = t) => store.addActivity(ev.userId, action, detail);
    switch (ev.type) {
      case 'started':
        log('schedule_started', `${t} (${ev.destinations} destinations)`);
        quiet(notifier.send(ev.userId, `🔴 लाइव शुरू: ${t} (${ev.destinations} चैनल पर)`));
        break;
      case 'done':
        log('schedule_done');
        quiet(notifier.send(ev.userId, `✅ लाइव पूरा हुआ: ${t}`));
        break;
      case 'failed':
        log('schedule_failed', `${t}: ${ev.schedule.error}`);
        quiet(notifier.send(ev.userId, `❌ शेड्यूल्ड लाइव फेल हुआ: ${t}. कारण: ${ev.schedule.error}`));
        break;
      case 'missed':
        log('schedule_missed', t);
        quiet(notifier.send(ev.userId, `⏰ शेड्यूल्ड लाइव छूट गया: ${t}. सर्वर तय समय पर तैयार नहीं था.`));
        break;
      case 'cancelled':
        log('schedule_ended_by_user');
        break;
      case 'video_deleted':
        log('video_auto_deleted', ev.video.title);
        break;
      default:
    }
  };
}

export function standbyEventHandler({ store, notifier }) {
  return (ev) => {
    const log = (a, d = '') => store.addActivity(ev.userId, a, d);
    switch (ev.type) {
      case 'standby_started':
        log('standby_started', `${ev.detail} min`);
        quiet(notifier.send(ev.userId, `⏸️ ${ev.name}: OBS कट गया. स्टैंडबाय स्क्रीन चालू है (अधिकतम ${ev.detail} मिनट). OBS दोबारा जोड़ें या dashboard से बंद करें.`, { key: `standby:${ev.userId}` }));
        break;
      case 'standby_ended': log('standby_ended_obs_back'); break;
      case 'standby_stopped': log('standby_stopped_by_user'); break;
      case 'standby_timeout':
        log('standby_timeout');
        quiet(notifier.send(ev.userId, `⏹️ ${ev.name}: OBS वापस नहीं आया, स्टैंडबाय बंद हुआ और लाइव रुक गया.`, { key: `standby-end:${ev.userId}` }));
        break;
      case 'standby_failed': log('standby_failed', ev.detail || ''); break;
      default:
    }
  };
}

export function recorderEventHandler({ store }) {
  return (ev) => {
    const map = { record_started: 'recording_started', record_saved: 'recording_saved', record_skipped: 'recording_skipped' };
    if (map[ev.type]) store.addActivity(ev.userId, map[ev.type], ev.detail || '');
  };
}
