'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, Button, Dialog, Field, Input, Select } from '@/components/ui';

/**
 * Adjust stock (redesign Phase 7, README §3.3, canvas 6c): one location,
 * a coded reason, and the arithmetic in the open — **On hand now → Change
 * → After**. Guards: After can never go below zero (the button disables
 * and the note names the largest allowed change); After below what is
 * reserved at that location shows the red note "reassign the reservation
 * first"; a count correction over 2 units needs a note. Posts
 * `POST /v1/inventory/adjust`, which is audited and shows under
 * Adjustments. The wider stock-actions dialog (bins, As-Is, write-off,
 * serials) stays one click away for the rarer moves.
 */

export interface AdjustLocation {
  locationId: string;
  locationName: string;
  onHand: number;
  reserved: number;
}
interface ReasonCode {
  id: string;
  code: string;
  description: string;
  active?: boolean;
}
type AdjustType = 'count_correction' | 'damage' | 'theft' | 'other';

/** The server's adjustment type, read off the tenant's own reason code. */
function typeFor(code: ReasonCode | undefined): AdjustType {
  const s = `${code?.code ?? ''} ${code?.description ?? ''}`.toLowerCase();
  if (/cnt|count|cycle|found|fnd/.test(s)) return 'count_correction';
  if (/dmg|damag|defect|broken|as-is|as is/.test(s)) return 'damage';
  if (/thf|theft|stolen|shrink|missing/.test(s)) return 'theft';
  return 'other';
}

