'use client';

import { Field, Select } from '@/components/ui';
import type { ActionLine } from './types';

/** Line-scoped STORIS actions ask for the line inside the dialog. */
export function LinePicker({
  lines,
  value,
  onChange,
  label = 'Line',
  filter,
}: {
  lines: ActionLine[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  filter?: (l: ActionLine) => boolean;
}) {
  const options = filter ? lines.filter(filter) : lines;
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="line-picker">
        <option value="">Choose a line…</option>
        {options.map((l, i) => (
          <option key={l.id} value={l.id}>
            {i + 1}. {l.description} × {l.quantity}
          </option>
        ))}
      </Select>
    </Field>
  );
}
