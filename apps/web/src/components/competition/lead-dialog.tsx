'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatPhone, phoneDigits } from '@jetnine/shared';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { LEAD_CATEGORIES, LEAD_SIZES, pingCompetition, type LeadRow } from './types';

/**
 * "Log a lead" (README §3.6): three fields and Save, under ten seconds.
 * Phone is required because it is the match key; the name can be a first
 * name; Wanted is a size and a category plus one free line. Opens from
 * the strip and from New Sale's customer card ("Log as lead instead").
 */
export function LeadDialog({
  onClose,
  onSaved,
  actorName,
  initial,
  locationId,
}: {
  onClose: () => void;
  onSaved?: (lead: LeadRow) => void;
  actorName: string | null;
  initial?: { name?: string; phone?: string };
  locationId?: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [size, setSize] = useState('');
  const [cat, setCat] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const valid = phoneDigits(phone).length >= 7;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const lead = await api<LeadRow>('/v1/competitions/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          wantedSize: size || null,
          wantedCategory: cat || null,
          note: note.trim() || null,
          locationId: locationId ?? null,
        }),
      });
      const by = new Date(lead.expiresAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      toast.success(`Lead saved · ${lead.name} · converts if they buy from you by ${by}`);
      pingCompetition();
      onSaved?.(lead);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The lead could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Log a lead"
      description="Under ten seconds. Converts on its own if they buy from you within 30 days."
      onClose={onClose}
      size="sm"
      initialFocus={first}
      testId="lead-dialog"
      foot={
        <>
          <span className="lead-by">Logged under {actorName ?? 'you'}</span>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void save()}
            data-testid="lead-save"
          >
            {busy ? 'Saving…' : 'Save lead'}
          </Button>
        </>
      }
    >
      <div className="lead-form">
        <Field label="Name">
          <Input
            ref={first}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="First name is enough"
            data-testid="lead-name"
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </Field>
        <Field label="Phone" required hint="This is what matches the sale.">
          <Input
            className="input-mono"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => setPhone((p) => (phoneDigits(p).length === 10 ? formatPhone(p) : p))}
            placeholder="(818) 555-"
            inputMode="tel"
            data-testid="lead-phone"
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </Field>
        <Field label="Wanted" as="div">
          <div className="lead-wanted">
            <select
              className="input"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-label="Size"
              data-testid="lead-size"
            >
              <option value="">Size</option>
              {LEAD_SIZES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select
              className="input"
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              aria-label="Category"
              data-testid="lead-category"
            >
              <option value="">Category</option>
              {LEAD_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything else — “wants to see the ProAdapt again”"
              maxLength={160}
              data-testid="lead-note"
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </div>
        </Field>
        {error && (
          <div className="lead-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
