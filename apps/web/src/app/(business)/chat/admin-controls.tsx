'use client';
import { useState } from 'react';
import { chatSettingsSchema, type ChatSettings } from '@jetnine/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import styles from './chat.module.css';
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };
type Report = {
  total: number;
  active: number;
  resolved: number;
  overdue: number;
  followups: number;
  firstResponseSeconds: number | null;
  resolutionSeconds: number | null;
  satisfaction: number | null;
  linkedCustomers: number;
};
export function AdminControls() {
  const [settings, setSettings] = useState<{ config: ChatSettings; version: number } | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string | null }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState<{
    eligible: number;
    version: number;
    enabled: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState('');
  async function load() {
    setBusy(true);
    try {
      const [s, r] = await Promise.all([
        api<{
          config: ChatSettings;
          version: number;
          members: { id: string; name: string | null }[];
        }>('/v1/chat/conversations/settings'),
        api<Report>('/v1/chat/conversations/report'),
      ]);
      setSettings({ config: s.config, version: s.version });
      setMembers(s.members);
      setReport(r);
      setStatus('');
    } catch {
      setStatus('Business-wide chat manager access is required, or the service is unavailable.');
    } finally {
      setBusy(false);
    }
  }
  function update(values: Partial<ChatSettings>) {
    if (settings) setSettings({ ...settings, config: { ...settings.config, ...values } });
  }
  return (
    <details
      className={styles.preferences}
      onToggle={(event) => {
        if (event.currentTarget.open && !settings && !busy) void load();
      }}
    >
      <summary>Chat administration and reports</summary>
      <p role="status">{status}</p>
      {report && (
        <div className={styles.report}>
          <p>
            <strong>{report.active}</strong> active
          </p>
          <p>
            <strong>{report.overdue}</strong> overdue
          </p>
          <p>
            <strong>{report.followups}</strong> callbacks pending
          </p>
          <p>
            <strong>{report.resolved}</strong> resolved
          </p>
          <p>
            Average first response:{' '}
            {report.firstResponseSeconds === null
              ? 'No replies yet'
              : `${Math.round(Number(report.firstResponseSeconds) / 60)} min`}
          </p>
          <p>
            Average resolution:{' '}
            {report.resolutionSeconds === null
              ? 'No resolutions yet'
              : `${Math.round(Number(report.resolutionSeconds) / 60)} min`}
          </p>
          <p>
            Satisfaction:{' '}
            {report.satisfaction === null
              ? 'No ratings yet'
              : `${Number(report.satisfaction).toFixed(1)} / 5`}
          </p>
          <p>{report.linkedCustomers} linked customers</p>
        </div>
      )}
      {settings && (
        <form
          className={styles.settings}
          onSubmit={async (event) => {
            event.preventDefault();
            const parsed = chatSettingsSchema.safeParse(settings.config);
            if (!parsed.success) {
              setStatus(parsed.error.issues[0]?.message ?? 'Check the settings');
              return;
            }
            setBusy(true);
            try {
              setSettings(
                await api('/v1/chat/conversations/settings', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ ...settings, config: parsed.data }),
                }),
              );
              setStatus('Chat settings saved.');
              setRetention(null);
            } catch {
              setStatus('Settings were not saved. Reload if another manager changed them.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset>
            <legend>Staff notifications and availability</legend>
            <p>Owner keeps personal controls. Browser permission must be granted on each device.</p>
            {(
              [
                [
                  'notificationsEnabled',
                  'Enable chat sounds, desktop alerts and background pushes',
                ],
                ['requireNotifications', 'Require notifications for staff (staff cannot mute)'],
                ['autoAvailable', 'Make staff available when they sign in'],
                ['allowAway', 'Allow all staff to choose Away'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings.config[key]}
                  onChange={(e) => update({ [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <p>Individual permissions</p>
            {members.map((member) => (
              <div key={member.id}>
                <strong>{member.name ?? 'Team member'}</strong>
                {(
                  [
                    ['awayAllowedMembers', 'May choose Away'],
                    ['notificationExemptMembers', 'May mute notifications'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={settings.config[key].includes(member.id)}
                      onChange={(e) =>
                        update({
                          [key]: e.target.checked
                            ? [...settings.config[key], member.id]
                            : settings.config[key].filter((id) => id !== member.id),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={settings.config.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />{' '}
            Website chat enabled
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.config.sharedInbox}
              onChange={(e) => update({ sharedInbox: e.target.checked })}
            />{' '}
            Share incoming website chats with chat staff at every store
          </label>
          <p>
            Shared chats can be accepted by any chat-enabled teammate. Existing store-specific
            conversations keep their access restrictions.
          </p>
          <label>
            How chats are assigned
            <select
              className="input"
              value={settings.config.autoAssign ? 'automatic' : 'first_accept'}
              onChange={(e) => update({ autoAssign: e.target.value === 'automatic' })}
            >
              <option value="first_accept">First person to accept</option>
              <option value="automatic">Automatically choose an available teammate</option>
            </select>
          </label>
          <p>
            First to accept keeps new chats unassigned so staff with inbox access can respond. Only
            one person can accept each chat.
          </p>
          <label>
            <input
              type="checkbox"
              checked={settings.config.hoursEnabled}
              onChange={(e) => update({ hoursEnabled: e.target.checked })}
            />{' '}
            Use opening hours (America/Los_Angeles)
          </label>
          {settings.config.hoursEnabled && (
            <fieldset>
              <legend>Weekly chat hours</legend>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (day, index) => {
                  const row = settings.config.hours.find((value) => value.day === index);
                  function hours(part: { open?: string; close?: string }) {
                    update({
                      hours: [
                        ...settings!.config.hours.filter((value) => value.day !== index),
                        {
                          day: index,
                          open: row?.open ?? '10:00',
                          close: row?.close ?? '18:00',
                          ...part,
                        },
                      ],
                    });
                  }
                  return (
                    <div className={styles.hoursRow} key={day}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(row)}
                          onChange={(e) =>
                            e.target.checked
                              ? hours({})
                              : update({
                                  hours: settings.config.hours.filter(
                                    (value) => value.day !== index,
                                  ),
                                })
                          }
                        />
                        {day}
                      </label>
                      {row && (
                        <>
                          <input
                            type="time"
                            aria-label={`${day} opening`}
                            value={row.open}
                            onChange={(e) => hours({ open: e.target.value })}
                          />
                          <input
                            type="time"
                            aria-label={`${day} closing`}
                            value={row.close}
                            onChange={(e) => hours({ close: e.target.value })}
                          />
                        </>
                      )}
                    </div>
                  );
                },
              )}
            </fieldset>
          )}
          <label>
            Closed dates (one YYYY-MM-DD per line)
            <textarea
              value={settings.config.holidays.join('\n')}
              onChange={(e) => update({ holidays: e.target.value.split('\n').filter(Boolean) })}
            />
          </label>
          <label>
            Unanswered message target (minutes)
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.config.responseMinutes}
              onChange={(e) => update({ responseMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            Assignment acceptance deadline (minutes)
            <input
              type="number"
              min={1}
              max={60}
              value={settings.config.acceptanceMinutes}
              onChange={(e) => update({ acceptanceMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            Retention days for resolved/spam chats (blank keeps history)
            <input
              type="number"
              min={30}
              max={3650}
              value={settings.config.retentionDays ?? ''}
              onChange={(e) =>
                update({ retentionDays: e.target.value ? Number(e.target.value) : null })
              }
            />
          </label>
          <p>Retention deletion is explicit. Active chats are never included.</p>
          <Button type="submit" disabled={busy}>
            Save settings
          </Button>{' '}
          <Button type="button" disabled={busy} onClick={() => void load()}>
            Reload settings and report
          </Button>
        </form>
      )}
      {settings && (
        <details>
          <summary>Delete history under the saved retention policy</summary>
          <Button
            disabled={busy}
            onClick={async () => {
              try {
                setRetention(await api('/v1/chat/conversations/retention'));
              } catch {
                setStatus('Retention preview unavailable.');
              }
            }}
          >
            Preview eligible chats
          </Button>
          {retention && (
            <>
              <p>
                {retention.enabled
                  ? `${retention.eligible} archived conversations are eligible. Deleting them permanently removes messages and contact details.`
                  : 'No retention policy enabled.'}
              </p>
              {retention.enabled && retention.eligible > 0 && (
                <>
                  <label>
                    Type DELETE ELIGIBLE CHATS
                    <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
                  </label>
                  <Button
                    disabled={busy || confirmation !== 'DELETE ELIGIBLE CHATS'}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const result = await api<{ deleted: number }>(
                          '/v1/chat/conversations/retention',
                          {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ confirmation, version: retention.version }),
                          },
                        );
                        setStatus(`${result.deleted} archived chats deleted.`);
                        setConfirmation('');
                        setRetention(null);
                      } catch {
                        setStatus('Deletion was not confirmed. Preview again.');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Permanently delete eligible chats
                  </Button>
                </>
              )}
            </>
          )}
        </details>
      )}
    </details>
  );
}
