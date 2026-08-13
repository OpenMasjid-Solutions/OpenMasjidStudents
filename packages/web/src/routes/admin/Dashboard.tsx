// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Admin landing — a welcome card + stat tiles that jump to the relevant section.
 *  Mirrors the family dashboard look (OpenMasjidOS / Kiosk). */
import { lazy, Suspense, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Rocket, School, Users, UsersRound } from 'lucide-react';
import { fadeRise, staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { type Section } from '../../components/Dock';
import { useWindows } from '../../components/Windows';

/** A once-per-install screen, so it stays out of the bundle until somebody presses the button — the same
 *  treatment the go-live wizard and What's new get. */
const FirstRunSetup = lazy(() => import('../../components/FirstRunSetup').then((m) => ({ default: m.FirstRunSetup })));

export function Dashboard({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const { t } = useTranslation();
  const { open } = useWindows();
  const dir = trpc.people.directory.useQuery();
  /** Per-school headcounts (0.47.0). Only rendered when there is more than one school — otherwise the
   *  tile would just repeat the total sitting next to it. */
  const counts = trpc.structure.schoolCounts.useQuery();

  const families = dir.data?.length ?? 0;
  const students = dir.data?.reduce((n, f) => n + f.students.filter((s) => s.status === 'active').length, 0) ?? 0;

  const perSchool = counts.data ?? [];
  const stats: { icon: ReactNode; value: ReactNode; label: string; go: Section }[] = [
    { icon: <Users size={18} />, value: students, label: t('dashboard.students'), go: 'students' },
    { icon: <UsersRound size={18} />, value: families, label: t('dashboard.families'), go: 'students' },
    ...(perSchool.length > 1
      ? perSchool.map((s) => ({ icon: <School size={18} />, value: s.students, label: s.name, go: 'students' as Section }))
      : []),
  ];

  const openFirstRun = () =>
    open({
      title: t('firstRun.title'),
      wide: true,
      dedupeKey: 'first-run',
      icon: <Rocket size={15} />,
      node: (
        <Suspense fallback={<p className="empty">{t('common.loading')}</p>}>
          <FirstRunSetup />
        </Suspense>
      ),
    });

  /**
   * Offer setup while there is nobody on the roster.
   *
   * A FACT, not a flag: it needs no "setup complete" marker to keep in step with reality, it cannot get
   * stuck on, and it clears itself the moment the first student exists. `dir.isSuccess` matters — without
   * it the panel flashes up for every admin on every load, in the moment before the roster arrives.
   */
  const needsSetup = dir.isSuccess && students === 0;

  return (
    <div className="page">
      <div className="admin-header"><h1 className="page-title" style={{ fontSize: '1.6rem' }}>{t('dashboard.title')}</h1></div>

      {needsSetup ? (
        <motion.div className="glass setup-cta" variants={fadeRise} initial="initial" animate="animate">
          <span className="setup-cta-icon"><Rocket size={26} /></span>
          <div>
            <h2>{t('firstRun.ctaTitle')}</h2>
            <p>{t('firstRun.ctaBody')}</p>
          </div>
          <button type="button" className="btn btn--primary setup-cta-btn" onClick={openFirstRun}>
            {t('firstRun.ctaButton')}
          </button>
        </motion.div>
      ) : (
        <motion.div className="glass" style={{ padding: '1.25rem 1.4rem' }} variants={fadeRise} initial="initial" animate="animate">
          <h2 style={{ margin: '0 0 0.4rem' }}>{t('dashboard.welcome')}</h2>
          <p className="page-sub" style={{ margin: 0 }}>{t('dashboard.welcomeBody')}</p>
        </motion.div>
      )}

      <motion.div className="card-grid" variants={staggerContainer} initial="initial" animate="animate" style={{ marginBlockStart: '1.25rem' }}>
        {stats.map((s, i) => (
          <motion.button key={i} type="button" className="stat-card glass fx-glint" variants={staggerItem} onClick={() => onNavigate(s.go)}>
            <span className="stat-icon">{s.icon}</span>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}
