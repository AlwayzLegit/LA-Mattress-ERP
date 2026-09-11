'use client';

import { useEffect, useState } from 'react';
import { Clock, LogIn, LogOut, Coffee, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, Button, Card, Field, Input, Stack } from '@/components/ui';
import { clockTime, PUNCH_LABELS } from '../dashboard/shared/kit';
import type { PunchType, TimeClockMe } from '../dashboard/shared/types';

/**
 * STORIS "Access Time Clock" as a shared-terminal kiosk (A22 slice 7):
 * the terminal stays signed in as any member who may punch; each punch
 * carries the punching member's own email + password, verified by the
 * kiosk endpoint, and lands on their membership. The form clears after
 * every punch so the next person starts clean.
 */

type Result = TimeClockMe & { punched: { type: PunchType; at: string } };

const PUNCHES: {
  type: PunchType;
  label: string;
  icon: typeof LogIn;
  variant: 'primary' | 'secondary' | 'danger';
}[] = [
  { type: 'clock_in', label: 'Clock in', icon: LogIn, variant: 'primary' },
  { type: 'break_start', label: 'Start break', icon: Coffee, variant: 'secondary' },
  { type: 'break_end', label: 'End break', icon: Play, variant: 'secondary' },
  { type: 'clock_out', label: 'Clock out', icon: LogOut, variant: 'danger' },
];

export default function TimeClockKioskPage() {
  const [now, setNow] = useState(() => new Date());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // The confirmation stays on screen briefly, then the kiosk resets.
  useEffect(() => {
    if (!result) return;
    const id = window.setTimeout(() => setResult(null), 12_000);
    return () => window.clearTimeout(id);
  }, [result]);

  async function punch(type: PunchType) {
    if (!email.trim() || !password) {
      setError('Enter your email and password, then pick a punch.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<Result>('/v1/timeclock/kiosk-punch', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password, type }),
      });
      setResult(r);
      setEmail('');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[560px]" data-testid="timeclock-kiosk">
      <Stack>
        <div className="text-center">
          <div className="eyebrow">Time clock</div>
          <div className="mono" style={{ fontSize: 44, fontWeight: 600 }} data-testid="kiosk-clock">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div className="muted">
            {now.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </div>
        </div>

        {result && (
          <Alert
            tone="success"
            title={`${PUNCH_LABELS[result.punched.type]} · ${result.member.name}`}
          >
            <div data-testid="kiosk-result">
              Recorded at {clockTime(result.punched.at, result.timezone)} ·{' '}
              {result.hoursToday.toFixed(2)} h today · {result.hoursWeek.toFixed(2)} h this week
              {result.scheduledToday
                ? ` · scheduled ${Math.floor(result.scheduledToday.startMinutes / 60)}:${String(result.scheduledToday.startMinutes % 60).padStart(2, '0')}–${Math.floor(result.scheduledToday.endMinutes / 60)}:${String(result.scheduledToday.endMinutes % 60).padStart(2, '0')}`
                : ''}
            </div>
          </Alert>
        )}

        <Card
          title="Punch"
          description="Sign each punch with your own email and password. Nothing is remembered between punches."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <Stack gap="sm">
              <Field label="Email" required>
                <Input
                  autoFocus
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="kiosk-email"
                />
              </Field>
              <Field label="Password" required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="kiosk-password"
                />
              </Field>
              {error && <Alert tone="error">{error}</Alert>}
              <div className="grid grid-cols-2 gap-2">
                {PUNCHES.map((p) => (
                  <Button
                    key={p.type}
                    type="button"
                    variant={p.variant}
                    disabled={busy}
                    onClick={() => void punch(p.type)}
                    data-testid={`kiosk-${p.type}`}
                    className="justify-center py-4 text-base"
                  >
                    <p.icon size={18} aria-hidden />
                    {p.label}
                  </Button>
                ))}
              </div>
            </Stack>
          </form>
        </Card>
        <p className="muted text-center text-xs">
          <Clock size={12} className="inline" aria-hidden /> Only a punch that changes your status
          is accepted — the server refuses a second clock-in.
        </p>
      </Stack>
    </div>
  );
}
