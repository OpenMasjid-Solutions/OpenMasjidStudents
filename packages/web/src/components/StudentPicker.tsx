// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Pick a student by TYPING or by browsing — one control that does both.
 *
 * A plain `<select>` was fine at twenty students and useless at three hundred: scrolling a dropdown to
 * find "Yusuf" is not how anyone looks for a name. A plain search box is worse in the opposite
 * direction — it hides the roster from an office that wants to see who is there. So this is a combobox:
 * click it and the whole list drops down, type and it narrows.
 *
 * Each row shows the Student ID as well as the name, because a madrasa genuinely enrols two children with
 * the same name and the moment of choosing is the one moment that matters. Matching runs against
 * everything shown, so the office can paste an ID straight in.
 *
 * THE HOUSEHOLD IS OPTIONAL, and off by default (0.48.0). It is essential where the household is what you
 * are choosing — linking a sibling MERGES two of them, and "which Ismail household?" is the actual
 * question — and it is noise everywhere else, where a third of every row repeated the surname already in
 * the child's name. Recording a payment is the clearest case: money lands on ONE CHILD, so the household
 * has no bearing on the choice being made.
 *
 * `showFamily` therefore governs the row AND the matching together, on purpose: a field you cannot see
 * should not be able to explain why a row matched.
 *
 * Deliberately hand-rolled rather than another dependency: it is a text input, a filtered list and four
 * key handlers. It follows the ARIA combobox pattern (roles, `aria-expanded`, `aria-activedescendant`)
 * so it works by keyboard and to a screen reader, uses logical properties so RTL is free, and its rows
 * are full-width targets for a thumb.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, X } from 'lucide-react';

export interface PickableStudent {
  id: string;
  fullName: string;
  studentCode?: string | null;
  familyName?: string | null;
}

interface Props {
  students: PickableStudent[];
  /** The chosen student's id, or '' for none. Controlled by the parent. */
  value: string;
  onChange: (studentId: string) => void;
  /** Ids to leave out — the children already in this household have nothing to join. */
  exclude?: string[];
  /** Show (and match on) the household under each name. Only where the household is part of the
   *  decision — linking a sibling. See the header. */
  showFamily?: boolean;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/** Everything a row can be matched on, lowercased once — and only what the row actually shows. */
function haystack(s: PickableStudent, withFamily: boolean): string {
  return `${s.fullName} ${s.studentCode ?? ''} ${withFamily ? s.familyName ?? '' : ''}`.toLowerCase();
}

export function StudentPicker({ students, value, onChange, exclude = [], showFamily = false, label, placeholder, disabled, id }: Props) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? `picker-${autoId}`;
  const listId = `${inputId}-list`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const skip = new Set(exclude);
    const pool = students.filter((s) => !skip.has(s.id));
    const needle = query.trim().toLowerCase();
    if (!needle) return pool;
    // Every word must appear somewhere, so "yusuf ismail" and "ismail yusuf" both find the same child.
    const words = needle.split(/\s+/);
    return pool.filter((s) => {
      const hay = haystack(s, showFamily);
      return words.every((w) => hay.includes(w));
    });
  }, [students, exclude, query, showFamily]);

  const chosen = students.find((s) => s.id === value) ?? null;

  // Close on a click anywhere else. Without this the list stays open behind the next thing you touch.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in range as the list narrows under the typing.
  useEffect(() => setActive(0), [query]);

  function choose(s: PickableStudent) {
    onChange(s.id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function clear() {
    onChange('');
    setQuery('');
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!options.length) return;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % options.length : (i - 1 + options.length) % options.length));
      return;
    }
    if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault(); // don't submit the form with the list open — Enter means "take this one"
        choose(options[active]);
      }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="field picker" ref={boxRef} style={{ position: 'relative' }}>
      {label && (
        <label className="label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="picker-control">
        <input
          id={inputId}
          ref={inputRef}
          className="input glass-inset"
          // The chosen name lives in the input's value when the list is shut, so the field reads as
          // "Yusuf Ismail" rather than going blank the moment focus leaves.
          value={open ? query : (chosen?.fullName ?? '')}
          placeholder={placeholder ?? t('picker.placeholder')}
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${options[active].id}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A click re-opens after a selection, which is what makes this a dropdown as well as a search.
          onMouseDown={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {chosen && !disabled ? (
          <button type="button" className="picker-btn" onClick={clear} aria-label={t('common.clear')} title={t('common.clear')}>
            <X size={15} />
          </button>
        ) : (
          <button
            type="button"
            className="picker-btn"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onClick={() => {
              setOpen((v) => !v);
              inputRef.current?.focus();
            }}
          >
            <ChevronDown size={15} />
          </button>
        )}
      </div>

      {open && (
        <ul className="picker-list glass" id={listId} role="listbox">
          {options.length === 0 ? (
            <li className="picker-empty" role="presentation">
              {t('picker.noMatches')}
            </li>
          ) : (
            options.map((s, i) => (
              <li key={s.id} id={`${listId}-${s.id}`} role="option" aria-selected={s.id === value}>
                <button
                  type="button"
                  className={`picker-row${i === active ? ' is-active' : ''}`}
                  // Highlight follows the pointer so mouse and keyboard agree on what Enter would take.
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s)}
                >
                  <span className="picker-name">{s.fullName}</span>
                  {s.studentCode && <span className="code">{s.studentCode}</span>}
                  {showFamily && s.familyName && <span className="muted picker-sub">{s.familyName}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
