export const ZONE = 'Europe/Lisbon';
export function localParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
export function windowFor(now = new Date()) {
  const p = localParts(now);
  const day = Date.UTC(p.year, p.month - 1, p.day);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(+now / 1000) * 1000;
  return { monday: new Date(day).getUTCDay() === 1,
    start: day + 10 * 3600000 - offset, end: day + 13 * 3600000 - offset };
}
export function targetSaturday(now = new Date()) {
  const p = localParts(now);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  date.setUTCDate(date.getUTCDate() + (6 - date.getUTCDay() + 7) % 7);
  return date.toISOString().slice(0, 10);
}
export function datePattern(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== iso || d.getUTCDay() !== 6)
    throw new Error('TARGET_DATE must be an ISO Saturday date');
  const month = d.toLocaleString('en-GB', {month:'short', timeZone:'UTC'});
  const ukMonths = ['січ','лют','бер','квіт','трав','черв','лип','серп','вер','жов','лист','груд'];
  const ruMonths = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const day = d.getUTCDate();
  // Group cards contain an English title; details may show localized labels.
  return `(?:^|\\s)(?:Sat(?:urday)?\\s+0?${day}\\s+${month}|Сб\\s*0?${day}\\s*${ukMonths[d.getUTCMonth()]}\\w*|сб\\s*0?${day}\\s*${ruMonths[d.getUTCMonth()]}\\w*)(?:\\s+${d.getUTCFullYear()})?(?=\\s|$)`;
}
export const JOIN = /^(?:join(?: game| competition| tournament)?|приєднатися|приєднатись|записатися|записаться|реєстрація|i'm in)$/i;
export const JOINED = /^(?:leave(?: game| competition| tournament)?|joined|you're in|you are in|вийти(?: з гри)?|ти в грі|відписатися)$/i;
export const CONFIRM = /^(?:confirm(?: join)?|підтвердити|yes|так)$/i;
export const LOGIN = /^(?:log in(?: to join)?|sign in(?: to join)?|увійти|войти|увійдіть)$/i;
export const PAYMENT = /pay|checkout|stripe|card|оплат|картк|карту|€|\$|purchase/i;
export function positiveNumber(value, fallback, min = 1) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid numeric setting: ${value}`);
  return n;
}
