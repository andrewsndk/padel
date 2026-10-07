import { chromium } from 'playwright';
import fs from 'node:fs';
import { windowFor, targetSaturday, positiveNumber } from './lib/policy.mjs';
import { targetCards, requiresLogin, eventHasDate, isJoined, joinEvent } from './lib/browser.mjs';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODE = process.env.MODE || 'live';
if (!['live', 'check'].includes(MODE)) throw new Error('MODE must be live or check');
const GROUP_URL = process.env.GROUP_URL || 'https://racket.id/groups/4Y4qCwClTWQPAM';
const STORAGE = process.env.STORAGE_STATE || 'storageState.json';
const POLL_MS = positiveNumber(process.env.POLL_INTERVAL_MS, 1000, 200);
const RELOAD_MS = positiveNumber(process.env.RELOAD_INTERVAL_MS, 15000, 5000);
const MAX_MS = positiveNumber(process.env.MAX_RUNTIME_MS, 5 * 3600000);
const pending = new Set();
function notify(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  const job = fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:true}),
    signal: AbortSignal.timeout(5000),
  }).then(r => { if (!r.ok) log('Telegram returned HTTP', r.status); })
    .catch(() => log('Telegram unavailable')).finally(() => pending.delete(job));
  pending.add(job);
}
function loadStorage() {
  const state = process.env.STORAGE_STATE_B64
    ? JSON.parse(Buffer.from(process.env.STORAGE_STATE_B64, 'base64').toString('utf8'))
    : JSON.parse(fs.readFileSync(STORAGE, 'utf8'));
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Invalid session. Run npm run capture.');
  return state;
}
function saveStorage(state) {
  // On Actions, refreshed state stays only in memory; never publish credentials as artifacts.
  if (process.env.CI) return;
  const temp = `${STORAGE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), {mode:0o600});
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, STORAGE);
}
async function main() {
  const window = windowFor();
  if (MODE === 'live' && (!window.monday || Date.now() >= window.end)) {
    log('Outside Monday 10:00–13:00 Europe/Lisbon. No booking attempted.');
    // Delayed scheduled runs should not silently appear healthy.
    if (process.env.GITHUB_EVENT_NAME === 'schedule') throw new Error('Scheduled job missed the booking window');
    return;
  }
  const target = targetSaturday();
  const deadline = Math.min(Date.now() + MAX_MS, MODE === 'live' ? window.end : Date.now() + 60000);
  const canAct = () => MODE === 'live' && Date.now() >= window.start && Date.now() < deadline;
  const browser = await chromium.launch({headless:process.env.HEADLESS !== 'false'});
  let context, timer, lastError = null;
  let outcome = 'no-slot', eventUrl = null;
  try {
    context = await browser.newContext({storageState:loadStorage(),locale:'en-GB',viewport:{width:1280,height:900}});
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // Hard cutoff also interrupts an in-flight navigation; action guards apply before every click.
    timer = setTimeout(() => void context.close().catch(() => {}), Math.max(1,deadline-Date.now()));
    const goGroup = async () => {
      await page.goto(GROUP_URL,{waitUntil:'domcontentloaded',timeout:20000});
      await page.waitForFunction(() => /\d+\s*\/\s*\d+/.test(document.body.innerText) ||
        /saturday|субот|майбутні/i.test(document.body.innerText),null,{timeout:20000});
      // Wait for auth hydration, otherwise a transient logged-out UI can cause false failures.
      if (await requiresLogin(page)) {
        await page.waitForTimeout(1500);
        if (await requiresLogin(page)) throw new Error('AUTH_REQUIRED: Run npm run capture and update STORAGE_STATE_B64');
      }
    };
    await goGroup();
    log(`Mode=${MODE}; Saturday=${target}; window=Monday 10:00–13:00 Europe/Lisbon`);
    if (MODE === 'check') {
      const cards = await targetCards(page,target);
      log(`Session restored; matching Saturday cards: ${cards.length}`);
      if (!cards.length) throw new Error('No Saturday card available to validate selectors; check is inconclusive');
      await cards[0].card.click({timeout:3000});
      await page.waitForFunction(() => /(?:Players|Гравці|Игроки)\s*\d+\s*\/\s*\d+/i.test(document.body.innerText),null,{timeout:15000});
      if (await requiresLogin(page)) throw new Error('AUTH_REQUIRED on competition page');
      if (!await eventHasDate(page,target)) throw new Error('Competition date could not be verified');
      log('Read-only check passed: authenticated event page and exact Saturday date. No Join clicked.');
      outcome='checked';
      return;
    }
    notify(`🎾 Watching Saturday ${target}. Booking window: Monday 10:00–13:00 Lisbon.`);
    let lastReload = Date.now(), nextAttempt = 0, errors = 0, lastSummary = 0;
    while (Date.now() < deadline) {
      try {
        if (Date.now() < window.start) {
          await sleep(Math.min(10000,window.start-Date.now(),deadline-Date.now()));
          continue;
        }
        if (Date.now()-lastReload >= RELOAD_MS) {
          await goGroup(); lastReload=Date.now();
        }
        if (await requiresLogin(page)) throw new Error('AUTH_REQUIRED during monitoring');
        const cards = await targetCards(page,target);
        if (Date.now()-lastSummary > 60000) {
          log('Watching:',cards.length ? cards.map(c=>`${c.current}/${c.max}`).join(', ') : 'target not published');
          lastSummary=Date.now();
        }
        const hit = cards.find(c=>c.current<c.max);
        if (hit && Date.now()>=nextAttempt && canAct()) {
          log('Open slot',`${hit.current}/${hit.max}`);
          await hit.card.click({timeout:3000});
          await page.waitForFunction(() => /(?:Players|Гравці|Игроки)\s*\d+\s*\/\s*\d+/i.test(document.body.innerText),null,{timeout:10000});
          if (await requiresLogin(page)) throw new Error('AUTH_REQUIRED on competition page');
          if (!await eventHasDate(page,target)) throw new Error('Competition date mismatch');
          // A card must navigate to one event, never attempt a join on the group page.
          eventUrl=page.url();
          if (!eventUrl.startsWith(`${GROUP_URL.replace(/\/$/,'')}/`)) throw new Error('Unexpected event URL');
          const result = await joinEvent(page,{canAct});
          log('Attempt result:',result);
          if (result==='joined') {
            // Confirm that state survives a server reload, not merely an optimistic UI update.
            await page.reload({waitUntil:'domcontentloaded',timeout:15000});
            await page.waitForFunction(() => /(?:Players|Гравці|Игроки)\s*\d+\s*\/\s*\d+/i.test(document.body.innerText),null,{timeout:10000});
            if (await eventHasDate(page,target) && await isJoined(page)) {
              outcome='joined';
              notify(`✅ Joined Saturday ${target}; confirmed after reload. ${eventUrl}`);
              await page.screenshot({path:'joined.png',fullPage:true}).catch(()=>{});
              break;
            }
          }
          if (result==='payment-required') throw new Error('PAYMENT_REQUIRED: manual action needed');
          // Unverified clicks never count as success. Re-open and inspect before retrying.
          nextAttempt=Date.now()+5000;
          await page.screenshot({path:'unverified.png',fullPage:true}).catch(()=>{});
          await goGroup(); lastReload=Date.now();
        }
        errors=0; lastError=null;
        await sleep(Math.min(POLL_MS,Math.max(0,deadline-Date.now())));
      } catch(error) {
        if (Date.now()>=deadline) break;
        lastError=error;
        if (/AUTH_REQUIRED|PAYMENT_REQUIRED/.test(error.message)) throw error;
        errors++;
        log('Iteration failed:',error.message.split('\n')[0]);
        if (errors>=5) throw new Error('Five consecutive browser failures; monitoring unavailable');
        await sleep(Math.min(30000,1000*2**errors));
        lastReload=0;
      }
    }
    if (outcome!=='joined') {
      notify(`⏹️ Saturday ${target}: booking was NOT confirmed before the deadline.`);
      if (lastError) throw lastError;
      throw new Error('Window ended without a confirmed booking');
    }
  } finally {
    clearTimeout(timer);
    if (context) {
      try {saveStorage(await context.storageState({indexedDB:true}));} catch {}
    }
    await browser.close();
    fs.writeFileSync('result.json',JSON.stringify({outcome,target,eventUrl,finishedAt:new Date().toISOString()},null,2));
    await Promise.allSettled([...pending]);
  }
}
main().catch(async error => {
  log('FAILED:',error.message.split('\n')[0]);
  notify(`❌ Padel bot: ${error.message.split('\n')[0]}`);
  await Promise.allSettled([...pending]);
  process.exitCode=1;
});
