// Netflix Quiet engine. Runs in the page's own JavaScript world at document_start.
//
// Netflix's ad plan works like this: the playback manifest the player loads
// for a title carries an `adverts` section listing the ad breaks (a pre-roll
// at 0 ms, mid-rolls later), and the player schedules them from that. So:
//
//   1. The `adverts` section is removed from the manifest before the player
//      reads it. Same for the data behind the ads shown on the pause screen.
//   2. If an ad plays anyway, it is muted and run at top speed until it ends.
//
// Part 1 is confirmed against real ad breaks. Part 2 has never had to run, so
// its ad detection is still a guess. The engine keeps a diagnostics log
// (structure and timings only, no tokens or account data) that the popup can
// copy out when something stops working.
(() => {
  'use strict';
  if (window.__nfQuiet) return;

  const state = { version: '0.1.1', pruned: 0, sped: 0 };
  Object.defineProperty(window, '__nfQuiet', { value: state });

  const native = {
    stringify: JSON.stringify,
    setTimeout: window.setTimeout.bind(window),
    now: () => Math.round(performance.now())
  };

  function report(kind) {
    state[kind]++;
    try {
      document.dispatchEvent(new CustomEvent('nq-count', { detail: `${kind}:1` }));
    } catch { /* counting is best effort */ }
  }

  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  // ------------------------------------------------------------ diagnostics

  const diag = {
    events: [],
    manifests: [],
    small: [],
    routes: [],
    samples: [],
    uia: new Map(),
    adClasses: new Set(),
    player: null,
    rateResets: 0
  };

  function note(type, data) {
    if (diag.events.length >= 200) return;
    diag.events.push({ t: native.now(), type, ...data });
  }

  // Describe a value's structure without its contents: key names, array
  // lengths, numbers and booleans, and only short word-like strings.
  function shape(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return /^[A-Za-z_]{1,24}$/.test(value) ? value : `string(${value.length})`;
    }
    if (typeof value !== 'object') return typeof value;
    if (depth >= 5) return Array.isArray(value) ? `array(${value.length})` : 'object';
    if (Array.isArray(value)) {
      return { length: value.length, first: value.length ? shape(value[0], depth + 1) : undefined };
    }
    const out = {};
    for (const key of Object.keys(value).slice(0, 40)) out[key] = shape(value[key], depth + 1);
    return out;
  }

  const seconds = ms => (typeof ms === 'number' ? Math.round(ms / 100) / 10 : null);
  const word = value => (typeof value === 'string' && /^[A-Za-z_]{1,24}$/.test(value) ? value : shape(value, 5));
  // A short tag to tell titles apart in a report without naming them.
  const tag = id => (typeof id === 'number' ? (Math.imul(id | 0, 0x9e3779b1) >>> 0) % 9973 : null);

  // Which script asked for this JSON (file name only).
  function callerFile() {
    try {
      for (const line of String(new Error().stack).split('\n').slice(2)) {
        if (line.includes('chrome-extension://')) continue;
        const match = /https?:\/\/[^\s)]+/.exec(line);
        if (match) return match[0].split('?')[0].split('/').pop().replace(/(:\d+)+$/, '').slice(0, 60);
      }
    } catch { /* no stack */ }
    return null;
  }

  function describeBreaks(adverts) {
    const breaks = isObject(adverts) && Array.isArray(adverts.adBreaks) ? adverts.adBreaks : null;
    if (!breaks) return null;
    return breaks.slice(0, 12).map(item => ({
      at: seconds(item?.locationMs),
      ads: Array.isArray(item?.ads)
        ? item.ads.slice(0, 8).map(one => ({ s: seconds(one?.endTimeMs - one?.startTimeMs), type: word(one?.type), id: tag(one?.id) }))
        : shape(item?.ads, 4)
    }));
  }

  function describeManifest(manifest) {
    const adverts = manifest.adverts;
    const aux = manifest.auxiliaryManifests;
    return {
      id: tag(manifest.movieId),
      keys: Object.keys(manifest).length,
      isAd: manifest.isAd,
      type: word(manifest.type),
      viewableType: word(manifest.viewableType),
      streamingType: word(manifest.streamingType),
      partial: manifest.partiallyHydrated,
      supplemental: manifest.isSupplemental,
      licensed: 'licenses' in manifest,
      durationS: seconds(manifest.duration),
      aux: Array.isArray(aux)
        ? aux.slice(0, 8).map(item => (isObject(item)
          ? { id: tag(item.movieId), isAd: item.isAd, durationS: seconds(item.duration), keys: Object.keys(item).length, breaks: describeBreaks(item.adverts)?.length ?? null }
          : shape(item, 4)))
        : shape(aux, 3),
      advertsKeys: isObject(adverts) ? Object.keys(adverts).slice(0, 12) : shape(adverts),
      breaks: describeBreaks(adverts)
    };
  }

  // -------------------------------------- part 1: take ads out of the data

  function pruneManifest(manifest, via, top) {
    if (!isObject(manifest)) return 0;
    const looksLikeManifest = 'movieId' in manifest || 'playbackContextId' in manifest ||
      'videoTracks' in manifest || 'audioTracks' in manifest ||
      'video_tracks' in manifest || 'audio_tracks' in manifest;
    if (!looksLikeManifest && !('adverts' in manifest)) return 0;
    const adverts = manifest.adverts;

    if (looksLikeManifest) {
      if (diag.manifests.length < 40) {
        diag.manifests.push({ t: native.now(), via, from: callerFile(), top, ...describeManifest(manifest) });
      }
    } else {
      // Small objects that carry nothing but an `adverts` entry. They follow
      // each manifest; identical ones in a row are counted rather than listed.
      const entry = { via, from: callerFile(), top, keys: Object.keys(manifest).slice(0, 12), adverts: shape(adverts, 2) };
      const key = native.stringify(entry);
      const last = diag.small[diag.small.length - 1];
      if (last && last.key === key) last.count++;
      else if (diag.small.length < 30) diag.small.push({ t: native.now(), key, count: 1, ...entry });
    }

    // Only a real ad section is removed; a bare flag is left as it is.
    if (!isObject(adverts)) return 0;
    const hadBreaks = Array.isArray(adverts.adBreaks) && adverts.adBreaks.length > 0;
    delete manifest.adverts;
    return hadBreaks ? 2 : 1;
  }

  function prune(data, via) {
    if (!isObject(data)) return;
    const result = data.result;
    const top = result === undefined ? null : Object.keys(data).slice(0, 12);
    let removed = 0;
    if (Array.isArray(result)) {
      for (const item of result.slice(0, 8)) removed = Math.max(removed, pruneManifest(item, via, top));
    } else {
      removed = pruneManifest(result, via, top);
    }
    // Ads on the pause screen come from their own request.
    const pause = data.data && data.data.pinotPausedPlaybackPage;
    if (isObject(pause)) {
      note('pause-ad-pruned', { via, shape: shape(pause, 3) });
      delete data.data.pinotPausedPlaybackPage;
      removed = 2;
    }
    // Count what actually held ads, not every empty section.
    if (removed === 2) report('pruned');
  }

  JSON.parse = new Proxy(JSON.parse, {
    apply(target, self, args) {
      const data = Reflect.apply(target, self, args);
      try { prune(data, 'parse'); } catch { /* leave the data as it came */ }
      return data;
    }
  });
  Response.prototype.json = new Proxy(Response.prototype.json, {
    apply(target, self, args) {
      return Reflect.apply(target, self, args).then(data => {
        try { prune(data, 'json'); } catch { /* leave the data as it came */ }
        return data;
      });
    }
  });

  // -------------------------------------- part 2: an ad that plays anyway

  // The "Ad 1 of 2 · 0:20" badge the player shows during an ad.
  const AD_BADGE = '[data-uia="ads-info-container"], [data-uia^="ads-info-"]';
  const AD_RATE = 16;
  const ad = { active: false, startedAt: 0, restore: new Map() };

  const onWatchPage = () => location.pathname.startsWith('/watch');
  const isVisible = node => node.getClientRects().length > 0;

  function adBadge() {
    for (const node of document.querySelectorAll(AD_BADGE)) {
      if (isVisible(node)) return node;
    }
    return null;
  }

  function watchAds() {
    const badge = onWatchPage() ? adBadge() : null;
    const videos = document.querySelectorAll('video');

    if (badge) {
      if (!ad.active) {
        ad.active = true;
        ad.startedAt = native.now();
        report('sped');
        note('ad-start', { badge: badge.getAttribute('data-uia'), text: (badge.textContent || '').trim().slice(0, 60), videos: videos.length });
      }
      for (const video of videos) {
        if (!ad.restore.has(video)) ad.restore.set(video, { rate: video.playbackRate, muted: video.muted });
        if (!video.muted) video.muted = true;
        if (video.playbackRate !== AD_RATE) {
          if (ad.restore.get(video).applied) diag.rateResets++;
          ad.restore.get(video).applied = true;
          try { video.playbackRate = AD_RATE; } catch (error) { note('rate-error', { message: String(error).slice(0, 80) }); }
        }
      }
      return;
    }

    if (ad.active) {
      ad.active = false;
      note('ad-end', { ms: native.now() - ad.startedAt, rateResets: diag.rateResets });
      for (const [video, before] of ad.restore) {
        try {
          video.playbackRate = before.rate || 1;
          video.muted = before.muted;
        } catch { /* the element is gone */ }
      }
      ad.restore.clear();
    }
  }

  // --------------------------------------------- what the page looked like

  function currentPlayer() {
    const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = api?.getAllPlayerSessionIds?.() || [];
    return ids.length ? api.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
  }

  // The player's method names, read once while a title is open, so a report
  // taken later from another page still has them.
  function describePlayer() {
    const player = currentPlayer();
    if (!player) return null;
    const names = new Set();
    for (let node = player; node && node !== Object.prototype; node = Object.getPrototypeOf(node)) {
      for (const name of Object.getOwnPropertyNames(node)) {
        try { if (typeof player[name] === 'function') names.add(name); } catch { /* getter threw */ }
      }
    }
    return { t: native.now(), methods: [...names].sort().slice(0, 300) };
  }

  let lastRoute = null;
  let lastScan = -Infinity;
  let lastSample = -Infinity;
  function observe() {
    const now = native.now();
    const route = `/${location.pathname.split('/')[1] || ''}`;
    if (route !== lastRoute) {
      lastRoute = route;
      if (diag.routes.length < 60) diag.routes.push({ t: now, route });
    }
    if (!onWatchPage()) return;

    if (now - lastScan >= 1000) {
      lastScan = now;
      // Every player UI marker, with when it first appeared: an ad UI shows up
      // as a group of names that arrive together.
      for (const node of document.querySelectorAll('[data-uia]')) {
        const name = node.getAttribute('data-uia');
        if (diag.uia.size < 400 && !diag.uia.has(name)) diag.uia.set(name, now);
      }
      if (diag.adClasses.size < 40) {
        for (const node of document.querySelectorAll('[class*="adsInfo"], [class*="AdsInfo"], [class*="adBreak"], [class*="ad-break"], [class*="advert"]')) {
          diag.adClasses.add(String(node.getAttribute('class')).slice(0, 80));
        }
      }
      if (!diag.player) {
        try { diag.player = describePlayer(); } catch { /* try again next second */ }
      }
    }

    if (now - lastSample >= 5000) {
      lastSample = now;
      const sample = { t: now, ad: Boolean(adBadge()), videos: [] };
      for (const video of document.querySelectorAll('video')) {
        sample.videos.push([
          Math.round(video.currentTime),
          Number.isFinite(video.duration) ? Math.round(video.duration) : null,
          video.playbackRate,
          video.paused ? 'paused' : 'playing',
          video.readyState
        ]);
      }
      try {
        const player = currentPlayer();
        if (player) sample.api = [seconds(player.getCurrentTime?.()), seconds(player.getDuration?.())];
      } catch { /* player not ready */ }
      diag.samples.push(sample);
      if (diag.samples.length > 120) diag.samples.shift();
    }
  }

  function pass() {
    try { watchAds(); } catch { /* keep the watchdog alive */ }
    try { observe(); } catch { /* keep the watchdog alive */ }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    native.setTimeout(() => {
      scheduled = false;
      pass();
    }, 50);
  }

  function startWatchdog() {
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true });
    setInterval(pass, 250);
  }
  if (document.documentElement) startWatchdog();
  else document.addEventListener('readystatechange', startWatchdog, { once: true });

  // ---------------------------------------------------- report for the popup

  function buildReport() {
    const badge = adBadge();
    try { if (currentPlayer()) diag.player = describePlayer(); } catch { /* keep the stored one */ }
    const uia = Object.fromEntries(diag.uia);
    return native.stringify({
      netflixQuietReport: 2,
      version: state.version,
      uptimeMs: native.now(),
      counts: { pruned: state.pruned, sped: state.sped, rateResets: diag.rateResets },
      adNow: Boolean(badge),
      adBadgeHtml: badge ? badge.outerHTML.replace(/\s+/g, ' ').slice(0, 700) : null,
      routes: diag.routes,
      manifests: diag.manifests,
      small: diag.small.map(({ key, ...entry }) => entry),
      events: diag.events,
      samples: diag.samples,
      uiaFirstSeen: uia,
      uiaWithAd: Object.keys(uia).filter(name => /ad/i.test(name)),
      adClasses: [...diag.adClasses],
      player: diag.player
    });
  }

  document.addEventListener('nq-report-request', () => {
    let text;
    try { text = buildReport(); } catch (error) { text = native.stringify({ netflixQuietReport: 2, error: String(error) }); }
    document.dispatchEvent(new CustomEvent('nq-report', { detail: text }));
  });
})();
