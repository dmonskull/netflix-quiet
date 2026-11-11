# Netflix Quiet

Netflix ad blocker for Chrome, Opera and Opera GX. Simple on/off switch. Runs in your browser, no proxy or extra accounts.

## install

1. Download the repo (**Code → Download ZIP**) and extract it.
2. Open `chrome://extensions` in Chrome or `opera://extensions` in Opera / Opera GX. Turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.
4. Reload Netflix. That's it.

If playback gets stuck, turn it off and reload the tab. Changes to the toggle need a reload to take effect.

## how it works

Netflix sends the player a list of ad breaks with each title. The extension removes that list before the player reads it, so the breaks never get scheduled. If an ad plays anyway, it's muted and run at 16x.

Still experimental. Pre-rolls are confirmed gone on real Netflix. Mid-rolls, pause-screen ads and long sessions haven't been checked yet, and the 16x fallback has never had to run.

If an ad gets through, **Copy report** in the popup copies what the player was sent: ad timings and player markers, no tokens, account data or title names.

Offline tests are in `test/`. They need Node 22+ and `BROWSER_BIN` set to Chrome for Testing, Opera or Opera GX.

Blocking ads on the ad plan is against Netflix's terms. Use at your own risk. Not affiliated with Netflix.
