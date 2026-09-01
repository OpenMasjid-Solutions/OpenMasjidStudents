// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The "which month, and what is it called" half of a Generate-invoices form (0.48.0).
 *
 * ONE component, used by both places invoices are generated: the whole-school run on the Billing tab and
 * the single-household run inside a family's record. They were separate forms, and the family one still
 * had the original pair of free-text boxes — a period key typed as `2026-07` and a label typed as
 * "Tuition — Jun 2026", with nothing checking they agreed. On a record that is never edited afterwards
 * (§9, money history) that is one keystroke away from a bill filed under the wrong month for the rest of
 * the year. Sharing the fields is what stops the two screens drifting apart again.
 *
 * The month is PICKED from the school year's own months, and the label is a TEMPLATE with tags in it,
 * saved so it is written once rather than retyped monthly. The template — not the resolved text — is what
 * goes to the server: `resolveInvoiceLabel` (billing/period.ts) fills the tags in from the period key it
 * is actually filing under, so the label and the month cannot disagree.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MONTH_NAMES } from '../lib/months';
import { trpc } from '../lib/trpc';

export type InvoiceGen = { periodKey: string; label: string; dueDate: string };

/**
 * The label as it will read, using the same tags the server resolves.
 *
 * A PREVIEW, not the source of truth — the stored label is derived server-side from the period key. It
 * exists because a template with `[month]` in it is not what a parent will read, and the office is about
 * to commit it to a record they cannot edit.
 */
export function previewInvoiceLabel(template: string, periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  if (!y || !m) return template;
  const subs: Record<string, string> = {
    month: MONTH_NAMES[m - 1],
    mon: MONTH_NAMES[m - 1].slice(0, 3),
    year: String(y),
    yy: String(y).slice(-2),
    period: periodKey,
  };
  return template.replace(/\[(month|mon|year|yy|period)\]/gi, (whole, tag: string) => subs[tag.toLowerCase()] ?? whole);
}

/**
 * The form's state, seeded from the server's saved template and suggested month.
 *
 * Seeding happens ONCE the config arrives and only into fields the office has not touched — re-seeding
 * over an edit in progress is the classic controlled-input bug. `ready` is what a submit button should
 * be disabled on, so nothing can be generated before there is a month to file it under.
 */
export function useInvoiceGen() {
  const cfg = trpc.billing.invoiceLabelConfig.useQuery();
  const [gen, setGen] = useState<InvoiceGen>({ periodKey: '', label: '', dueDate: '' });

  useEffect(() => {
    if (!cfg.data) return;
    setGen((g) => ({ ...g, periodKey: g.periodKey || cfg.data!.suggested, label: g.label || cfg.data!.template }));
  }, [cfg.data]);

  return { gen, setGen, cfg, ready: !!gen.periodKey && !!gen.label.trim() };
}

/**
 * "For which month?" on its own, where the month is OPTIONAL — a one-off charge and a mass apply
 * (0.51.0).
 *
 * Both of those screens asked for a "period key" in a free-text box with `2026-07` as the placeholder,
 * which is this app's storage format leaking onto a volunteer's screen. Three things were wrong with
 * it and only the first is cosmetic: nobody outside this codebase calls a month a period key; a typo
 * lands the charge on a month that will never be generated, where it sits invisibly forever; and the
 * SAME question two clicks away on the invoice form was already a dropdown, so the app disagreed with
 * itself about what a month is.
 *
 * EMPTY IS A REAL ANSWER HERE and is why this is not `InvoiceGenFields`' month field. On an invoice the
 * month is what is being generated and is required; on a charge it means "whichever invoice comes next",
 * which is the common case and stays the default. So the blank option is first and is spelled out
 * rather than left as a bare dash.
 */
export function PeriodMonthSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const cfg = trpc.billing.invoiceLabelConfig.useQuery();
  return (
    <div className="field" style={{ flex: '0 1 12rem' }}>
      <label className="label" htmlFor={id}>{t('billing.forMonth')}</label>
      <select id={id} className="input glass-inset" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('billing.periodNext')}</option>
        {(cfg.data?.months ?? []).map((m) => (
          <option key={m.periodKey} value={m.periodKey}>{m.label}</option>
        ))}
        {/* A charge already filed against a month outside the current school year would otherwise
            vanish from its own form the moment the year rolls over. Kept as itself. */}
        {value && !(cfg.data?.months ?? []).some((m) => m.periodKey === value) && <option value={value}>{value}</option>}
      </select>
      <span className="hint">{t('billing.periodHint')}</span>
    </div>
  );
}

/** The month, the label (with its tag chips and live preview) and the due date. The submit button stays
 *  with the caller — the two screens generate different things and say so on the button. */
export function InvoiceGenFields({
  gen,
  setGen,
  idPrefix = 'gen',
}: {
  gen: InvoiceGen;
  setGen: React.Dispatch<React.SetStateAction<InvoiceGen>>;
  /** Both forms can be mounted at once (a family window over the Billing tab), so the ids must differ. */
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const cfg = trpc.billing.invoiceLabelConfig.useQuery();

  return (
    <>
      <div className="field" style={{ flex: '0 1 12rem' }}>
        <label className="label" htmlFor={`${idPrefix}-period`}>{t('billing.forMonth')}</label>
        <select id={`${idPrefix}-period`} className="input glass-inset" value={gen.periodKey} onChange={(e) => setGen((g) => ({ ...g, periodKey: e.target.value }))}>
          {(cfg.data?.months ?? []).map((m) => (
            <option key={m.periodKey} value={m.periodKey}>{m.label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-label`}>{t('billing.label')}</label>
        <input id={`${idPrefix}-label`} className="input glass-inset" value={gen.label} onChange={(e) => setGen((g) => ({ ...g, label: e.target.value }))} placeholder={t('billing.labelHint')} />
        {/* Tag chips, so nobody has to remember the spelling — and a live preview, because a template
            with tags in it is not what a parent will read. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBlockStart: '0.35rem', alignItems: 'center' }}>
          {(cfg.data?.tags ?? []).map((tg) => (
            <button
              key={tg.tag}
              type="button"
              className="chip"
              title={t('billing.tagInsert', { example: tg.example })}
              onClick={() => setGen((g) => ({ ...g, label: `${g.label}[${tg.tag}]` }))}
            >
              [{tg.tag}]
            </button>
          ))}
        </div>
        {gen.label.trim() && gen.periodKey && (
          <p className="hint" style={{ marginBlockStart: '0.35rem' }}>{t('billing.labelPreview', { label: previewInvoiceLabel(gen.label, gen.periodKey) })}</p>
        )}
      </div>
      <div className="field" style={{ flex: '0 1 10rem' }}>
        <label className="label" htmlFor={`${idPrefix}-due`}>{t('billing.due')}</label>
        <input id={`${idPrefix}-due`} type="date" className="input glass-inset" value={gen.dueDate} onChange={(e) => setGen((g) => ({ ...g, dueDate: e.target.value }))} />
      </div>
    </>
  );
}
