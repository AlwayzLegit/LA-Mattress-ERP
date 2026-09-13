'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * Owner settings for the sales competitions (README §3.6): per card
 * on/off and prize (people only — owner 2026-09-13), month reset
 * (fixed: 12:01 AM on the 1st, store time), payout date, return window,
 * how long the winner banner stays, who sees it, and overtaken notices.
 * The footer totals the monthly payout. Changes apply from the next month
 * unless the owner says otherwise — the strip reads settings live, so
 * "next month" is the owner's discipline, not the system's.
 */
export type RaceKey = 'leads' | 'avg' | 'high' | 'sales' | 'beds' | 'ex';
const RACES: { key: RaceKey; title: string }[] = [
  { key: 'leads', title: 'Lead Conversion' },
  { key: 'avg', title: 'Average Ticket' },
  { key: 'high', title: 'Highest Ticket' },
  { key: 'sales', title: 'Most Sales' },
  { key: 'beds', title: 'Most Adjustable Beds' },
  { key: 'ex', title: 'Least Exchanges' },
];

export interface CompetitionSettings {
  enabled?: boolean | null;
  cards?: Partial<
    Record<RaceKey, { on?: boolean | null; prizePeopleCents?: number | null }>
  > | null;
  sweep?: { four?: number | null; five?: number | null; six?: number | null } | null;
  payoutDay?: number | null;
  returnWindowDays?: number | null;
  bannerDays?: number | null;
  visibility?: {
    sales?: boolean | null;
    managers?: boolean | null;
    warehouse?: boolean | null;
    notices?: boolean | null;
  } | null;
  leadWindowDays?: number | null;
}

const DEFAULTS = {
  prize: 10_000,
  sweep: { four: 100_000, five: 150_000, six: 200_000 },
  payoutDay: 5,
  returnWindowDays: 30,
  bannerDays: 3,
};

function dollars(cents: number | null | undefined, fallback: number): string {
  const c = cents ?? fallback;
  return String(Math.round(c / 100));
}

export function CompetitionsCard<
  S extends { ops: { competitions?: CompetitionSettings | null } | null },
