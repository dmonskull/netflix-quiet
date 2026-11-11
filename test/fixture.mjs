// Offline check of the engine against a fake Netflix watch page. The fake
// data follows the shapes seen in a real session on the ad plan.
// Start a browser with test/launch.sh first, then: node test/fixture.mjs
import assert from 'node:assert/strict';
import { CDP, PORT, extensionId } from './cdp.mjs';

const VERSION = '0.1.1';
const SECRET = 'SECRET-TOKEN-abcdef0123456789==';
const adBreak = (locationMs, ads) => ({
  ads,
  actionAdBreakEvents: {
    start: { event: 'adBreakStart', adEventToken: SECRET },
    miss: { event: 'adBreakMiss', adEventToken: SECRET },
    stop: { event: 'adBreakStop', adEventToken: SECRET },
    complete: { event: 'adBreakComplete', adEventToken: SECRET }
  },
  adBreakToken: SECRET,
  auditPingUrl: `https://ads.example.invalid/${SECRET}`,
  segmentCategories: [],
  locationMs
});
const playableAd = (id, ms) => ({
  timedAdEvents: [{ token: SECRET }],
  actionAdEvents: { click: { adEventToken: SECRET } },
  id,
  startTimeMs: 0,
  endTimeMs: ms,
  type: 'PLAYABLE_AD',
  is3pVerificationEnabled: false
});
const manifest = (movieId, adverts, extra = {}) => ({
  audioTracks: [],
  videoTracks: [{ streams: [] }],
  movieId,
  playbackContextId: SECRET,
  drmContextId: SECRET,
  duration: 2700000,
  type: 'standard',
  viewableType: 'EPISODE',
  isAd: false,
  isSupplemental: false,
  partiallyHydrated: false,
  auxiliaryManifests: [],
  adverts,
  ...extra
});
const withBreaks = id => manifest(id, { adBreaks: [adBreak(0, [playableAd(83364758, 30030)]), adBreak(600000, [])] }, { licenses: [{ data: SECRET }] });

const LICENSED_JSON = JSON.stringify({ version: 2, serverTime: 1, result: withBreaks(81000001) });
const PREFETCH_JSON = JSON.stringify({ version: 2, result: manifest(81000001, { adBreaks: [] }, { partiallyHydrated: true }) });
const ARRAY_JSON = JSON.stringify({ version: 2, result: [withBreaks(81000002), withBreaks(81000003)] });
const SMALL_JSON = ['{"result":{"adverts":{}}}', '{"result":{"adverts":{"daiSupported":true}}}', '{"result":{"adverts":{"daiSupported":true}}}'];
const DECOY_JSON = '{"result":{"movieId":1,"adverts":true}}';
const UNRELATED_JSON = '{"result":{"items":[1,2]},"data":{"other":1}}';
const PAUSE_JSON = JSON.stringify({ data: { other: 'kept', pinotPausedPlaybackPage: { sections: [{ ad: { token: SECRET } }] } } });

