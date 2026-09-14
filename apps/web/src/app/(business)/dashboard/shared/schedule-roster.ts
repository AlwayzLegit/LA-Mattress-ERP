import type { SchedulePerson, ScheduleWeek, ShiftCell } from './types';

export interface RosterEntry {
  person: SchedulePerson;
  shift: ShiftCell;
}
export interface StoreRoster {
  id: string | null;
  name: string;
  locationType: string;
  days: Map<string, RosterEntry[]>;
  hours: number;
}

/** Never infer a shift location from a member's first approved store. */
export function storeRosters(data: ScheduleWeek, selectedLocation: string | null): StoreRoster[] {
  const rows = new Map<string | null, StoreRoster>(
    data.locations.map((l) => [
      l.id,
      {
        ...l,
        days: new Map(),
        hours: 0,
      },
    ]),
  );
  for (const person of data.people) {
    for (const shift of person.shifts) {
      const id = shift.locationId ?? null;
      let row = rows.get(id);
      if (!row) {
        row = {
          id,
          name: id ? 'Inactive location' : 'No store assigned',
          locationType: '',
          days: new Map(),
          hours: 0,
        };
        rows.set(id, row);
      }
      const entries = row.days.get(shift.date) ?? [];
      entries.push({ person, shift });
      row.days.set(shift.date, entries);
      if (shift.startMinutes != null && shift.endMinutes != null) {
        row.hours += (shift.endMinutes - shift.startMinutes) / 60;
      }
    }
  }
  return [...rows.values()].filter((r) => !selectedLocation || r.id === selectedLocation);
}

export function availableStaff(people: SchedulePerson[], date: string): SchedulePerson[] {
  return people.filter((p) => !p.shifts.some((s) => s.date === date && s.startMinutes != null));
}
