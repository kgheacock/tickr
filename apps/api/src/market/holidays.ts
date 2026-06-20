/**
 * NYSE observed holidays 2024–2030. Dates are in 'YYYY-MM-DD' local ET.
 * Refresh annually: https://www.nyse.com/markets/hours-calendars
 */
const NYSE_HOLIDAYS = new Set<string>([
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-15', // MLK Jr. Day
  '2024-02-19', // Presidents' Day
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas

  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-09', // National Day of Mourning (Jimmy Carter)
  '2025-01-20', // MLK Jr. Day
  '2025-02-17', // Presidents' Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas

  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas

  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, June 19 is Saturday)
  '2027-07-05', // Independence Day (observed, July 4 is Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed, Dec 25 is Saturday)

  // 2028
  '2027-12-31', // New Year's Day (observed, Jan 1 2028 is Saturday)
  '2028-01-17', // MLK Jr. Day
  '2028-02-21', // Presidents' Day
  '2028-04-14', // Good Friday
  '2028-05-29', // Memorial Day
  '2028-06-19', // Juneteenth
  '2028-07-04', // Independence Day
  '2028-09-04', // Labor Day
  '2028-11-23', // Thanksgiving
  '2028-12-25', // Christmas

  // 2029
  '2029-01-01', // New Year's Day
  '2029-01-15', // MLK Jr. Day
  '2029-02-19', // Presidents' Day
  '2029-03-30', // Good Friday
  '2029-05-28', // Memorial Day
  '2029-06-19', // Juneteenth
  '2029-07-04', // Independence Day
  '2029-09-03', // Labor Day
  '2029-11-22', // Thanksgiving
  '2029-12-25', // Christmas

  // 2030
  '2030-01-01', // New Year's Day
  '2030-01-21', // MLK Jr. Day
  '2030-02-18', // Presidents' Day
  '2030-04-19', // Good Friday
  '2030-05-27', // Memorial Day
  '2030-06-19', // Juneteenth
  '2030-07-04', // Independence Day
  '2030-09-02', // Labor Day
  '2030-11-28', // Thanksgiving
  '2030-12-25', // Christmas
]);

/** Returns true if the given UTC date falls on an NYSE observed holiday. */
export function isNyseHoliday(utcDate: Date): boolean {
  // Convert to ET (UTC-5 standard / UTC-4 daylight) for the date check.
  // Using a fixed UTC-5 offset is a conservative approximation: the only
  // risk is the 21:00–21:59 UTC window where ET date could differ. The daily
  // cron fires at 21:30 UTC (16:30 ET standard / 17:30 ET daylight), so the
  // dates always agree in practice.
  const etOffsetMs = 5 * 60 * 60 * 1000;
  const etDate = new Date(utcDate.getTime() - etOffsetMs);
  const ymd = etDate.toISOString().slice(0, 10);
  return NYSE_HOLIDAYS.has(ymd);
}

const SESSION_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const SESSION_CLOSE_MIN = 16 * 60; // 16:00 ET
const DAY_MS = 24 * 60 * 60 * 1000;

interface EtParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

/** Wall-clock America/New_York fields for an instant (DST-correct via Intl). */
function etParts(date: Date): EtParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    // Intl with hour12:false can render midnight as '24' in some runtimes.
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
  };
}

/** Is the given ET calendar date a regular NYSE trading day (weekday, non-holiday)? */
function isEtTradingDay(year: number, month: number, day: number): boolean {
  // Noon UTC of the date keeps isNyseHoliday's fixed-offset ET conversion on the
  // same calendar day (matches run-audit's isTradingDay).
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const dow = noon.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isNyseHoliday(noon);
}

/** The UTC instant of `hour:minute` ET on the given ET calendar date. */
function etWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Two-step zoned→UTC: treat the wall clock as if UTC, then correct by the
  // offset revealed by rendering that instant back in ET. Accurate for 16:00 ET
  // (the only DST-ambiguous hour is 02:00, which never closes a session).
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const r = etParts(new Date(asUtc));
  const etAsUtc = Date.UTC(r.year, r.month - 1, r.day, r.hour, r.minute);
  return new Date(asUtc - (etAsUtc - asUtc));
}

/**
 * The most recent NYSE regular-session close (16:00 ET) at or before `now`,
 * as a UTC instant. During a live session this is the *previous* session's
 * close (today's 16:00 hasn't happened yet); after today's close it is today's.
 * Walks back over weekends and holidays.
 *
 * Pairs with isRegularSession to bound "how fresh should the data be": callers
 * use `isRegularSession(now) ? now : mostRecentClose(now)`, i.e. the generalized
 * min(now, today's close) that also handles non-trading days.
 */
export function mostRecentClose(now: Date): Date {
  const et = etParts(now);
  let { year, month, day } = et;
  const minuteOfDay = et.hour * 60 + et.minute;

  // Today only qualifies once its close has passed; otherwise step back to the
  // previous trading day. The longest closure run (holiday + weekend) is ~4 days,
  // so a small bound is a safe loop guard.
  if (!(isEtTradingDay(year, month, day) && minuteOfDay >= SESSION_CLOSE_MIN)) {
    let cursor = Date.UTC(year, month - 1, day, 12) - DAY_MS;
    for (let i = 0; i < 14; i++) {
      const d = new Date(cursor);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth() + 1;
      const dd = d.getUTCDate();
      if (isEtTradingDay(y, mo, dd)) {
        year = y;
        month = mo;
        day = dd;
        break;
      }
      cursor -= DAY_MS;
    }
  }

  return etWallClockToUtc(year, month, day, 16, 0);
}