const PAGE = `<!doctype html><title>Netflix Quiet fixture</title>
<body>
<div data-uia="player"><video></video></div>
<div data-uia="timeline-ad-break-marker">marker</div>
<script>
const out = window.fixture = { engine: window.__nfQuiet?.version || null };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakePlayer = { getCurrentTime: () => 12000, getDuration: () => 2700000, seek() {}, play() {}, pause() {} };
window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
  getAllPlayerSessionIds: () => ['watch-1'],
  getVideoPlayerBySessionId: () => fakePlayer
} }) } } } };
(async () => {
  try {
    const licensed = JSON.parse(${JSON.stringify(LICENSED_JSON)});
    out.licensedAdverts = 'adverts' in licensed.result;
    out.licensedKept = licensed.result.movieId === 81000001 && licensed.result.videoTracks.length === 1 && licensed.result.licenses.length === 1;
    out.prefetchAdverts = 'adverts' in JSON.parse(${JSON.stringify(PREFETCH_JSON)}).result;
    out.arrayAdverts = JSON.parse(${JSON.stringify(ARRAY_JSON)}).result.map(item => 'adverts' in item);
    out.responseAdverts = 'adverts' in (await new Response(${JSON.stringify(LICENSED_JSON)}).json()).result;
    out.small = ${JSON.stringify(SMALL_JSON)}.map(text => JSON.stringify(JSON.parse(text)));
    out.decoy = JSON.stringify(JSON.parse(${JSON.stringify(DECOY_JSON)}));
    out.unrelated = JSON.stringify(JSON.parse(${JSON.stringify(UNRELATED_JSON)}));
    const pauseData = JSON.parse(${JSON.stringify(PAUSE_JSON)}).data;
    out.pauseAd = 'pinotPausedPlaybackPage' in pauseData;
    out.pauseKept = pauseData.other;

    // An ad badge appears: the video is muted and sped up, and stays that way
    // even if the player puts the speed back.
    const video = document.querySelector('video');
    video.muted = false;
    video.playbackRate = 1.25;
    await sleep(400);
    out.beforeAd = { rate: video.playbackRate, muted: video.muted };
    const badge = document.createElement('div');
    badge.setAttribute('data-uia', 'ads-info-container');
    badge.textContent = 'Ad 1 of 2';
    document.body.append(badge);
    await sleep(700);
    out.duringAd = { rate: video.playbackRate, muted: video.muted };
    video.playbackRate = 1;
    await sleep(700);
    out.afterPlayerReset = video.playbackRate;
    badge.remove();
    await sleep(500);
    out.afterAd = { rate: video.playbackRate, muted: video.muted };

    // A badge that is in the page but not shown must not trigger anything.
    const hidden = document.createElement('div');
    hidden.setAttribute('data-uia', 'ads-info-container');
    hidden.style.display = 'none';
    document.body.append(hidden);
    await sleep(500);
    out.hiddenBadge = { rate: video.playbackRate, muted: video.muted };
    hidden.remove();

    await sleep(1100);
    out.counts = { ...window.__nfQuiet };
    out.nativeLooking = [JSON.parse, Response.prototype.json].every(fn => Function.prototype.toString.call(fn).includes('[native code]'));
  } catch (error) {
    out.error = String(error && error.stack || error);
  }
  out.done = true;
})();
</script>
</body>`;

