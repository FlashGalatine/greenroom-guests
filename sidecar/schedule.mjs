// The join schedule: the windows in which the bridge joins the voice channel by itself. Dependency-free and with no side effects, like
// settings.mjs (which imports it), so the bridge, the mock bridge and the tests use the very same rule.
//
// One window per weekday (Sunday first): a tick, a start and an end as "HH:MM" on a 24-hour clock, in the PC's local time. An end at or
// before the start means the window ends the next day (20:00 to 01:00); a start equal to the end is 24 hours. The start is inside the
// window, the end is not. The schedule only decides whether the bridge may START a join: nothing here ever makes the bot leave.

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = () => ({ on: false, start: '18:00', end: '23:00' });
export const DEFAULT_SCHEDULE = Object.freeze({ enabled: false, days: Object.freeze(Array.from({ length: 7 }, () => Object.freeze(DAY()))) });

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Merge `update` into `base`, each field by its own rule; anything of the wrong type keeps the value from `base` (or the default). Always a
// new object, so no caller shares a day entry with another.
export function sanitizeSchedule(base, update) {
  const out = { enabled: false, days: Array.from({ length: 7 }, DAY) };
  const take = (u) => {
    if (!isObject(u)) return;
    if (typeof u.enabled === 'boolean') out.enabled = u.enabled;
    if (!Array.isArray(u.days) || u.days.length !== 7) return;
    u.days.forEach((d, i) => {
      if (!isObject(d)) return;
      if (typeof d.on === 'boolean') out.days[i].on = d.on;
      if (typeof d.start === 'string' && TIME_RE.test(d.start)) out.days[i].start = d.start;
      if (typeof d.end === 'string' && TIME_RE.test(d.end)) out.days[i].end = d.end;
    });
  };
  take(base);
  take(update);
  return out;
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Is `date` (read by its local fields) inside a ticked window? Today's window, or the part of yesterday's that runs past midnight.
// `enabled` is the caller's business.
export function scheduleOpen(schedule, date) {
  const days = schedule && schedule.days;
  if (!Array.isArray(days) || days.length !== 7) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const today = days[date.getDay()];
  if (today && today.on) {
    const s = minutes(today.start), e = minutes(today.end);
    if (e > s ? now >= s && now < e : now >= s) return true;
  }
  const yesterday = days[(date.getDay() + 6) % 7];
  if (yesterday && yesterday.on) {
    const s = minutes(yesterday.start), e = minutes(yesterday.end);
    if (e <= s && now < e) return true;
  }
  return false;
}

// When the next ticked window starts, strictly after `date`: epoch ms, or null when no day is ticked. Built from local date fields
// (today and the seven days after it), so a daylight-saving change needs no handling.
export function scheduleNextStart(schedule, date) {
  const days = schedule && schedule.days;
  if (!Array.isArray(days) || days.length !== 7) return null;
  for (let i = 0; i <= 7; i++) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + i);
    const d = days[day.getDay()];
    if (!d || !d.on) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(d.start.slice(0, 2)), Number(d.start.slice(3, 5))).getTime();
    if (at > date.getTime()) return at;
  }
  return null;
}
