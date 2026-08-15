// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Parent portal — My Family (CLAUDE.md §4/§15). Phone-first: a big balance card, the family's
 *  kids (with their Student IDs), open invoices, recent payments, pay-now, saved cards, and autopay.
 *  Everything is family-scoped server-side. */
import { useState } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Repeat, ChevronRight } from 'lucide-react';
import { staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { formatMoney } from '../../lib/money';
import { describeMethod, methodTitle } from '../../lib/paymentMethod';
import { PayNow, type ChosenLine } from './PayNow';

/**
 * The autopay offer, directly under the balance (0.44.0).
 *
 * This is the whole point of the tab split: the setup it leads to used to be at the very bottom of the
 * page, under every bill and the entire payment history, which on a phone is several screens of
 * scrolling past things a parent did not come here to read. So the offer comes to them, once, where
 * they are already looking — and once it is on, the same card is how they check which card gets charged.
 *
 * Its own component because it needs a per-family query, and Home renders one of these per household.
 */
function AutopayCta({ familyId, onManage }: { familyId: string; onManage: () => void }) {
  const { t } = useTranslation();
  const statusQ = trpc.portal.autopayStatus.useQuery({ familyId });
  if (!statusQ.data?.ready) return null; // card payments not configured → nothing to offer
  const { enabled, cards, defaultPmId } = statusQ.data;
  const card = cards.find((c) => c.id === defaultPmId) ?? cards.find((c) => c.isDefault) ?? cards[0];
  // "Visa ···· 4242" or "Chase ···· 6789" — whichever it really is, so the line under "Autopay is on"
  // names the thing that will actually be charged (lib/paymentMethod.ts).
  const cardText = card ? methodTitle(describeMethod(card), t('family.savedMethod')) : '';

  return (
    <button type="button" className={`autopay-cta ${enabled ? 'is-on' : ''}`} onClick={onManage}>
      <span className="ico" aria-hidden="true"><Repeat size={18} /></span>
      <span className="txt">
        <strong>{enabled ? t('family.autopayIsOn') : t('family.autopaySetUp')}</strong>
        <span className="sub">
          {enabled
            ? cardText
              ? t('family.autopayOnCard', { card: cardText })
              : t('family.autopayOn')
            : t('family.autopaySetUpHint')}
        </span>
      </span>
      <span className="go" aria-hidden="true"><ChevronRight size={18} /></span>
    </button>
  );
}

export function FamilyHome({ onManageAutopay }: { onManageAutopay: () => void }) {
  const { t } = useTranslation();
  const q = trpc.portal.myFamily.useQuery();
  const payConfigQ = trpc.portal.payConfig.useQuery();
  const utils = trpc.useUtils();
  /** Bill lines the parent has ticked to pay, by line id. Cleared once a payment goes through. */
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  if (q.isLoading) return <div className="fam-empty">{t('status.connecting')}</div>;
  // A transient failure must not masquerade as "you have no family" (which tells them to call the office).
  if (q.isError) return <div className="fam-empty">{t('family.loadError')}</div>;
  const data = q.data;
  if (!data || data.families.length === 0) return <div className="fam-empty">{t('family.noFamily')}</div>;
  const money = (c: number) => formatMoney(c, data.currency);
  const fmtDate = (v: unknown) => new Date(v as number).toLocaleDateString();
  /** The child an invoice or payment belongs to. */
  const kidName = (fam: (typeof data.families)[number], studentId: string) => {
    const s = fam.students.find((k) => k.id === studentId);
    return s ? s.fullName : '';
  };

  /** The ticked lines of ONE household, named for the payment summary. Amounts come from the server's
   *  own figures, never from anything held in this component. */
  const chosenFor = (fam: (typeof data.families)[number]): ChosenLine[] =>
    fam.invoices.flatMap((i) =>
      i.items.filter((it) => picked[it.id] && it.balanceCents > 0).map((it) => ({ itemId: it.id, label: `${kidName(fam, i.studentId)} · ${it.label}`, amountCents: it.balanceCents })),
    );

  const onPaid = () => {
    setPicked({});
    void utils.portal.myFamily.invalidate();
  };

  return (
    <motion.div variants={staggerContainer} initial="initial" animate="animate" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {data.families.map((fam) => {
        const owed = fam.balance.owedCents > 0;
        const credit = fam.balance.creditCents > 0;
        return (
          <motion.div key={fam.id} variants={staggerItem} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {data.families.length > 1 && <div className="fam-hello"><h1>{fam.name}</h1></div>}

            {/* Balance */}
            <div className="balance-card glass-raised">
              <div className="lbl">{t('family.balance')}</div>
              <div className={`amt ${owed ? 'owed' : 'settled'}`}>
                {owed ? money(fam.balance.owedCents) : credit ? money(fam.balance.creditCents) : money(0)}
              </div>
              <div className="sub">{owed ? t('family.due') : credit ? t('family.inCredit') : t('family.allSettled')}</div>
              {/* Offered even when nothing is due: a parent who wants to pay the term up front, or
                  top up before travelling, should not have to wait for an invoice to exist. PayNow
                  re-words itself for that case; the money lands as credit and the next invoices
                  generated absorb it. */}
              {payConfigQ.data?.ready && chosenFor(fam).length === 0 && (
                <PayNow familyId={fam.id} owedCents={fam.balance.owedCents} currency={data.currency} onPaid={onPaid} />
              )}
            </div>

            {/* Autopay — offered here, set up on its own tab. */}
            <AutopayCta familyId={fam.id} onManage={onManageAutopay} />

            {/* Kids, each with the one thing a parent needs to pay anywhere: their Student ID. */}
            <section className="fam-section">
              <h2>{t('family.children')}</h2>
              {fam.students.length === 0 ? (
                <div className="fam-empty">{t('family.noChildren')}</div>
              ) : (
                <>
                  {fam.students.map((s) => (
                    <div key={s.id} className="kid-row glass">
                      <span className="kid-name">
                        {s.fullName}
                        {/* Each child has their own bill now, so say what each one owes. The big card
                            above is still the single figure the parent pays. */}
                        <span className="kid-sub">
                          {s.balance.owedCents > 0
                            ? t('family.kidOwes', { amount: money(s.balance.owedCents) })
                            : s.balance.creditCents > 0
                              ? t('family.kidCredit', { amount: money(s.balance.creditCents) })
                              : t('family.kidSettled')}
                        </span>
                      </span>
                      {s.studentCode && <span className="kid-code"><span className="code-lbl">{t('directory.studentId')}</span>{s.studentCode}</span>}
                    </div>
                  ))}
                  <p className="fam-hint">{t('family.kioskHint')}</p>
                </>
              )}
            </section>

            {/* Open bills, itemised. A bill of one line reads as it always did; a bill that is tuition
                PLUS something else says so, and each line can be paid on its own — "just the book fee"
                is a real thing parents ask for, and it used to be impossible to express. */}
            <section className="fam-section">
              <h2>{t('family.openInvoices')}</h2>
              {fam.invoices.length === 0 ? (
                <div className="fam-empty">{t('family.noOpenInvoices')}</div>
              ) : (
                fam.invoices.map((i) => (
                  <div key={i.id} className="bill glass">
                    <div className="list-row" style={{ background: 'none', boxShadow: 'none', padding: 0 }}>
                      <div className="row-main">
                        {/* Whose bill it is, first: with one invoice per child, three "Tuition — Jul"
                            rows are indistinguishable without the name. */}
                        <span className="row-title">{kidName(fam, i.studentId)}</span>
                        <span className="row-sub">
                          {i.label}
                          {i.dueDate ? ` · ${t('family.due')} ${fmtDate(new Date(`${i.dueDate}T12:00:00`).getTime())}` : ''}
                        </span>
                      </div>
                      <span className="row-amt neg">{money(i.balanceCents)}</span>
                    </div>
                    {i.items.length > 1 && (
                      <ul className="bill-lines">
                        {i.items.map((it) => {
                          const payable = it.balanceCents > 0;
                          return (
                            <li key={it.id}>
                              <label className={payable ? '' : 'is-muted'}>
                                {payable && payConfigQ.data?.ready ? (
                                  <input type="checkbox" checked={!!picked[it.id]} onChange={(e) => setPicked((p) => ({ ...p, [it.id]: e.target.checked }))} />
                                ) : (
                                  <span className="bill-dot" aria-hidden="true" />
                                )}
                                <span className="bill-line-label">
                                  {it.label}
                                  {it.kind !== 'tuition' && <span className="chip is-accent">{t(`billing.kind_${it.kind}`)}</span>}
                                </span>
                                <span className="tnum">{payable ? money(it.balanceCents) : it.kind === 'credit' ? money(it.amountCents) : t('family.linePaid')}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))
              )}
              {/* Ticked something? Pay exactly that, instead of the whole balance. */}
              {chosenFor(fam).length > 0 && payConfigQ.data?.ready && (
                <div className="pay-picked glass-raised">
                  <span>{t('family.chosenCount', { count: chosenFor(fam).length })}</span>
                  <button type="button" className="link-btn" onClick={() => setPicked({})}>{t('common.clear')}</button>
                  <PayNow familyId={fam.id} owedCents={fam.balance.owedCents} currency={data.currency} chosen={chosenFor(fam)} onPaid={onPaid} />
                </div>
              )}
            </section>

            {/* Payment history */}
            <section className="fam-section">
              <h2>{t('family.paymentHistory')}</h2>
              {fam.payments.length === 0 ? (
                <div className="fam-empty">{t('family.noPayments')}</div>
              ) : (
                fam.payments.map((p) => (
                  <div key={p.id} className="list-row glass">
                    <div className="row-main">
                      {/* WHAT it paid for, not just who and how much (0.48.0). A household on a monthly
                          plan sees a column of identical amounts, and "which one was February, and did it
                          cover the books?" is the question the office gets asked. Derived from the
                          payment's allocations, so it says where the money sits now. */}
                      <span className="row-title">
                        {kidName(fam, p.studentId)}
                        {p.paidFor.labels.length > 0 && <span className="row-for"> · {p.paidFor.labels.join(' · ')}{p.paidFor.more > 0 ? ` · ${t('family.paidForMore', { count: p.paidFor.more })}` : ''}</span>}
                      </span>
                      {/* One card payment covering several children appears as one row per child.
                          That is the truth of it — each child's balance moved by their own share. */}
                      <span className="row-sub">
                        {t(`billing.ch_${p.channel}`, p.channel)} · {fmtDate(p.occurredAt)}
                        {/* Allocated to no bill at all: paid before anything was raised, so it is credit
                            waiting on the next invoice. Saying nothing here reads as money gone missing. */}
                        {p.paidFor.advance && !p.reversalOf && p.amountCents > 0 ? ` · ${t('family.paidAhead')}` : ''}
                        {p.reversalOf ? ` · ${t('family.reversed')}` : ''}
                      </span>
                    </div>
                    <span className={`row-amt ${p.amountCents < 0 ? 'neg' : 'pos'}`}>{money(p.amountCents)}</span>
                  </div>
                ))
              )}
            </section>

            {/* Saved cards + autopay used to sit here, at the very bottom. They are a tab of their own
                now (0.44.0) — reached from the card under the balance above. */}
          </motion.div>
        );
      })}

      {/* One switch, not one per household: it is about this parent's own phone, and a person has one
          of those however many households they are linked to. Last on the page on purpose — it is a
          preference, and nobody opens the portal to find it. */}
      <WhatsAppOptOut />
    </motion.div>
  );
}

/**
 * Who on this household hears from the madrasa on WhatsApp (0.50.0).
 *
 * EVERY ADULT ON THE HOUSEHOLD, not just whoever is signed in — because this portal IS the household.
 * A father activates it, a mother activates it with her own email, and the two of them are looking at
 * the same balance, the same bills and the same saved cards. There is no "my half" of a household
 * here, so a parent setting messages up for the family should not have to ring the office to get
 * their spouse's number switched on.
 *
 * The value is still stored per person, because it is a decision about a phone and a household has
 * two of them. What is shared is the ability to make the decision — which is what sharing a portal
 * already means for money.
 *
 * Renders nothing at all when the madrasah has not switched WhatsApp on, rather than showing a dead
 * toggle for a channel that does not exist here.
 */
function WhatsAppOptOut() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.portal.messagingGet.useQuery();
  const save = trpc.portal.messagingSet.useMutation();
  if (!q.data?.available) return null;

  return (
    <section className="fam-section">
      <h2>{t('family.messages')}</h2>
      {q.data.people.map((p) => {
        const on = !p.optedOut;
        return (
          <label key={p.guardianId} className="list-row glass" style={{ cursor: p.mask ? 'pointer' : 'default', alignItems: 'flex-start', gap: '0.6rem' }}>
            <input
              type="checkbox"
              style={{ marginBlockStart: '0.25rem' }}
              checked={on}
              // Nothing to switch when there is no number we can use: the row still appears, so the
              // family can see who is missing one and tell the office.
              disabled={save.isPending || !p.mask}
              onChange={async () => {
                await save.mutateAsync({ guardianId: p.guardianId, optOut: on });
                await utils.portal.messagingGet.invalidate();
              }}
            />
            <span className="row-main">
              <span className="row-title">{p.isYou ? t('family.waOptInYou') : t('family.waOptInOther', { name: p.name })}</span>
              {/* Says WHICH number without printing it — and says plainly when there isn't one, which
                  is otherwise indistinguishable from "switched on and silently never arriving". */}
              <span className="row-sub">{p.mask ? t('family.waOptInHint', { mask: p.mask }) : t('family.waNoNumber')}</span>
            </span>
          </label>
        );
      })}
      <p className="hint" style={{ marginBlockStart: '0.4rem' }}>{t('family.waHouseholdHint')}</p>
    </section>
  );
}
