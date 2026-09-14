import { expect, it } from 'vitest';
import { availableStaff, storeRosters } from './schedule-roster';
import type { ScheduleWeek } from './types';

const data: ScheduleWeek = {
  today: '2026-09-14',
  timezone: 'America/Los_Angeles',
  week: { start: '2026-09-14', end: '2026-09-20', days: [] },
  locations: [
    { id: 'a', name: 'La Brea', locationType: 'store' },
    { id: 'b', name: 'West LA', locationType: 'store' },
  ],
  canEdit: true,
  unpublishedCount: 1,
  lastPublishedAt: null,
  people: [
    {
      membershipId: 'one',
      name: 'Sam',
      roleName: 'Manager',
      isLead: true,
      locationId: 'a',
      locationName: 'La Brea',
      shifts: [
        {
          date: '2026-09-14',
          locationId: 'b',
          startMinutes: 540,
          endMinutes: 1020,
          published: true,
        },
        {
          date: '2026-09-15',
          locationId: 'a',
          startMinutes: null,
          endMinutes: null,
          published: false,
        },
      ],
    },
  ],
};

it('groups by actual shift store, keeps empty stores and counts hours only for working shifts', () => {
  const rows = storeRosters(data, null);
  expect(rows.map((r) => [r.name, r.hours])).toEqual([
    ['La Brea', 0],
    ['West LA', 8],
  ]);
  expect(rows[1]!.days.get('2026-09-14')![0]!.person.name).toBe('Sam');
  expect(rows[0]!.days.get('2026-09-15')![0]!.shift.published).toBe(false);
  expect(storeRosters(data, 'a')).toHaveLength(1);
});

it('excludes someone already working that day even when viewing another store', () => {
  expect(availableStaff(data.people, '2026-09-14')).toEqual([]);
  expect(availableStaff(data.people, '2026-09-15')).toHaveLength(1);
});

it('keeps unlocated legacy and inactive-store shifts visible without guessing a home store', () => {
  const shifts = data.people[0]!.shifts.map((s) => ({ ...s, locationId: undefined }));
  const rows = storeRosters({ ...data, people: [{ ...data.people[0]!, shifts }] }, null);
  expect(rows.find((r) => r.id === null)?.hours).toBe(8);
  expect(rows[0]!.hours).toBe(0);
});