/**
 * The ET calendar date ('YYYY-MM-DD') of the most recent regular-session close
 * at or before `now`. This is the "just-closed session" the post-close Finnhub
 * capture (TODO/30) keys its provisional close on.
 *
 * It is holiday-aware by construction: it renders the ET date of
 * mostRecentClose, which walks back over weekends and holidays. So a capture
 * fired on a holiday Friday keys to the prior trading day's close (the one the
 * weekly scorer needs and that Massive won't deliver until Monday) rather than
 * to the non-trading Friday.
 */
export function mostRecentSessionDate(now: Date): string {
  const close = mostRecentClose(now);
  // en-CA renders as YYYY-MM-DD. The close is 16:00 ET, mid-day, so the ET
  // calendar date is unambiguous regardless of the UTC offset.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(close);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Returns true if `now` falls within the NYSE *regular* trading session —
 * weekdays 09:30 (inclusive) to 16:00 (exclusive) ET, excluding holidays.
 *
 * Unlike isNyseHoliday's fixed-offset approximation, this needs the real ET
 * wall-clock minute, which shifts an hour with daylight saving — so it resolves
 * the America/New_York zone via Intl rather than a hardcoded offset. Half-day
 * early closes (1pm ET) are not modeled; on those days a sweep just runs to 4pm
 * and re-fetches the same closed-session bars (idempotent), which is acceptable.
 */
export function isRegularSession(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekday = part('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const ymd = `${part('year')}-${part('month')}-${part('day')}`;
  if (NYSE_HOLIDAYS.has(ymd)) return false;

  // Intl with hour12:false can render midnight as '24' in some runtimes.
  const hour = parseInt(part('hour'), 10) % 24;
  const minuteOfDay = hour * 60 + parseInt(part('minute'), 10);
  return minuteOfDay >= SESSION_OPEN_MIN && minuteOfDay < SESSION_CLOSE_MIN;
}

/** America/New_York UTC offset in whole hours at `at` (−4 EDT, −5 EST). */
function etOffsetHours(at: Date): number {
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  // e.g. "GMT-4" / "GMT-5"; default to EST if the runtime omits it.
  const m = tzName?.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1]!, 10) : -5;
}

/**
 * The UTC instant that marks the regular-session close (16:00 ET) on the ET
 * calendar date of `d`, returned as the instant **just before** 16:00 ET so a
 * `ts <= anchor` lookup lands on the last *regular-session* bar (the 15:45 ET bar
 * at the default 15-min resolution) rather than the first after-hours bar — the
 * `price_bar` corpus includes extended-hours bars (04:00–~20:00 ET), so a naive
 * "latest bar before settle time" would pick an uneven after-hours print that
 * differs symbol-to-symbol. DST-aware: 16:00 ET is 20:00 UTC in EDT, 21:00 in EST.
 *
 * Used by the FS weekly settle so every symbol — and the prior-week baseline —
 * is valued at the *same* point in the trading day. Half-day early closes are not
 * modeled (consistent with isRegularSession).
 */
export function nyseRegularCloseAnchor(d: Date): Date {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string): string =>
    dateParts.find((p) => p.type === t)?.value ?? '';
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  // Resolve the offset at noon ET that day to stay clear of the 02:00 DST edge.
  const offset = etOffsetHours(new Date(`${ymd}T12:00:00-05:00`));
  const closeUtcHour = 16 - offset; // EDT(−4)→20:00Z, EST(−5)→21:00Z
  const closeUtc = new Date(
    `${ymd}T${String(closeUtcHour).padStart(2, '0')}:00:00Z`,
  );
  // One ms before the 16:00 ET bar so `ts <= anchor` excludes it.
  return new Date(closeUtc.getTime() - 1);
}

/**
 * The Friday of `now`'s week (ET) — today on Friday, the coming Friday Mon–Thu —
 * returned at `now`'s time-of-day. The FS weekly settle anchors on this Friday;
 * the lineup-lock, provisional and dispute-rescore paths all resolve the scoring
 * week off the same calendar mapping. Lifted here (next to nyseRegularCloseAnchor)
 * so there's one copy.
 *
 * The weekday MUST come from the real America/New_York calendar date (via etParts,
 * DST-correct), not a fixed-offset shift of `now`'s UTC date: the settle cron fires
 * mid-day UTC, but the provisional/matchups/detail readers call this at arbitrary
 * request times — including the 00:00–05:00 UTC window just past ET midnight, where
 * the old fixed-UTC-5 weekday read a day behind `now` and the result landed a day
 * late (a non-trading Saturday). That shifted the player-detail "previous scoring"
 * anchors onto Saturdays, where the close walk-back picked the prior day's
 * after-hours print instead of the 16:00 ET close.
 *
 * Only the weekday derivation changed; the returned instant keeps `now`'s
 * time-of-day, so the `weekEnd − 7d` baseline the provisional path relies on still
 * lands on the prior week — unchanged from the previously-correct cron-time path.
 */
export function currentFriday(now: Date): Date {
  const { year, month, day } = etParts(now);
  // Weekday of now's ET calendar date; noon UTC is a DST-safe probe (matches
  // isEtTradingDay) that never crosses a day boundary under the offset shift.
  const dow = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  const daysUntilFriday = (5 - dow + 7) % 7;
  return new Date(now.getTime() + daysUntilFriday * DAY_MS);
}
