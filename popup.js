const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const detail = document.getElementById('detail');
const notice = document.getElementById('notice');
const reload = document.getElementById('reload');
const report = document.getElementById('report');
const reset = document.getElementById('reset');
const NETFLIX_TAB = /^https:\/\/www\.netflix\.com\//;
let enabled = false;
let netflixTab = null;

function paint(result) {
  enabled = result.enabled;
  toggle.setAttribute('aria-checked', String(enabled));
  status.textContent = enabled ? 'Filtering enabled' : 'Filtering paused';
  detail.textContent = enabled ? 'Ads filtered on new page loads' : 'Normal playback on new page loads';
  document.getElementById('pruned').textContent = result.stats.pruned.toLocaleString();
  document.getElementById('sped').textContent = result.stats.sped.toLocaleString();
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw new Error(result?.error || 'Extension did not respond');
  return result;
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    paint(await send({ type: 'set-enabled', enabled: !enabled }));
    notice.textContent = 'Setting saved. Reload every open Netflix tab to apply it.';
  } catch (error) {
    notice.textContent = `Could not save: ${error.message}`;
  } finally {
    toggle.disabled = false;
  }
});

reload.addEventListener('click', async () => {
  if (netflixTab === null) return;
  reload.disabled = true;
  try {
    await chrome.tabs.reload(netflixTab);
    notice.textContent = 'Netflix is reloading with your current setting.';
  } catch (error) {
    notice.textContent = `Could not reload: ${error.message}`;
  } finally {
    reload.disabled = false;
  }
});

// Diagnostics from the page: what the player was sent and what happened.
report.addEventListener('click', async () => {
  if (netflixTab === null) return;
  try {
    const answer = await chrome.tabs.sendMessage(netflixTab, { type: 'report' });
    if (!answer?.report) throw new Error('The page did not answer. Reload Netflix and try again.');
    await navigator.clipboard.writeText(answer.report);
    notice.textContent = `Report copied (${answer.report.length.toLocaleString()} characters).`;
  } catch (error) {
    notice.textContent = `Could not copy: ${error.message}`;
  }
});

reset.addEventListener('click', async () => {
  try {
    paint(await send({ type: 'reset-stats' }));
  } catch (error) {
    notice.textContent = `Could not reset: ${error.message}`;
  }
});

(async () => {
  document.getElementById('version').textContent = `EXPERIMENTAL · v${chrome.runtime.getManifest().version}`;
  try {
    paint(await send({ type: 'status' }));
    toggle.disabled = false;
  } catch (error) {
    status.textContent = 'Setup needs attention';
    detail.textContent = 'Reload the extension in your browser';
    notice.textContent = error.message;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url && NETFLIX_TAB.test(tab.url)) {
      netflixTab = tab.id;
      reload.disabled = false;
      report.disabled = false;
    } else {
      notice.textContent = 'Open a Netflix tab to reload it or copy a report.';
    }
  } catch {
    notice.textContent = 'Reload Netflix in your browser.';
  }
})();
