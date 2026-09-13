'use client';

import { useEffect, useState, useRef } from 'react';
import { api, ApiError } from '@/lib/api';
import {
  Alert,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  Select,
  useFocusTrap,
} from '@/components/ui';

/**
 * The STORIS Security Override screen (PLAN-STORIS-GAP §0.1) as a
 * reusable dialog. It runs the whole cycle for a reason-gated action:
 *
 * 1. Collect the reason — a coded reason (from /v1/reason-codes,
 *    filtered by `usageClass`) when the business has codes, free text
 *    while it doesn't (amendment A9).
 * 2. Submit via the caller's `perform(payload)`.
 * 3. If the server answers 403 `OVERRIDE_REQUIRED`, expand the
 *    manager-authorization section (a *different*, authorized user's
 *    email + password) and retry with the credentials attached.
 *
 * Consumers that need no reason can pass `usageClass={null}`.
 */

export interface OverridePayload {
  reasonCodeId?: string;
  reason?: string;
  override?: { email: string; password: string; reasonCodeId?: string; reason?: string };
  /** Values collected from any extra `fields` the caller declared. */
  values?: Record<string, string>;
}

/**
 * An extra input the action needs alongside its reason — an as-is
 * selling price, a vendor R/A number. Declaring them here keeps every
 * reason-gated action in one dialog that can also carry a coded reason
 * and a manager challenge, which a native `window.prompt` never could.
 */
export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'number';
  placeholder?: string;
  required?: boolean;
  step?: string;
  min?: number;
}

interface ReasonCode {
  id: string;
  code: string;
  description: string;
}

export function SecurityOverrideDialog({
  open,
  title,
  usageClass,
  submitLabel,
  fields,
  perform,
  onClose,
  onSuccess,
}: {
  open: boolean;
  title: string;
  /** Reason-code class to offer, or null when the action takes no reason. */
  usageClass: string | null;
  submitLabel: string;
  /** Extra typed inputs this action needs alongside the reason. */
  fields?: DialogField[];
  perform: (payload: OverridePayload) => Promise<void>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [codes, setCodes] = useState<ReasonCode[] | null>(null);
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [reason, setReason] = useState('');
  const [needsOverride, setNeedsOverride] = useState(false);
  const [overrideMessage, setOverrideMessage] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setReasonCodeId('');
      setReason('');
      setNeedsOverride(false);
      setOverrideMessage(null);
      setAuthEmail('');
      setAuthPassword('');
      setError(null);
      setValues({});
      return;
    }
    if (usageClass) {
      api<ReasonCode[]>(`/v1/reason-codes?usageClass=${usageClass}`)
        .then(setCodes)
        .catch(() => setCodes([]));
    } else {
      setCodes([]);
    }
  }, [open, usageClass]);

  // Focus stays inside the PIN prompt and returns to the opener (Phase 12).
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, {
    active: open,
    onClose: () => {
      if (!busy) onClose();
    },
  });

  if (!open) return null;
  const hasCodes = (codes?.length ?? 0) > 0;
  const incomplete =
    (fields ?? []).some((f) => f.required && !(values[f.name] ?? '').trim()) ||
    (usageClass !== null && hasCodes && !reasonCodeId) ||
    (usageClass !== null && !hasCodes && !reason.trim()) ||
    (needsOverride && (!authEmail.trim() || !authPassword));

  async function submit() {
    setBusy(true);
    setError(null);
    const payload: OverridePayload = {
      ...(fields && fields.length > 0 ? { values } : {}),
      ...(reasonCodeId ? { reasonCodeId } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(needsOverride && authEmail && authPassword
        ? {
            override: {
              email: authEmail.trim(),
              password: authPassword,
              ...(reasonCodeId ? { reasonCodeId } : {}),
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
          }
        : {}),
    };
    try {
      await perform(payload);
      onSuccess();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') {
        setNeedsOverride(true);
        setOverrideMessage(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    // Modal chrome: the backdrop/panel positioning is utility classes
    // (structural, not styling); the focus trap is the shared hook.
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal
        aria-label={title}
        data-testid="security-override-dialog"
        className="w-full max-w-[440px]"
      >
        <Card title={title}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && !incomplete) void submit();
            }}
          >
            <FormGrid cols={1}>
              {(fields ?? []).map((f) => (
                <Field key={f.name} label={f.label} required={f.required}>
                  <Input
                    data-testid={`dialog-field-${f.name}`}
                    type={f.type ?? 'text'}
                    step={f.step}
                    min={f.min}
                    placeholder={f.placeholder}
                    value={values[f.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                  />
                </Field>
              ))}

              {usageClass &&
                (hasCodes ? (
                  <Field label="Reason" required>
                    <Select
                      data-testid="override-reason-code"
                      value={reasonCodeId}
                      onChange={(e) => setReasonCodeId(e.target.value)}
                    >
                      <option value="">Select a reason…</option>
                      {codes!.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.description}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Reason" required>
                    <Input
                      data-testid="override-reason-text"
                      placeholder="Why is this needed?"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                ))}

              {needsOverride && (
                <div data-testid="override-credentials" className="form-span">
                  <Alert tone="warning" title="Manager authorization required">
                    {overrideMessage}
                  </Alert>
                  <FormGrid cols={1}>
                    <Field label="Authorizer email" required>
                      <Input
                        data-testid="override-email"
                        type="email"
                        placeholder="Authorizer email"
                        autoComplete="off"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Authorizer password"
                      required
                      hint="The approval is recorded under both identities."
                    >
                      <Input
                        data-testid="override-password"
                        type="password"
                        placeholder="Authorizer password"
                        autoComplete="new-password"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                      />
                    </Field>
                  </FormGrid>
                </div>
              )}

              {error && (
                <div className="form-span">
                  <Alert tone="error">{error}</Alert>
                </div>
              )}
            </FormGrid>

            <FormActions>
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                data-testid="override-submit"
                disabled={busy || incomplete}
              >
                {busy ? 'Working…' : submitLabel}
              </Button>
            </FormActions>
          </form>
        </Card>
      </div>
    </div>
  );
}