export function AdjustStockDialog({
  productName,
  sku,
  variantId,
  locations,
  initialLocationId,
  onClose,
  onPosted,
  onMore,
}: {
  productName: string;
  sku: string | null;
  variantId: string;
  locations: AdjustLocation[];
  initialLocationId?: string | null;
  onClose: () => void;
  /** After a successful post (the caller reloads its stock). */
  onPosted: () => void;
  /** Opens the wider stock-actions dialog for the chosen location. */
  onMore?: (locationId: string) => void;
}) {
  const [locationId, setLocationId] = useState(initialLocationId ?? locations[0]?.locationId ?? '');
  const [codes, setCodes] = useState<ReasonCode[] | null>(null);
  const [reasonCodeId, setReasonCodeId] = useState('');
  // The server's adjustment type is an explicit choice (reason codes are
  // tenant text); picking a code only pre-fills it.
  const [type, setType] = useState<AdjustType>('count_correction');
  const [change, setChange] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<ReasonCode[]>('/v1/reason-codes?usageClass=inventory_adjustment')
      .then((rows) => setCodes(rows.filter((r) => r.active !== false)))
      .catch(() => setCodes([]));
  }, []);

  const loc = locations.find((l) => l.locationId === locationId) ?? null;
  const now = loc?.onHand ?? 0;
  const reserved = loc?.reserved ?? 0;
  const delta = change.trim() === '' || change.trim() === '-' ? 0 : Math.trunc(Number(change));
  const validDelta = Number.isFinite(delta);
  const after = now + (validDelta ? delta : 0);
  const needsCode = (codes?.length ?? 0) > 0 && !reasonCodeId;
  const noteRequired = type === 'count_correction' && Math.abs(delta) > 2;

  const guard = useMemo(() => {
    if (!loc) return { block: true, text: 'Pick a location.', tone: 'muted' as const };
    if (!validDelta || delta === 0) return { block: true, text: '', tone: 'muted' as const };
    if (after < 0) {
      return {
        block: true,
        text: `On hand cannot go below zero — the largest change here is −${now}.`,
        tone: 'risk' as const,
      };
    }
    if (after < reserved) {
      return {
        block: true,
        text: `${reserved} of these are reserved for orders at ${loc.locationName}. Reassign the reservation first.`,
        tone: 'risk' as const,
      };
    }
    if (noteRequired && !note.trim()) {
      return {
        block: true,
        text: 'A count correction over 2 units needs a note.',
        tone: 'waiting' as const,
      };
    }
    if (needsCode) return { block: true, text: 'Pick a reason.', tone: 'waiting' as const };
    return { block: false, text: '', tone: 'muted' as const };
  }, [loc, validDelta, delta, after, now, reserved, noteRequired, note, needsCode]);

  async function post() {
    if (guard.block || !loc) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/inventory/adjust`, {
        method: 'POST',
        body: JSON.stringify({
          variantId,
          locationId,
          delta,
          reason: type,
          reasonCodeId: reasonCodeId || undefined,
          notes: note.trim() || undefined,
        }),
      });
      toast.success(
        `${sku ?? productName} at ${loc.locationName}: ${now} → ${after} (${delta > 0 ? '+' : ''}${delta})`,
      );
      onPosted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      size="md"
      title={`Adjust stock — ${productName}`}
      description={`${sku ?? ''}${sku ? ' · ' : ''}adjustments are audited and appear under Adjustments.`}
      onClose={onClose}
      initialFocus={changeRef}
      testId="adjust-stock-dialog"
      className="adj"
      foot={
        <>
          {onMore && (
            <Button
              variant="ghost"
              onClick={() => onMore(locationId)}
              style={{ marginRight: 'auto' }}
              data-testid="adjust-more"
            >
              More stock actions…
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void post()}
            disabled={busy || guard.block}
            data-testid="adjust-post"
          >
            {busy ? 'Posting…' : 'Post adjustment'}
          </Button>
        </>
      }
    >
      <div className="adj-body">
        <div className="adj-grid">
          <Field label="Location">
            <Select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              data-testid="adjust-location"
            >
              {locations.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.locationName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason" required>
            {codes && codes.length > 0 ? (
              <Select
                value={reasonCodeId}
                onChange={(e) => {
                  setReasonCodeId(e.target.value);
                  setType(typeFor(codes?.find((c) => c.id === e.target.value)));
                }}
                data-testid="adjust-reason"
              >
                <option value="">Choose…</option>
                {codes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.description}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value="No reason codes set up — pick a type" readOnly />
            )}
          </Field>
          <Field label="Type">
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as AdjustType)}
              data-testid="adjust-type"
            >
              <option value="count_correction">Count correction</option>
              <option value="damage">Damaged</option>
              <option value="theft">Theft or loss</option>
              <option value="other">Other</option>
            </Select>
          </Field>
        </div>

        <div className="adj-math" data-testid="adjust-math">
          <div className="adj-cell">
            <div className="t-label">On hand now</div>
            <div className="adj-num" data-testid="adjust-now">
              {now}
            </div>
            {reserved > 0 && <div className="adj-sub">{reserved} reserved</div>}
          </div>
          <div className="adj-arrow" aria-hidden>
            →
          </div>
          <div className="adj-cell">
            <label className="t-label" htmlFor="adjust-change">
              Change
            </label>
            <Input
              id="adjust-change"
              ref={changeRef}
              type="number"
              step="1"
              inputMode="numeric"
              placeholder="−1"
              value={change}
              onChange={(e) => setChange(e.target.value)}
              className="adj-input"
              data-testid="adjust-change"
              aria-describedby="adjust-guard"
            />
          </div>
          <div className="adj-arrow" aria-hidden>
            →
          </div>
          <div className="adj-cell">
            <div className="t-label">After</div>
            <div
              className={`adj-num${after < 0 || after < reserved ? ' is-bad' : delta !== 0 ? ' is-set' : ''}`}
              data-testid="adjust-after"
            >
              {validDelta ? after : '—'}
            </div>
          </div>
        </div>

        <Field
          label={`Note${noteRequired ? '' : ' (required for count corrections over 2 units)'}`}
          required={noteRequired}
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={type === 'count_correction' ? 'What the count found' : 'Optional'}
            data-testid="adjust-note"
          />
        </Field>

        <div id="adjust-guard" className={`adj-guard is-${guard.tone}`} aria-live="polite">
          {guard.text ? (
            <>
              <span aria-hidden>▲</span> {guard.text}
            </>
          ) : delta !== 0 ? (
            `${loc?.locationName ?? ''}: ${now} → ${after}`
          ) : (
            ' '
          )}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
