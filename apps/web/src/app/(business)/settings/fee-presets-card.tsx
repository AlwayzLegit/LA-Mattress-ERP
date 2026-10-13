'use client';

import { useState } from 'react';
import { Alert, Button, Card, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { feePresetsOf, type FeePreset } from '@/lib/fee-presets';

/**
 * Settings → Order fees (owner 2026-10-13): the fees staff pick under
 * "Charge a fee" on an order — Redelivery, Restocking, Trip charge … —
 * each with its default amount. Staff can still change the amount, and a
 * custom fee is always offered next to these.
 */
export function FeePresetsCard<S extends { ops: { feePresets?: FeePreset[] | null } | null }>({
  settings,
  onSaved,
}: {
  settings: S;
  onSaved: (s: S) => void;
}) {
  const [rows, setRows] = useState(() =>
    feePresetsOf(settings.ops?.feePresets).map((f) => ({
      label: f.label,
      amount: f.amountCents ? (f.amountCents / 100).toFixed(2) : '',
    })),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const feePresets = rows
        .filter((r) => r.label.trim())
        .map((r) => ({
          label: r.label.trim(),
          amountCents: Math.round((Number(r.amount.replace(/[$,\s]/g, '')) || 0) * 100),
        }));
      const updated = await api<S>('/v1/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ops: { feePresets: feePresets.length ? feePresets : null } }),
      });
      onSaved(updated);
      setMessage('Saved · written to the audit log');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Order fees"
      description="What staff pick under Charge a fee on an order. The amount fills in and can be changed; a custom fee is always offered too. Fees are never taxed."
    >
      <div className="fee-presets" data-testid="fee-presets">
        {rows.map((r, i) => (
          <div key={i} className="fee-preset-row">
            <Input
              aria-label={`Fee ${i + 1} name`}
              placeholder="Fee name"
              value={r.label}
              maxLength={60}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                )
              }
            />
            <Input
              aria-label={`Fee ${i + 1} amount`}
              placeholder="$ amount"
              inputMode="decimal"
              value={r.amount}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                )
              }
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${r.label || 'fee'}`}
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
      <div className="fee-preset-actions">
        <Button
          size="sm"
          onClick={() => setRows((prev) => [...prev, { label: '', amount: '' }])}
          disabled={rows.length >= 20}
        >
          + Add a fee
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={saving}
          data-testid="fee-presets-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {message && <Alert tone="success">{message}</Alert>}
      {errorMsg && <Alert tone="error">{errorMsg}</Alert>}
    </Card>
  );
}