>({ settings, onSaved }: { settings: S; onSaved: (s: S) => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const comp = settings.ops?.competitions ?? {};
  const [on, setOn] = useState<Record<RaceKey, boolean>>(
    Object.fromEntries(RACES.map((r) => [r.key, comp.cards?.[r.key]?.on ?? true])) as Record<
      RaceKey,
      boolean
    >,
  );
  const [people, setPeople] = useState<Record<RaceKey, string>>(
    Object.fromEntries(
      RACES.map((r) => [r.key, dollars(comp.cards?.[r.key]?.prizePeopleCents, DEFAULTS.prize)]),
    ) as Record<RaceKey, string>,
  );

  const peopleTotal = RACES.reduce(
    (n, r) => n + (on[r.key] ? Math.round(Number(people[r.key]) || 0) : 0),
    0,
  );
  const sweep = comp.sweep ?? {};
  const nextMonth = new Date();
  nextMonth.setDate(1);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const appliesLabel = nextMonth.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const data = new FormData(e.currentTarget);
      const num = (k: string, fallback: number) => {
        const v = String(data.get(k) ?? '').trim();
        return v === '' ? fallback : Number(v);
      };
      const cards: NonNullable<CompetitionSettings['cards']> = {};
      for (const r of RACES) {
        cards[r.key] = {
          on: on[r.key],
          prizePeopleCents: Math.round((Number(people[r.key]) || 0) * 100),
        };
      }
      const body: CompetitionSettings = {
        enabled: data.get('enabled') === 'on',
        cards,
        sweep: {
          four: Math.round(num('sweepFour', DEFAULTS.sweep.four / 100) * 100),
          five: Math.round(num('sweepFive', DEFAULTS.sweep.five / 100) * 100),
          six: Math.round(num('sweepSix', DEFAULTS.sweep.six / 100) * 100),
        },
        payoutDay: num('payoutDay', DEFAULTS.payoutDay),
        returnWindowDays: num('returnWindowDays', DEFAULTS.returnWindowDays),
        bannerDays: num('bannerDays', DEFAULTS.bannerDays),
        visibility: {
          sales: data.get('visSales') === 'on',
          managers: data.get('visManagers') === 'on',
          warehouse: data.get('visWarehouse') === 'on',
          notices: data.get('visNotices') === 'on',
        },
      };
      const updated = await api<S>('/v1/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ops: { competitions: body } }),
      });
      onSaved(updated);
      setMessage(`Saved · applies ${appliesLabel} · written to the audit log`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const vis = comp.visibility ?? {};
  return (
    <Card
      title="Sales competitions"
      description="Six cards, one race between people. Changes apply from the next month unless you say otherwise."
    >
      <form onSubmit={submit} data-testid="competitions-form">
        <div className="cset">
          <div className="cset-main">
            <table className="dt cset-table">
              <thead>
                <tr>
                  <th className="first">Card</th>
                  <th>On</th>
                  <th className="num last">Prize</th>
                </tr>
              </thead>
              <tbody>
                {RACES.map((r) => (
                  <tr key={r.key} data-testid={`cset-row-${r.key}`}>
                    <td className="first" style={{ fontWeight: 500 }}>
                      {r.title}
                    </td>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={on[r.key]}
                          onChange={(e) => setOn({ ...on, [r.key]: e.target.checked })}
                          aria-label={`${r.title} on`}
                        />
                        <span />
                      </label>
                    </td>
                    <td className="num last">
                      <Input
                        className="input-num"
                        value={people[r.key]}
                        onChange={(e) => setPeople({ ...people, [r.key]: e.target.value })}
                        inputMode="numeric"
                        disabled={!on[r.key]}
                        aria-label={`${r.title} prize`}
                        style={{ width: 96, textAlign: 'right' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="cset-foot">
              Monthly payout · sweep bonus:{' '}
              <span className="mono">${dollars(sweep.four, DEFAULTS.sweep.four)}</span> for 4 of 6,{' '}
              <span className="mono">${dollars(sweep.five, DEFAULTS.sweep.five)}</span> for 5 of 6,{' '}
              <span className="mono">${dollars(sweep.six, DEFAULTS.sweep.six)}</span> for all 6
              (replaces the per-card prizes) ·{' '}
              <strong>${peopleTotal.toLocaleString()} in card prizes</strong>
            </div>
            <div className="cset-grid">
              <Field label="Sweep · 4 of 6 ($)">
                <Input
                  name="sweepFour"
                  defaultValue={dollars(sweep.four, DEFAULTS.sweep.four)}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Sweep · 5 of 6 ($)">
                <Input
                  name="sweepFive"
                  defaultValue={dollars(sweep.five, DEFAULTS.sweep.five)}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Sweep · all 6 ($)">
                <Input
                  name="sweepSix"
                  defaultValue={dollars(sweep.six, DEFAULTS.sweep.six)}
                  inputMode="numeric"
                />
              </Field>
            </div>
          </div>
          <aside className="cset-side">
            <section className="panel cset-panel">
              <h3>Month and payout</h3>
              <label className="cset-check">
                <input type="checkbox" name="enabled" defaultChecked={comp.enabled ?? true} />{' '}
                Competitions run
              </label>
              <div className="cset-grid">
                <Field label="Competition month">
                  <Input value="Calendar month" readOnly />
                </Field>
                <Field label="Resets">
                  <Input value="12:01 AM on the 1st" readOnly className="input-mono" />
                </Field>
                <Field label="Payout date">
                  <Select
                    name="payoutDay"
                    defaultValue={String(comp.payoutDay ?? DEFAULTS.payoutDay)}
                  >
                    {[1, 3, 5, 7, 10, 15].map((d) => (
                      <option key={d} value={d}>
                        {d}
                        {d === 1 ? 'st' : d === 3 ? 'rd' : 'th'} of next month
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Return window">
                  <Select
                    name="returnWindowDays"
                    defaultValue={String(comp.returnWindowDays ?? DEFAULTS.returnWindowDays)}
                  >
                    {[0, 14, 30, 45, 60].map((d) => (
                      <option key={d} value={d}>
                        {d === 0 ? 'Returns never come off' : `${d} days`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Winner banner stays for">
                <Select
                  name="bannerDays"
                  defaultValue={String(comp.bannerDays ?? DEFAULTS.bannerDays)}
                >
                  {[0, 1, 2, 3, 5, 7].map((d) => (
                    <option key={d} value={d}>
                      {d === 0 ? 'Not shown' : d === 1 ? '1 day' : `${d} days`}
                    </option>
                  ))}
                </Select>
              </Field>
            </section>
            <section className="panel cset-panel">
              <h3>Who sees it</h3>
              <label className="cset-check">
                <input type="checkbox" name="visSales" defaultChecked={vis.sales ?? true} />{' '}
                Salespeople and cashiers
              </label>
              <label className="cset-check">
                <input type="checkbox" name="visManagers" defaultChecked={vis.managers ?? true} />{' '}
                Store managers
              </label>
              <label className="cset-check">
                <input type="checkbox" name="visWarehouse" defaultChecked={vis.warehouse ?? true} />{' '}
                Warehouse and dispatch
              </label>
              <label className="cset-check">
                <input type="checkbox" name="visNotices" defaultChecked={vis.notices ?? true} />{' '}
                Overtaken notices to the inbox (max 1 per card per day)
              </label>
            </section>
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
              className="cset-save"
              data-testid="cset-save"
            >
              {saving ? 'Saving…' : `Save · applies ${appliesLabel}`}
            </Button>
            {message && <Alert tone="success">{message}</Alert>}
            {errorMsg && <Alert tone="error">{errorMsg}</Alert>}
          </aside>
        </div>
      </form>
    </Card>
  );
}
