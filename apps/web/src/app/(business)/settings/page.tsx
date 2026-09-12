'use client';

import Link from 'next/link';
import { Save } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  CURRENCY_LABELS,
  REASON_USAGE_CLASSES,
  REASON_USAGE_CLASS_LABELS,
  SUPPORTED_CURRENCIES,
  type ReasonUsageClass,
} from '@jetnine/shared';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  SectionHeading,
  Select,
  Stack,
  TableWrap,
} from '@/components/ui';
import { api } from '@/lib/api';
import { CompetitionsCard, type CompetitionSettings } from './competitions-card';

interface Branding {
  accentColor?: string | null;
  logoUrl?: string | null;
  publicName?: string | null;
}

interface OpsSettings {
  recyclingFeeCents?: number | null;
  defaultSourceLocationId?: string | null;
  invoiceHeaderNote?: string | null;
  invoiceFooterNote?: string | null;
  deliveryDailyCap?: number | null;
  poReplyTo?: string | null;
  maxBalanceForTicketPrintCents?: number | null;
  invoiceVarianceToleranceCents?: number | null;
  blindReceiving?: boolean | null;
  reserveBasis?: 'delivery_date' | 'order_date' | null;
  returnWindowDays?: number | null;
  restockingFeePercent?: number | null;
  exchangeHoldAtEntry?: boolean | null;
  autoScheduleDays?: number | null;
  autoReplenishmentEnabled?: boolean | null;
  deliveryDailyPieceCap?: number | null;
  deliveryDailyCapacityUnits?: number | null;
  /** Redesign Phase 11: sales competitions. */
  competitions?: CompetitionSettings | null;
  priceVariance?: {
    tier1Pct?: number | null;
    tier1MaxCents?: number | null;
    tier2Pct?: number | null;
  } | null;
  /** A20 order-page pick lists (one label per line in the editor). */
  marketingCodes?: string[] | null;
  orderSources?: string[] | null;
  prepCodes?: string[] | null;
  rooms?: string[] | null;
  paymentTerminals?: string[] | null;
}

const OPS_LISTS: { key: keyof OpsSettings; label: string; hint: string }[] = [
  { key: 'marketingCodes', label: 'Marketing codes', hint: 'Order page Marketing Code 1 / 2' },
  { key: 'orderSources', label: 'Order sources', hint: 'Walk-in, Phone, Web, Referral…' },
  { key: 'prepCodes', label: 'Prep codes', hint: 'Warehouse instructions on a line' },
  { key: 'rooms', label: 'Rooms', hint: 'Where a piece goes in the home' },
  { key: 'paymentTerminals', label: 'Payment terminals', hint: 'Card readers to assign' },
];

