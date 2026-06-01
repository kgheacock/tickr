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
