// snipe.mjs — auto-join the Saturday game in the Padel PORTAL group on racket.id
//
// Strategy: open a real logged-in browser (Playwright), poll the group page every
// POLL_INTERVAL_MS, and the moment a Saturday game appears with a free slot, open it
// and click the join button — exactly like a human, just faster and unattended.
//
// It runs in a loop for up to MAX_RUNTIME_MS, then exits. On GitHub Actions the
// workflow starts this shortly before games are expected to open.

import { chromium } from 'playwright';
import fs from 'node:fs';

// ---- Config (override via env) ---------------------------------------------
const GROUP_URL       = process.env.GROUP_URL       || 'https://racket.id/groups/4Y4qCwClTWQPAM';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 6000);   // check every 6s
const MAX_RUNTIME_MS   = Number(process.env.MAX_RUNTIME_MS   || 40 * 60 * 1000); // stop after 40 min
const STORAGE_STATE    = process.env.STORAGE_STATE || 'storageState.json';
const HEADLESS         = process.env.HEADLESS !== 'false';

// Telegram (optional)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

// Which day are we sniping. Default Saturday. Matches the game-card title text.
// The group titles its games "Saturday, 14.00-16.00" etc, so we match on that.
const TARGET_DAY_RE = new RegExp(process.env.TARGET_DAY_RE || 'saturday|субот|субб', 'i');

// Text that identifies a join control vs a leave/cancel control.
const JOIN_RE  = /\b(join|приєдн|записа|реєстр|going|i'?m in|взяти участь)\b/i;
const LEAVE_RE = /\b(leave|вийти|скасув|cancel|відписа|purchased|joined|ти в грі|you'?re in)\b/i;

// Capacity like "31/32" — join only if free < max.
const CAP_RE = /(\d+)\s*\/\s*(\d+)/;

// ---- Helpers ---------------------------------------------------------------
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function notify(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) { log('telegram error', e.message); }
}

function loadStorage() {
  // Accept either a JSON file on disk or a base64 blob in STORAGE_STATE_B64 (for CI secrets).
  if (process.env.STORAGE_STATE_B64) {
    const json = Buffer.from(process.env.STORAGE_STATE_B64, 'base64').toString('utf8');
    fs.writeFileSync(STORAGE_STATE, json);
  }
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(`No auth found. Provide ${STORAGE_STATE} or STORAGE_STATE_B64. Run capture-auth.mjs first.`);
  }
  return STORAGE_STATE;
}

// Find a game card for the target day that still has a free slot. Returns a locator or null.
async function findOpenTargetGame(page) {
  // Cards are generic divs; locate by the visible day text inside each card.
  // We look at every element whose text mentions the target day AND a capacity ratio,
  // then walk up to the clickable card.
  const cards = page.locator('div', { hasText: TARGET_DAY_RE });
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    let txt = '';
    try { txt = (await card.innerText({ timeout: 1000 })).trim(); } catch { continue; }
    if (!TARGET_DAY_RE.test(txt)) continue;
    // Skip huge containers: we want the smallest card that has both day + capacity.
    if (txt.length > 400) continue;
    const cap = txt.match(CAP_RE);
    if (!cap) continue;
    const cur = Number(cap[1]), max = Number(cap[2]);
    if (cur < max) {
      log(`OPEN SLOT found: "${txt.replace(/\s+/g, ' ').slice(0, 80)}" (${cur}/${max})`);
      return { card, cur, max, txt };
    }
  }
  return null;
}

async function clickJoin(page) {
  // On the event page, find a clickable element that is a JOIN control and not a LEAVE control.
  const candidates = page.locator('div, button, a');
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    let t = '';
    try { t = (await el.innerText({ timeout: 500 })).trim(); } catch { continue; }
    if (!t || t.length > 40) continue;              // join buttons are short labels
    if (LEAVE_RE.test(t)) continue;                 // already joined / this is a leave button
    if (JOIN_RE.test(t)) {
      log(`Clicking join control: "${t}"`);
      try {
        await el.click({ timeout: 3000 });
        return t;
      } catch (e) { log('click failed, trying next:', e.message); }
    }
  }
  return null;
}

// After clicking join there may be a confirmation modal ("Confirm", "Так", "OK", "Book").
async function confirmIfNeeded(page) {
  const CONFIRM_RE = /\b(confirm|підтверд|ok|так|yes|book|записа|join)\b/i;
  await page.waitForTimeout(800);
  const btns = page.locator('div, button, a');
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const el = btns.nth(i);
    let t = '';
    try { t = (await el.innerText({ timeout: 300 })).trim(); } catch { continue; }
    if (t && t.length <= 25 && CONFIRM_RE.test(t) && !LEAVE_RE.test(t)) {
      try { await el.click({ timeout: 2000 }); log(`Confirmed via "${t}"`); return true; } catch {}
    }
  }
  return false;
}

// ---- Main ------------------------------------------------------------------
(async () => {
  loadStorage();
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
  });
  const page = await context.newPage();

  const deadline = Date.now() + MAX_RUNTIME_MS;
  log(`Sniper started. Polling ${GROUP_URL} every ${POLL_INTERVAL_MS}ms until ${new Date(deadline).toISOString()}`);
  await notify(`🎾 Sniper armed for Saturday. Watching until ${new Date(deadline).toLocaleTimeString()}.`);

  let joined = false;
  while (Date.now() < deadline && !joined) {
    try {
      await page.goto(GROUP_URL, { waitUntil: 'networkidle', timeout: 30000 });
      // Give the Firestore realtime data a moment to render the cards.
      await page.waitForTimeout(1500);

      const hit = await findOpenTargetGame(page);
      if (hit) {
        await notify(`⚡ Saturday slot open (${hit.cur}/${hit.max}) — attempting to join…`);
        await hit.card.click({ timeout: 5000 });
        await page.waitForTimeout(1500);

        let label = await clickJoin(page);
        if (label) {
          await confirmIfNeeded(page);
          await page.waitForTimeout(2000);
          await page.screenshot({ path: 'joined.png', fullPage: true }).catch(() => {});
          // Verify: page should now show a leave/joined state.
          const bodyTxt = (await page.locator('body').innerText().catch(() => '')) || '';
          const ok = LEAVE_RE.test(bodyTxt);
          joined = true;
          await notify(ok
            ? `✅ Joined the Saturday game! (verified: found leave/joined state)`
            : `⚠️ Clicked join ("${label}") but couldn't verify. Check the app — screenshot saved.`);
          log('DONE. joined=', ok);
        } else {
          await page.screenshot({ path: 'no-join-button.png', fullPage: true }).catch(() => {});
          await notify(`⚠️ Slot was open but no join button matched. Screenshot saved for tuning selectors.`);
          log('No join control matched on event page.');
        }
      }
    } catch (e) {
      log('poll iteration error:', e.message);
    }
    if (!joined) await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  if (!joined) {
    log('Runtime window ended without an open Saturday slot.');
    await notify('⏹️ Sniper window ended — no open Saturday slot appeared this run.');
  }

  // Persist any refreshed auth so the next run stays logged in.
  try { await context.storageState({ path: STORAGE_STATE }); } catch {}
  await browser.close();
  process.exit(joined ? 0 : 0); // exit 0 either way so Actions doesn't mark a "no slot" run as failed
})();