function linesToList(raw: FormDataEntryValue | null): string[] | null {
  const items = String(raw ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

interface Settings {
  id: string;
  slug: string;
  name: string;
  status: string;
  currencyCode: string;
  defaultTaxRateBps: number;
  receiptHeader: string | null;
  receiptFooter: string | null;
  branding: Branding | null;
  ops: OpsSettings | null;
}

/** Sub-pages under Settings — rendered as a pill sub-nav, not header buttons. */
const SETTINGS_SECTIONS: { href: string; label: string }[] = [
  { href: '/settings/tax-classes', label: 'Tax classes' },
  { href: '/settings/discounts', label: 'Discounts' },
  { href: '/settings/webhooks', label: 'Webhooks' },
  { href: '/settings/api-keys', label: 'API keys' },
  { href: '/settings/import', label: 'Data import' },
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/billing', label: 'Billing' },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      setSettings(await api<Settings>('/v1/business/settings'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const data = new FormData(e.currentTarget);
      const body = {
        name: String(data.get('name') ?? ''),
        currencyCode: String(data.get('currencyCode') ?? settings.currencyCode),
        defaultTaxRateBps: Number(data.get('defaultTaxRateBps') ?? '0'),
        receiptHeader: String(data.get('receiptHeader') ?? '') || null,
        receiptFooter: String(data.get('receiptFooter') ?? '') || null,
      };
      const updated = await api<Settings>('/v1/business/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setSettings(updated);
      setSuccess('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (error && !settings) {
    return (
      <div>
        <PageHeader title="Business settings" />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!settings) return <LoadingRows />;

  return (
    <div>
      <PageHeader
        title="Business settings"
        sub="Name, currency, tax defaults, receipts, store operations, and branding for this business."
      />
      <Stack>
        <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
          {SETTINGS_SECTIONS.map((s) => (
            <Link key={s.href} href={s.href} className="pill no-underline">
              {s.label}
            </Link>
          ))}
        </nav>

        <Card title="Business" className="form-narrow">
          <form onSubmit={submit}>
            <FormGrid cols={2}>
              <Field label="Business name" required>
                <Input name="name" defaultValue={settings.name} required />
              </Field>
              <Field
                label="Currency"
                hint="Switching currency changes how amounts are displayed across the app. Existing balances keep their stored minor-unit value; you may want to coordinate the change with your bookkeeper."
              >
                <Select name="currencyCode" defaultValue={settings.currencyCode}>
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code} — {CURRENCY_LABELS[code]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Default tax rate (basis points; 250 = 2.5%)" className="form-span">
                <Input
                  name="defaultTaxRateBps"
                  type="number"
                  min={0}
                  defaultValue={settings.defaultTaxRateBps}
                />
              </Field>
              <Field label="Receipt header">
                <textarea
                  name="receiptHeader"
                  defaultValue={settings.receiptHeader ?? ''}
                  rows={3}
                  className="textarea"
                />
              </Field>
              <Field label="Receipt footer">
                <textarea
                  name="receiptFooter"
                  defaultValue={settings.receiptFooter ?? ''}
                  rows={3}
                  className="textarea"
                />
              </Field>
            </FormGrid>
            {error && (
              <Alert tone="error" className="mt-3">
                {error}
              </Alert>
            )}
            {success && (
              <Alert tone="success" className="mt-3" data-testid="settings-success">
                {success}
              </Alert>
            )}
            <FormActions>
              <Button type="submit" variant="primary" disabled={saving}>
                <Save size={14} aria-hidden />
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </FormActions>
          </form>
        </Card>

        <OpsCard settings={settings} onSaved={setSettings} />
        <CompetitionsCard settings={settings} onSaved={setSettings} />

        <ReasonCodesCard />

        <BrandingCard settings={settings} onSaved={setSettings} />

        <RegistryReference />
      </Stack>
    </div>
  );
}

/**
 * SET-007 (sysadmin pack): the settings registry rendered as reference —
 * every setting the system reads, its type, and what BLANK means
 * (SET-002: no implicit tri-state, ever). Served by the API so the doc
 * can never drift from the code.
 */
function RegistryReference() {
  const [rows, setRows] = useState<
    | {
        key: string;
        label: string;
        type: string;
        nullMeans: string;
        classTags: string[];
        readBy: string;
      }[]
    | null
  >(null);
  const [failed, setFailed] = useState(false);

  async function open() {
    if (rows || failed) return;
    try {
      setRows(await api('/v1/business/settings/registry'));
    } catch {
      setFailed(true);
    }
  }

  return (
    <Card>
      <details data-testid="settings-registry" onToggle={() => void open()}>
        <summary className="section-title cursor-pointer">
          Settings registry — what each setting does and what blank means
        </summary>
        <div className="pt-3">
          {failed && <Alert tone="error">Could not load the registry.</Alert>}
          {!failed && !rows && <LoadingRows rows={2} />}
          {rows && (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Type</th>
                    <th>Blank means</th>
                    <th>Read by</th>
                    <th>Class</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        {r.label}
                        <div className="muted">
                          <code>{r.key}</code>
                        </div>
                      </td>
                      <td>
                        <code>{r.type}</code>
                      </td>
                      <td>{r.nullMeans}</td>
                      <td>{r.readBy}</td>
                      <td>
                        {r.classTags.length > 0 ? (
                          <span className="inline-flex flex-wrap gap-1">
                            {r.classTags.map((t) => (
                              <span key={t} className="badge badge-warning">
                                {t}
                              </span>
                            ))}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      </details>
    </Card>
  );
}

/** A checkbox row inside a `Field`: the Field's label already wraps it, so no nested label. */
function CheckRow({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-2 py-1.5">{children}</span>;
}

/**
 * POS-operations knobs (PLAN-POS-OPERATIONS): the per-unit recycling
 * fee New Sale auto-adds, the admin-editable invoice header/footer
 * notes (§11), the daily delivery stop cap (§7), and the PO reply-to.
 * Saved separately, same as branding.
 */
function OpsCard({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string; locationType: string }[]>(
    [],
  );
  const ops = settings.ops ?? {};
  useEffect(() => {
    void api<{ id: string; name: string; locationType: string }[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const data = new FormData(e.currentTarget);
      const feeStr = String(data.get('recyclingFee') ?? '').trim();
      const capStr = String(data.get('deliveryDailyCap') ?? '').trim();
      const body: OpsSettings = {
        recyclingFeeCents: feeStr === '' ? null : Math.round(Number(feeStr) * 100),
        defaultSourceLocationId: String(data.get('defaultSourceLocationId') ?? '') || null,
        deliveryDailyCap: capStr === '' ? null : Number(capStr),
        invoiceHeaderNote: String(data.get('invoiceHeaderNote') ?? '').trim() || null,
        invoiceFooterNote: String(data.get('invoiceFooterNote') ?? '').trim() || null,
        poReplyTo: String(data.get('poReplyTo') ?? '').trim() || null,
      };
      const pieceCap = String(data.get('deliveryPieceCap') ?? '').trim();
      body.deliveryDailyPieceCap = pieceCap === '' ? null : Number(pieceCap);
      const unitCap = String(data.get('deliveryUnitCap') ?? '').trim();
      body.deliveryDailyCapacityUnits = unitCap === '' ? null : Number(unitCap);
      const invTol = String(data.get('invoiceTolerance') ?? '').trim();
      body.invoiceVarianceToleranceCents = invTol === '' ? null : Math.round(Number(invTol) * 100);
      body.blindReceiving = data.get('blindReceiving') === 'on' ? true : null;
      const basis = String(data.get('reserveBasis') ?? '');
      body.reserveBasis = basis === 'order_date' ? 'order_date' : 'delivery_date';
      const rtnWindow = String(data.get('returnWindowDays') ?? '').trim();
      body.returnWindowDays = rtnWindow === '' ? null : Number(rtnWindow);
      const restockPct = String(data.get('restockingFeePercent') ?? '').trim();
      body.restockingFeePercent = restockPct === '' ? null : Number(restockPct);
      body.exchangeHoldAtEntry = data.get('exchangeHoldAtEntry') === 'on' ? true : null;
      const autoSched = String(data.get('autoScheduleDays') ?? '').trim();
      body.autoScheduleDays = autoSched === '' ? null : Number(autoSched);
      body.autoReplenishmentEnabled = data.get('autoReplenishmentEnabled') === 'on' ? true : null;
      const capBal = String(data.get('maxBalanceForTicket') ?? '').trim();
      body.maxBalanceForTicketPrintCents = capBal === '' ? null : Math.round(Number(capBal) * 100);
      const t1 = String(data.get('pvTier1Pct') ?? '').trim();
      const t1max = String(data.get('pvTier1Max') ?? '').trim();
      const t2 = String(data.get('pvTier2Pct') ?? '').trim();
      body.priceVariance =
        t1 === '' && t1max === '' && t2 === ''
          ? null
          : {
              tier1Pct: t1 === '' ? null : Number(t1),
              tier1MaxCents: t1max === '' ? null : Math.round(Number(t1max) * 100),
              tier2Pct: t2 === '' ? null : Number(t2),
            };
      for (const list of OPS_LISTS) {
        (body as Record<string, unknown>)[list.key] = linesToList(data.get(`list-${list.key}`));
      }
      const updated = await api<Settings>('/v1/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ops: body }),
      });
      onSaved(updated);
      setMessage('Saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Store operations"
      description="Fees, delivery capacity, receiving, returns, and price-variance thresholds. Blank means the documented default."
      className="form-narrow"
    >
      <form onSubmit={submit}>
        <FormGrid cols={2}>
          <SectionHeading as="h3" title="Fees & invoices" />
          <Field label="Recycling fee per unit ($; blank = default 10.50)">
            <Input
              name="recyclingFee"
              type="number"
              step="0.01"
              min={0}
              defaultValue={
                ops.recyclingFeeCents != null ? (ops.recyclingFeeCents / 100).toFixed(2) : ''
              }
              data-testid="ops-recycling-fee"
            />
          </Field>
          <Field
            label="Default stock source for new sale lines"
            hint="Where Add Product opens and untouched lines pull from. Blank = the single warehouse, else the selling store. Take-with lines always follow the order's store."
          >
            <Select
              name="defaultSourceLocationId"
              defaultValue={ops.defaultSourceLocationId ?? ''}
              data-testid="ops-default-source"
            >
              <option value="">Warehouse (automatic)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.locationType === 'warehouse' ? ' — warehouse' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Max balance for ticket print ($; blank = no cap)">
            <Input
              name="maxBalanceForTicket"
              type="number"
              step="0.01"
              min={0}
              defaultValue={
                ops.maxBalanceForTicketPrintCents != null
                  ? (ops.maxBalanceForTicketPrintCents / 100).toFixed(2)
                  : ''
              }
            />
          </Field>
          <Field label="Invoice header note (printed top-center)">
            <Input
              name="invoiceHeaderNote"
              defaultValue={ops.invoiceHeaderNote ?? ''}
              placeholder="WE CALL 6-8PM NIGHT BEFORE DEL"
              data-testid="ops-header-note"
            />
          </Field>
          <Field label="PO reply-to email">
            <Input name="poReplyTo" type="email" defaultValue={ops.poReplyTo ?? ''} />
          </Field>
          <Field label="Invoice footer" className="form-span">
            <textarea
              name="invoiceFooterNote"
              defaultValue={ops.invoiceFooterNote ?? ''}
              rows={3}
              className="textarea"
            />
          </Field>

          <SectionHeading as="h3" title="Delivery capacity" />
          <Field label="Delivery stops per day (soft cap; blank = 15)">
            <Input
              name="deliveryDailyCap"
              type="number"
              min={1}
              defaultValue={ops.deliveryDailyCap ?? ''}
            />
          </Field>
          <Field label="Delivery pieces per day (blank = no piece budget)">
            <Input
              name="deliveryPieceCap"
              type="number"
              min={1}
              defaultValue={ops.deliveryDailyPieceCap ?? ''}
            />
          </Field>
          <Field label="Delivery capacity units per day (blank = off; king set > twin)">
            <Input
              name="deliveryUnitCap"
              type="number"
              min={1}
              defaultValue={ops.deliveryDailyCapacityUnits ?? ''}
            />
          </Field>
          <Field label="Auto transfer schedule days (blank = auto transfers off; 0 = next day)">
            <Input
              name="autoScheduleDays"
              type="number"
              min={0}
              placeholder="blank disables auto transfers"
              defaultValue={ops.autoScheduleDays ?? ''}
            />
          </Field>

          <SectionHeading as="h3" title="Receiving & stock" />
          <Field label="Invoice auto-clear tolerance ($; blank = manual approval)">
            <Input
              name="invoiceTolerance"
              type="number"
              step="0.01"
              min={0}
              defaultValue={
                ops.invoiceVarianceToleranceCents != null
                  ? (ops.invoiceVarianceToleranceCents / 100).toFixed(2)
                  : ''
              }
            />
          </Field>
          <Field label="Stock reservation basis (who gets scarce stock first)">
            <Select
              name="reserveBasis"
              defaultValue={ops.reserveBasis === 'order_date' ? 'order_date' : 'delivery_date'}
            >
              <option value="delivery_date">Earliest delivery date first</option>
              <option value="order_date">First order written first</option>
            </Select>
          </Field>
          <Field label="Blind receiving (hide expected quantities at the dock)">
            <CheckRow>
              <input
                type="checkbox"
                name="blindReceiving"
                defaultChecked={Boolean(ops.blindReceiving)}
              />
              Receivers count what arrived, not what was expected
            </CheckRow>
          </Field>
          <Field label="Nightly auto-replenishment POs">
            <CheckRow>
              <input
                type="checkbox"
                name="autoReplenishmentEnabled"
                defaultChecked={Boolean(ops.autoReplenishmentEnabled)}
              />
              Draft a PO per vendor overnight for items at or below their reorder point
            </CheckRow>
          </Field>

          <SectionHeading as="h3" title="Returns & exchanges" />
          <Field label="Return window (days; blank = no limit)">
            <Input
              name="returnWindowDays"
              type="number"
              min={1}
              placeholder="e.g. 120 — older returns need a manager"
              defaultValue={ops.returnWindowDays ?? ''}
            />
          </Field>
          <Field label="Exchange restocking fee (% of return credit; blank = none)">
            <Input
              name="restockingFeePercent"
              type="number"
              step="0.5"
              min={0}
              max={100}
              placeholder="e.g. 10 — overridable per exchange"
              defaultValue={ops.restockingFeePercent ?? ''}
            />
          </Field>
          <Field label="Hold exchanges for approval at entry (E1)" className="form-span">
            <CheckRow>
              <input
                type="checkbox"
                name="exchangeHoldAtEntry"
                defaultChecked={Boolean(ops.exchangeHoldAtEntry)}
              />
              Every new exchange waits for a manager release before it can settle
            </CheckRow>
          </Field>

          <SectionHeading as="h3" title="Price variance" />
          <Field label="No-friction tier (%; blank = 5)">
            <Input
              name="pvTier1Pct"
              type="number"
              step="0.5"
              min={0}
              defaultValue={ops.priceVariance?.tier1Pct ?? ''}
            />
          </Field>
          <Field label="No-friction max discount ($; blank = 50)">
            <Input
              name="pvTier1Max"
              type="number"
              step="1"
              min={0}
              defaultValue={
                ops.priceVariance?.tier1MaxCents != null
                  ? (ops.priceVariance.tier1MaxCents / 100).toFixed(0)
                  : ''
              }
            />
          </Field>
          <Field label="Deep-discount log tier starts above (%; blank = 15)">
            <Input
              name="pvTier2Pct"
              type="number"
              step="0.5"
              min={0}
              defaultValue={ops.priceVariance?.tier2Pct ?? ''}
            />
          </Field>
          <SectionHeading as="h3" title="Order page pick lists (STORIS Enter a Sales Order)" />
          {OPS_LISTS.map((list) => (
            <Field key={list.key} label={`${list.label} — one per line (${list.hint})`}>
              <textarea
                name={`list-${list.key}`}
                rows={4}
                defaultValue={((ops[list.key] as string[] | null | undefined) ?? []).join('\n')}
                data-testid={`ops-list-${list.key}`}
                style={{ width: '100%', font: 'inherit', padding: 8, borderRadius: 6 }}
              />
            </Field>
          ))}
        </FormGrid>
        {errorMsg && (
          <Alert tone="error" className="mt-3">
            {errorMsg}
          </Alert>
        )}
        {message && (
          <Alert tone="success" className="mt-3" data-testid="ops-success">
            {message}
          </Alert>
        )}
        <FormActions>
          <Button type="submit" variant="primary" disabled={saving}>
            <Save size={14} aria-hidden />
            {saving ? 'Saving…' : 'Save operations'}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

/**
 * White-label branding. Saved separately from the main form so a
 * branding tweak can't accidentally resubmit tax/currency, and vice
 * versa. Changes apply on the next page load (the shell reads branding
 * once per session).
 */
function BrandingCard({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const b = settings.branding ?? {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const data = new FormData(e.currentTarget);
      const accentEnabled = data.get('accentEnabled') === 'on';
      const branding: Branding = {
        accentColor: accentEnabled ? String(data.get('accentColor') || '#4f46e5') : null,
        logoUrl: String(data.get('logoUrl') ?? '').trim() || null,
        publicName: String(data.get('publicName') ?? '').trim() || null,
      };
      const updated = await api<Settings>('/v1/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ branding }),
      });
      onSaved(updated);
      setMessage('Saved — reload to see the new look everywhere.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Branding"
      description="Make the app yours: the accent color re-themes buttons and navigation, the logo shows in the sidebar, and the display name appears on the shell and printed receipts (your legal business name above stays on record)."
      className="form-narrow"
    >
      <form onSubmit={submit}>
        <FormGrid cols={2}>
          <Field label="Display name (optional)">
            <Input
              name="publicName"
              defaultValue={b.publicName ?? ''}
              placeholder={settings.name}
            />
          </Field>
          <Field label="Logo URL (https, optional)">
            <Input
              name="logoUrl"
              type="url"
              defaultValue={b.logoUrl ?? ''}
              placeholder="https://…/logo.png"
            />
          </Field>
          <Field label="Accent color" className="form-span">
            <span className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  name="accentEnabled"
                  defaultChecked={Boolean(b.accentColor)}
                />
                Use custom color
              </span>
              <Input
                name="accentColor"
                type="color"
                defaultValue={b.accentColor ?? '#4f46e5'}
                className="h-8 w-12 p-0.5"
                aria-label="Accent color swatch"
                data-testid="branding-accent"
              />
            </span>
          </Field>
        </FormGrid>
        {errorMsg && (
          <Alert tone="error" className="mt-3">
            {errorMsg}
          </Alert>
        )}
        {message && (
          <Alert tone="success" className="mt-3" data-testid="branding-success">
            {message}
          </Alert>
        )}
        <FormActions>
          <Button type="submit" variant="primary" disabled={saving}>
            <Save size={14} aria-hidden />
            {saving ? 'Saving…' : 'Save branding'}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

/**
 * Reason-code registry (PLAN-STORIS-GAP §0.2): the coded, admin-managed
 * reasons every prompt in the app draws from — unlocks, adjustments,
 * returns, write-offs, transfer variances. Codes deactivate rather than
 * delete; restricted codes will require manager authorization to use
 * once the consuming flows land.
 */
function ReasonCodesCard() {
  const [codes, setCodes] = useState<
    | {
        id: string;
        code: string;
        description: string;
        usageClass: string;
        isRestricted: boolean;
        active: boolean;
      }[]
    | null
  >(null);
  const [newCode, setNewCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newClass, setNewClass] = useState<string>('exception');
  const [newRestricted, setNewRestricted] = useState(false);
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function load() {
    try {
      setCodes(await api<NonNullable<typeof codes>>('/v1/reason-codes?includeInactive=1'));
    } catch {
      setCodes([]);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    if (!newCode.trim() || !newDescription.trim()) {
      setErrorMsg('Code and description are required.');
      return;
    }
    setWorking(true);
    setErrorMsg(null);
    try {
      await api('/v1/reason-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: newCode.trim(),
          description: newDescription.trim(),
          usageClass: newClass,
          isRestricted: newRestricted,
        }),
      });
      setNewCode('');
      setNewDescription('');
      setNewRestricted(false);
      await load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function toggle(id: string, active: boolean) {
    setWorking(true);
    try {
      await api(`/v1/reason-codes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      });
      await load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card
      title="Reason codes"
      description="Every reason prompt (unlocks, price adjustments, returns, write-offs…) draws from these codes. Until a class has codes, that prompt accepts free text."
      className="form-narrow"
    >
      {codes === null ? (
        <LoadingRows rows={2} />
      ) : codes.length > 0 ? (
        <TableWrap>
          <table className="table" data-testid="reason-codes-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th>Class</th>
                <th>Restricted</th>
                <th className="actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className={c.active ? undefined : 'opacity-50'}>
                  <td>
                    <strong>{c.code}</strong>
                  </td>
                  <td>{c.description}</td>
                  <td>
                    {REASON_USAGE_CLASS_LABELS[c.usageClass as ReasonUsageClass] ?? c.usageClass}
                  </td>
                  <td>{c.isRestricted ? 'yes' : ''}</td>
                  <td className="actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working}
                      onClick={() => void toggle(c.id, !c.active)}
                    >
                      {c.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <EmptyState>No codes yet.</EmptyState>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <SectionHeading as="h3" title="Add a code" />
        <FormGrid cols={3}>
          <Field label="Code">
            <Input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="e.g. DMG"
              data-testid="reason-code-code"
            />
          </Field>
          <Field label="Description">
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              data-testid="reason-code-description"
            />
          </Field>
          <Field label="Class">
            <Select
              value={newClass}
              onChange={(e) => setNewClass(e.target.value)}
              data-testid="reason-code-class"
            >
              {REASON_USAGE_CLASSES.map((uc) => (
                <option key={uc} value={uc}>
                  {REASON_USAGE_CLASS_LABELS[uc]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Restricted" className="form-span">
            <CheckRow>
              <input
                type="checkbox"
                checked={newRestricted}
                onChange={(e) => setNewRestricted(e.target.checked)}
              />
              Requires manager authorization to use
            </CheckRow>
          </Field>
        </FormGrid>
        {errorMsg && (
          <Alert tone="error" className="mt-3">
            {errorMsg}
          </Alert>
        )}
        <FormActions>
          <Button type="submit" variant="primary" disabled={working} data-testid="reason-code-add">
            {working ? 'Adding…' : 'Add code'}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}
