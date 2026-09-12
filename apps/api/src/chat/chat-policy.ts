import type { ChatSettings } from '@jetnine/shared';
export function withinChatHours(config: ChatSettings, now = new Date()) {
  if (!config.enabled) return false;
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const date = `${values.year}-${values.month}-${values.day}`;
  if (config.holidays.includes(date)) return false;
  if (!config.hoursEnabled) return true;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday!);
  const schedule = config.hours.find((row) => row.day === day);
  const time = `${values.hour}:${values.minute}`;
  return Boolean(schedule && schedule.open <= time && time < schedule.close);
}
