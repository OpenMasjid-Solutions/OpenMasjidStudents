// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Admin landing — a welcome card + stat tiles that jump to the relevant section.
 *  Mirrors the family dashboard look (OpenMasjidOS / Kiosk). */
import { type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Users, UsersRound } from 'lucide-react';
import { fadeRise, staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { type Section } from '../../components/Dock';

export function Dashboard({ onNavigate }: { onNavigate: (s: Section) => void }) {
  const { t } = useTranslation();
  const dir = trpc.people.directory.useQuery();

  const families = dir.data?.length ?? 0;
  const students = dir.data?.reduce((n, f) => n + f.students.filter((s) => s.status === 'active').length, 0) ?? 0;

  const stats: { icon: ReactNode; value: ReactNode; label: string; go: Section }[] = [
    { icon: <Users size={18} />, value: students, label: t('dashboard.students'), go: 'students' },
    { icon: <UsersRound size={18} />, value: families, label: t('dashboard.families'), go: 'students' },
  ];

  return (
    <div className="page">
      <div className="admin-header"><h1 className="page-title" style={{ fontSize: '1.6rem' }}>{t('dashboard.title')}</h1></div>

      <motion.div className="glass" style={{ padding: '1.25rem 1.4rem' }} variants={fadeRise} initial="initial" animate="animate">
        <h2 style={{ margin: '0 0 0.4rem' }}>{t('dashboard.welcome')}</h2>
        <p className="page-sub" style={{ margin: 0 }}>{t('dashboard.welcomeBody')}</p>
      </motion.div>

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
