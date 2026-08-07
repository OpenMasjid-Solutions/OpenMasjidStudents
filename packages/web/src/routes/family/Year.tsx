// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The year at a glance, in the parent portal (0.48.0).
 *
 * A parent could always see what they OWED. This shows the shape of the year instead — which months are
 * done and which are not — because the months that are fine are most of the reassurance, and "have we paid
 * for November?" is the question a parent actually rings the office about.
 *
 * NOT A TABLE. The office's version is a 200×12 grid you read across, and that is right at a desk; on a
 * phone twelve columns is a sideways drag with a sticky name column. Here each child is a card and their
 * months are chips that WRAP — so it lays out as three rows of four on a phone and one row of twelve on a
 * laptop, with no horizontal scrolling anywhere and every chip a thumb-sized target.
 *
 * The squares come from the same server-side function the staff grid uses (billing/yearCells.ts), so a
 * parent and the office are never looking at different answers about the same month.
 */
import { useTranslation } from 'react-i18next';
import { trpc } from '../../lib/trpc';

/** What each state means to a PARENT. The office's words are about invoices; a family's are about whether
 *  a month is settled — same eight states, said the way the reader thinks about them. */
const GLYPH: Record<string, string> = {
  paid: '✓',
  settled: '✓',
  partial: '½',
  open: '●',
  carried: '●',
  void: '—',
  none: '·',
  before: '·',
};

export function FamilyYear() {
  const { t } = useTranslation();
  const q = trpc.portal.yearGrid.useQuery();

  if (q.isLoading) return <div className="fam-empty">{t('status.connecting')}</div>;
  const blocks = q.data?.blocks ?? [];
  if (!blocks.length) {
    return <div className="fam-empty">{t('famYear.none')}</div>;
  }

  return (
    <>
      {blocks.map((b, i) => (
        <section key={i} className="fam-section">
          <h2>{b.schoolName ? `${b.schoolName} — ${b.yearLabel}` : b.yearLabel}</h2>
          {b.students.map((s) => (
            <div key={s.studentId} className="year-strip">
              <h3 className="year-strip-name">{s.fullName}</h3>
              <div className="year-chips">
                {s.cells.map((c) => (
                  <div key={c.periodKey} className={`year-chip is-${c.status}`}>
                    <span className="year-chip-month">{b.months.find((m) => m.periodKey === c.periodKey)?.label ?? c.periodKey}</span>
                    {/* The glyph carries the meaning; the title carries the sentence, so nothing depends
                        on a parent decoding a symbol on their own. */}
                    <span className="year-chip-mark" title={t(`famYear.cell_${c.status}`)} aria-label={t(`famYear.cell_${c.status}`)}>
                      {GLYPH[c.status] ?? '·'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="hint">{t('famYear.legend')}</p>
        </section>
      ))}
    </>
  );
}
