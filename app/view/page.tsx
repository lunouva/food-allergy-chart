'use client';

import { useEffect, useMemo, useState } from 'react';

const ALLERGENS = ['Egg', 'Milk', 'Peanuts', 'Sesame', 'Soy', 'Tree Nuts', 'Wheat'] as const;
type Allergen = (typeof ALLERGENS)[number];
type AllergenValue = 'Yes' | 'No' | 'Unknown';
type Category = 'Ice Cream' | 'Mix-In' | 'Cake' | 'Cone/Bowl' | 'Other';

type FlavorRecord = {
  flavor: string;
  category: Category;
  allergens: Record<Allergen, AllergenValue>;
};

function safeParseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function fromBase64Url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeCategory(v: unknown): Category {
  if (v === 'Ice Cream' || v === 'Mix-In' || v === 'Cake' || v === 'Cone/Bowl' || v === 'Other') return v;
  return 'Mix-In';
}

function normalizeValue(v: string): AllergenValue {
  const t = (v ?? '').trim().toLowerCase();
  if (t === 'yes') return 'Yes';
  if (t === 'no') return 'No';
  return 'Unknown';
}

function inferCategory(name: string): Category {
  const t = (name ?? '').toLowerCase();
  if (t.includes('ice cream') || t.includes('sorbet')) return 'Ice Cream';
  if (t.includes('cake') || t.includes('brownie')) return 'Cake';
  if (t.includes('cone') || t.includes('waffle') || t.includes('bowl')) return 'Cone/Bowl';
  return 'Mix-In';
}

function groupByCategory(rows: FlavorRecord[]): [Category, FlavorRecord[]][] {
  const map: Record<Category, FlavorRecord[]> = {
    'Ice Cream': [], 'Mix-In': [], Cake: [], 'Cone/Bowl': [], Other: [],
  };
  for (const r of rows) map[r.category]?.push(r);
  for (const k of Object.keys(map) as Category[]) map[k].sort((a, b) => a.flavor.localeCompare(b.flavor));
  return (Object.entries(map) as [Category, FlavorRecord[]][]).filter(([, v]) => v.length > 0);
}

const thStyle: React.CSSProperties = {
  background: '#111',
  color: '#fff',
  padding: '7px 8px',
  textAlign: 'left',
  fontWeight: 900,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  border: '1px solid #333',
};

const tdStyle: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid #ddd',
  verticalAlign: 'top',
};

function AllergenTable({ rows }: { rows: FlavorRecord[] }) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={thStyle}>Flavor</th>
          {ALLERGENS.map((a) => (
            <th key={a} style={{ ...thStyle, textAlign: 'center', width: 70 }}>{a}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.flavor} style={{ background: i % 2 === 1 ? '#fafafa' : '#fff' }}>
            <td style={{ ...tdStyle, fontWeight: 700 }}>{r.flavor}</td>
            {ALLERGENS.map((a) => {
              const v = r.allergens[a] ?? 'Unknown';
              const bg = v === 'Yes' ? '#e7f7ec' : v === 'Unknown' ? '#fff6db' : 'transparent';
              return (
                <td key={a} style={{ ...tdStyle, textAlign: 'center', background: bg, fontWeight: 800, fontSize: 12 }}>
                  {v}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ViewPage() {
  const [masterRows, setMasterRows] = useState<FlavorRecord[]>([]);
  const [rows, setRows] = useState<FlavorRecord[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const payload = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const s = new URLSearchParams(window.location.search).get('s');
    if (!s) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    try { return safeParseJson<{ selected?: unknown; ui?: unknown }>(fromBase64Url(s)); } catch { return null; }
  }, []);

  const selected = useMemo<Set<string>>(() => {
    if (!payload || !Array.isArray(payload.selected)) return new Set();
    return new Set(payload.selected.map(String));
  }, [payload]);

  const splitByCategory = useMemo<boolean>(() => {
    const ui = payload?.ui as Record<string, unknown> | null;
    return typeof ui?.splitByCategory === 'boolean' ? ui.splitByCategory : true;
  }, [payload]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/flavors');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json() as { rows: Array<{ flavor: string; allergens: Record<string, string> }> };
        const parsed: FlavorRecord[] = json.rows.map((r) => ({
          flavor: r.flavor,
          category: inferCategory(r.flavor),
          allergens: Object.fromEntries(
            ALLERGENS.map((a) => [a, normalizeValue(r.allergens?.[a] ?? 'Unknown')])
          ) as Record<Allergen, AllergenValue>,
        }));

        // Merge manual rows from localStorage
        const manual = safeParseJson<Array<{ flavor: string; category?: Category; allergens: Record<string, AllergenValue> }>>(
          localStorage.getItem('fac_manual_flavors_v2')
        ) ?? [];
        const manualClean: FlavorRecord[] = manual
          .map((m) => {
            const flavor = (m.flavor ?? '').trim();
            if (!flavor) return null;
            return {
              flavor,
              category: safeCategory(m.category ?? inferCategory(flavor)),
              allergens: Object.fromEntries(ALLERGENS.map((a) => [a, m.allergens?.[a] ?? 'Unknown'])) as Record<Allergen, AllergenValue>,
            };
          })
          .filter(Boolean) as FlavorRecord[];

        const manualNames = new Set(manualClean.map((r) => r.flavor));
        const all = [...manualClean, ...parsed.filter((r) => !manualNames.has(r.flavor))];
        setMasterRows(all);
      } catch {
        setError('Could not load flavor data.');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (!payload) { setError('No selection found in this link.'); return; }
    setRows(masterRows.filter((r) => selected.has(r.flavor)).sort((a, b) => a.flavor.localeCompare(b.flavor)));
  }, [loaded, masterRows, selected, payload]);

  if (!loaded) return <div style={{ padding: 32, color: '#666' }}>Loading…</div>;
  if (error) return <div style={{ padding: 32, color: '#b5121b' }}>{error}</div>;
  if (rows.length === 0) return <div style={{ padding: 32, color: '#666' }}>No flavors in this selection.</div>;

  const grouped = splitByCategory ? groupByCategory(rows) : null;

  return (
    <div style={{ padding: '24px 20px', maxWidth: 960, margin: '0 auto', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ borderBottom: '3px solid #b5121b', marginBottom: 18, paddingBottom: 10 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, color: '#b5121b', margin: 0 }}>
          Food Allergies &amp; Sensitivities
        </h1>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>Cold Stone Creamery reference sheet</div>
      </div>

      {grouped
        ? grouped.map(([cat, catRows]) => (
            <div key={cat} style={{ marginBottom: 20 }}>
              <div style={{
                background: '#b5121b', color: '#fff', fontWeight: 900, fontSize: 13,
                padding: '5px 10px', borderRadius: 6, marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                {cat}
              </div>
              <AllergenTable rows={catRows} />
            </div>
          ))
        : <AllergenTable rows={rows} />
      }

      <div style={{ marginTop: 20, fontSize: 11, color: '#888', borderTop: '1px solid #eee', paddingTop: 12 }}>
        Source: Cold Stone Creamery® Food Allergies and Sensitivities chart. Items may involve cross-contact; verify with store staff.
      </div>
    </div>
  );
}
