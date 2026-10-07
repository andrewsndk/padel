import { JOIN, JOINED, CONFIRM, LOGIN, PAYMENT, datePattern } from './policy.mjs';

// Observed racket.id cards are focusable divs; their date is a sibling in a row.
export const CONTROLS = 'button, a, [role="button"], div[tabindex="0"]';
export async function matchingControl(page, pattern, scope = page) {
  const controls = scope.locator(CONTROLS);
  const items = await controls.evaluateAll(nodes => nodes.map((n, index) => ({
    index, text: n.innerText?.trim().replace(/\s+/g, ' ') || '',
    visible: !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden',
    disabled: n.matches(':disabled') || n.getAttribute('aria-disabled') === 'true',
  })));
  const hit = items.find(x => x.visible && !x.disabled && pattern.test(x.text) && !PAYMENT.test(x.text));
  return hit ? controls.nth(hit.index) : null;
}
export async function requiresLogin(page) { return !!await matchingControl(page, LOGIN); }
export async function isJoined(page) { return !!await matchingControl(page, JOINED); }
export async function targetCards(page, target) {
  const selector = 'div[tabindex="0"], a, [role="button"]';
  const cards = page.locator(selector);
  const hits = await cards.evaluateAll((nodes, pattern) => {
    const dateRE = new RegExp(pattern, 'i');
    return nodes.flatMap((node, index) => {
      const text = node.innerText?.trim() || '';
      const capacities = [...text.matchAll(/(?:^|\s)(\d+)\s*\/\s*(\d+)(?=\s|$)/g)];
      if (!node.getClientRects().length || text.length > 500 || capacities.length !== 1) return [];
      const [, current, max] = capacities[0];
      if (+max <= 0 || +current > +max) return [];
      let row = node;
      for (let depth = 0; row && depth < 4; depth++, row = row.parentElement) {
        const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();
        // Never combine one card's day with another card's capacity.
        if ([...rowText.matchAll(/\d+\s*\/\s*\d+/g)].length !== 1 || rowText.length > 600) break;
        if (dateRE.test(rowText)) return [{index, current:+current, max:+max, text:rowText}];
      }
      return [];
    });
  }, datePattern(target));
  return hits.map(hit => ({...hit, card: cards.nth(hit.index)}));
}
export async function eventHasDate(page, target) {
  const re = new RegExp(datePattern(target), 'i');
  const texts = await page.locator('div').evaluateAll(nodes => nodes
    .filter(n => n.getClientRects().length && !n.children.length)
    .map(n => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t.length < 60));
  return texts.some(t => re.test(t));
}
export async function joinEvent(page, {canAct, verifyMs = 8000}) {
  if (await isJoined(page)) return 'joined';
  const button = await matchingControl(page, JOIN);
  if (!button || !canAct()) return 'not-available';
  await button.click({ timeout: 1500 });
  const until = Date.now() + verifyMs;
  let confirmed = false;
  while (Date.now() < until) {
    if (await isJoined(page)) return 'joined';
    // Only confirm within an actual modal, never a generic button elsewhere.
    const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
    if (!confirmed && await dialogs.count()) {
      const dialog = dialogs.last();
      if (PAYMENT.test(await dialog.innerText())) return 'payment-required';
      const confirm = await matchingControl(page, CONFIRM, dialog);
      if (confirm && canAct()) { await confirm.click({timeout:1500}); confirmed = true; }
    }
    await page.waitForTimeout(200);
  }
  return 'unverified';
}
