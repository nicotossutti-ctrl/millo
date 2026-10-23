/** CSV estilo Argentina: separador ";" y coma decimal, para abrir directo en Excel/Sheets. */
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return v.toFixed(2).replace('.', ',');
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => c.header).join(';')];
  for (const r of rows) lines.push(columns.map((c) => esc(c.value(r))).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** yyyymmdd -> dd/mm/yyyy */
export function fechaArca(s) {
  if (!s || s.length !== 8) return s ?? '';
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}