const cdp = await CDP.connect(PORT);
try {
  const id = await extensionId(cdp);
  const popup = await cdp.open(`chrome-extension://${id}/popup.html`);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const setEnabled = async wanted => {
    if ((await cdp.eval(`document.querySelector('#toggle').getAttribute('aria-checked')`, popup.sessionId)) !== String(wanted)) {
      await cdp.eval(`document.querySelector('#toggle').click()`, popup.sessionId);
    }
    await cdp.poll(`!document.querySelector('#toggle').disabled && document.querySelector('#toggle').getAttribute('aria-checked') === '${wanted}'`, popup.sessionId);
  };
  await setEnabled(true);
  await cdp.eval(`document.querySelector('#reset').click()`, popup.sessionId);

  const page = await cdp.open();
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId === page.sessionId) pageErrors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
  });
  cdp.on('Fetch.requestPaused', async (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    await cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from(PAGE).toString('base64')
    }, sessionId).catch(() => {});
  });
  await cdp.send('Network.enable', {}, page.sessionId);
  await cdp.send('Network.setBypassServiceWorker', { bypass: true }, page.sessionId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.netflix.com/watch/__quiet_fixture*' }] }, page.sessionId);

  const load = async url => {
    await cdp.send('Page.navigate', { url }, page.sessionId);
    await cdp.poll(`window.fixture?.done && location.href === ${JSON.stringify(url)}`, page.sessionId, 20000).catch(async error => {
      console.log('page state:', JSON.stringify(await cdp.eval('({ fixture: window.fixture, title: document.title })', page.sessionId)), pageErrors);
      throw error;
    });
    return cdp.eval('window.fixture', page.sessionId);
  };

  // ---- filtering on
  const on = await load('https://www.netflix.com/watch/__quiet_fixture');
  console.log('ON ', JSON.stringify(on));
  assert.equal(on.error, undefined);
  assert.equal(on.engine, VERSION);
  assert.equal(on.licensedAdverts, false, 'manifest still has adverts');
  assert.equal(on.licensedKept, true);
  assert.equal(on.prefetchAdverts, false);
  assert.deepEqual(on.arrayAdverts, [false, false]);
  assert.equal(on.responseAdverts, false);
  assert.deepEqual(on.small, ['{"result":{}}', '{"result":{}}', '{"result":{}}']);
  assert.equal(on.decoy, DECOY_JSON, 'a bare adverts flag must be left alone');
  assert.equal(on.unrelated, UNRELATED_JSON);
  assert.equal(on.pauseAd, false);
  assert.equal(on.pauseKept, 'kept');
  assert.deepEqual(on.beforeAd, { rate: 1.25, muted: false }, 'a timeline marker must not count as an ad');
  assert.deepEqual(on.duringAd, { rate: 16, muted: true });
  assert.equal(on.afterPlayerReset, 16);
  assert.deepEqual(on.afterAd, { rate: 1.25, muted: false });
  assert.deepEqual(on.hiddenBadge, { rate: 1.25, muted: false });
  assert.equal(on.nativeLooking, true);
  // Counted: the licensed manifest, the array of two, the Response copy and
  // the pause ad. Empty sections (prefetch, small objects) are not.
  assert.deepEqual(on.counts, { version: VERSION, pruned: 4, sped: 1 });

  // The report reaches the popup, describes what happened, and holds no tokens.
  const text = await cdp.eval(`chrome.tabs.query({ url: 'https://www.netflix.com/*' }).then(tabs => chrome.tabs.sendMessage(tabs[0].id, { type: 'report' })).then(answer => answer.report)`, popup.sessionId);
  const report = JSON.parse(text);
  console.log('REPORT', text.length, 'chars;', JSON.stringify(report.manifests[0]));
  assert.equal(report.netflixQuietReport, 2);
  assert.equal(report.manifests.length, 6, 'licensed, prefetch, two from the array, Response copy, decoy');
  const first = report.manifests[0];
  assert.equal(first.via, 'parse');
  assert.deepEqual(first.top, ['version', 'serverTime', 'result']);
  assert.equal(first.licensed, true);
  assert.equal(first.durationS, 2700);
  assert.equal(first.viewableType, 'EPISODE');
  assert.deepEqual(first.breaks.map(item => item.at), [0, 600]);
  assert.equal(first.breaks[0].ads[0].s, 30);
  assert.equal(first.breaks[0].ads[0].type, 'PLAYABLE_AD');
  assert.deepEqual(report.manifests[1].breaks, []);
  assert.equal(report.manifests[1].partial, true);
  assert.equal(report.manifests[1].id, first.id, 'same title must get the same tag');
  assert.equal(report.manifests[4].via, 'json');
  assert.equal(report.manifests[5].advertsKeys, true);
  assert.deepEqual(report.small.map(entry => [entry.count, entry.adverts]), [[1, {}], [2, { daiSupported: true }]]);
  assert.deepEqual(report.events.filter(event => event.type.startsWith('ad-')).map(event => event.type), ['ad-start', 'ad-end']);
  assert.equal(report.events.filter(event => event.type === 'pause-ad-pruned').length, 1);
  assert.deepEqual(report.routes.map(entry => entry.route), ['/watch']);
  assert(report.uiaWithAd.includes('timeline-ad-break-marker'));
  assert(report.uiaFirstSeen['ads-info-container'] > report.uiaFirstSeen.player, 'the badge was seen after the player');
  assert.deepEqual(report.player.methods, ['getCurrentTime', 'getDuration', 'pause', 'play', 'seek']);
  assert.equal(report.counts.rateResets, 1);
  assert(!text.includes('SECRET-TOKEN'), 'report leaked a token');
  assert(!text.includes('81000001') && !text.includes('83364758'), 'report leaked a title or ad id');

  // Counts reach the popup.
  await cdp.send('Page.reload', {}, popup.sessionId);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const shown = await cdp.eval(`[document.querySelector('#pruned').textContent, document.querySelector('#sped').textContent]`, popup.sessionId);
  assert.deepEqual(shown, ['4', '1'], `popup shows ${shown}`);

  // ---- filtering off
  await setEnabled(false);
  const off = await load('https://www.netflix.com/watch/__quiet_fixture?off');
  console.log('OFF', JSON.stringify(off));
  assert.equal(off.engine, null);
  assert.equal(off.licensedAdverts, true);
  assert.equal(off.pauseAd, true);
  assert.deepEqual(off.small, SMALL_JSON);
  assert.deepEqual(off.duringAd, { rate: 1.25, muted: false });

  await setEnabled(true);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  console.log('\nfixture: all checks passed');
} finally {
  cdp.close();
}
