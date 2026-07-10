// capture-auth.mjs — run this ONCE on your own computer to log in and save your session.
//
//   node capture-auth.mjs
//
// A browser window opens. Log into racket.id normally (phone/SMS, Google, whatever you use).
// Once you can see your groups, come back to this terminal and press Enter.
// It writes storageState.json — that file IS your login. Treat it like a password.

import { chromium } from 'playwright';
import readline from 'node:readline';

const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a); });
});

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('https://racket.id/');
  console.log('\n>>> Log into racket.id in the browser window that just opened.');
  console.log('>>> When you can see your account / groups, return here.\n');
  await ask('Press Enter once you are fully logged in... ');
  await context.storageState({ path: 'storageState.json' });
  console.log('\n✅ Saved storageState.json');
  console.log('   For GitHub Actions, turn it into a secret with:');
  console.log('     base64 -w0 storageState.json   (Linux)');
  console.log('     base64 storageState.json       (macOS)');
  console.log('   Paste the output into a repo secret named STORAGE_STATE_B64.\n');
  await browser.close();
  process.exit(0);
})();
