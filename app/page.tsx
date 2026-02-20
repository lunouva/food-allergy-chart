'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ALLERGENS = ['Egg', 'Milk', 'Peanuts', 'Sesame', 'Soy', 'Tree Nuts', 'Wheat'] as const;

const SOURCE_TITLE = 'Cold Stone Creamery® — Food Allergies and Sensitivities';
const SOURCE_URL = 'https://www.coldstonecreamery.com/nutrition/index.html';
const SOURCE_PDF_URL =
  'https://www.coldstonecreamery.com/nutrition/pdf/CSC_Food%20Allergies%20and%20Sensitivities.pdf';

type Allergen = (typeof ALLERGENS)[number];

type AllergenValue = 'Yes' | 'No' | 'Unknown';

type Category = 'Ice Cream' | 'Mix-In' | 'Cake' | 'Cone/Bowl' | 'Other';

type FlavorRecord = {
  flavor: string;
  category: Category;
  allergens: Record<Allergen, AllergenValue>;
  source: 'master' | 'manual';
};

const STORAGE_SELECTED = 'fac_selected_flavors_v1';
const STORAGE_MANUAL = 'fac_manual_flavors_v2';
const STORAGE_UI = 'fac_ui_v1';

function nowLabel(d = new Date()) {
  // Local, readable timestamp
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeValue(v: string): AllergenValue {
  const t = (v ?? '').trim().toLowerCase();
  if (t === 'yes') return 'Yes';
  if (t === 'no') return 'No';
  return 'Unknown';
}

function safeParseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function confirmIfMissing(selectedCount: number, totalCount: number) {
  if (totalCount <= 0) return true;
  if (selectedCount >= totalCount) return true;
  // Requirement wording: simple pop-up before Print/PDF.
  return window.confirm('Do you see every flavor you carry?');
}

function inferCategory(name: string): Category {
  const t = (name ?? '').toLowerCase();

  // Broad heuristics: the main goal is "Ice Cream" vs "Mix-In" separation.
  if (t.includes('ice cream') || t.includes('sorbet') || t.includes('frozen dessert')) return 'Ice Cream';

  if (
    t.includes('cake') ||
    t.includes('brownie') ||
    t.includes('cupcake') ||
    t.includes('muffin') ||
    t.includes('pie')
  ) {
    return 'Cake';
  }

  if (t.includes('cone') || t.includes('waffle') || t.includes('bowl')) return 'Cone/Bowl';

  // Many non-ice-cream items here are mix-ins, toppings, or inclusions.
  if (
    t.includes('cookies') ||
    t.includes('cookie') ||
    t.includes('sprinkles') ||
    t.includes('chips') ||
    t.includes('nuts') ||
    t.includes('almonds') ||
    t.includes('walnuts') ||
    t.includes('pecans') ||
    t.includes('cashews') ||
    t.includes('pistach') ||
    t.includes('peanuts') ||
    t.includes('m&m') ||
    t.includes('oreo') ||
    t.includes('fudge') ||
    t.includes('ganache') ||
    t.includes('caramel') ||
    t.includes('marshmallow') ||
    t.includes('whipped') ||
    t.includes('topping')
  ) {
    return 'Mix-In';
  }

  // Default: Mix-In (to keep ice cream separate).
  return 'Mix-In';
}

function safeCategory(v: unknown): Category {
  if (v === 'Ice Cream' || v === 'Mix-In' || v === 'Cake' || v === 'Cone/Bowl' || v === 'Other') return v;
  return 'Mix-In';
}

function groupByCategory(rows: FlavorRecord[]): Record<Category, FlavorRecord[]> {
  const out: Record<Category, FlavorRecord[]> = {
    'Ice Cream': [],
    'Mix-In': [],
    Cake: [],
    'Cone/Bowl': [],
    Other: [],
  };
  for (const r of rows) out[r.category]?.push(r);
  for (const k of Object.keys(out) as Category[]) {
    out[k] = out[k].sort((a, b) => a.flavor.localeCompare(b.flavor));
  }
  return out;
}

export default function HomePage() {
  const [search, setSearch] = useState('');
  const [masterRows, setMasterRows] = useState<Array<Omit<FlavorRecord, 'source'>>>([]);
  const [manualRows, setManualRows] = useState<FlavorRecord[]>(() => {
    if (typeof window === 'undefined') return [];
    const manual =
      safeParseJson<Array<{ flavor: string; category?: Category; allergens: Record<string, AllergenValue> }>>(
        localStorage.getItem(STORAGE_MANUAL),
      ) ?? [];

    const manualClean: FlavorRecord[] = manual
      .map((m) => {
        const flavor = (m.flavor ?? '').trim();
        if (!flavor) return null;
        const allergens = Object.fromEntries(
          ALLERGENS.map((a) => [a, (m.allergens?.[a] ?? 'Unknown') as AllergenValue]),
        ) as Record<Allergen, AllergenValue>;
        const category = safeCategory(m.category ?? inferCategory(flavor));
        return { flavor, category, allergens, source: 'manual' };
      })
      .filter(Boolean) as FlavorRecord[];

    return manualClean.sort((a, b) => a.flavor.localeCompare(b.flavor));
  });

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    const selectedArr = safeParseJson<string[]>(localStorage.getItem(STORAGE_SELECTED)) ?? [];
    return new Set(selectedArr);
  });

  const [ui, setUi] = useState<{ splitByCategory: boolean; activeCategories: Category[] }>(() => {
    if (typeof window === 'undefined') return { splitByCategory: true, activeCategories: [] };
    const saved = safeParseJson<{ splitByCategory?: boolean; activeCategories?: unknown }>(
      localStorage.getItem(STORAGE_UI),
    );
    return {
      splitByCategory: saved?.splitByCategory ?? true,
      activeCategories: Array.isArray(saved?.activeCategories)
        ? (saved?.activeCategories.map(safeCategory) as Category[])
        : [],
    };
  });

  const [printedAt, setPrintedAt] = useState(() => nowLabel());
  const [isModalOpen, setIsModalOpen] = useState(false);

  const printAreaRef = useRef<HTMLDivElement | null>(null);

  // Load master data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/flavors');
      const json = (await res.json()) as {
        rows: Array<{ flavor: string; allergens: Record<string, string> }>;
      };

      const rows = json.rows
        .map((r) => {
          const allergens = Object.fromEntries(
            ALLERGENS.map((a) => [a, normalizeValue(r.allergens?.[a] ?? 'Unknown')]),
          ) as Record<Allergen, AllergenValue>;

          const flavor = r.flavor;
          const category = inferCategory(flavor);
          return { flavor, category, allergens };
        })
        .sort((a, b) => a.flavor.localeCompare(b.flavor));

      if (!cancelled) setMasterRows(rows);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // localStorage is loaded via the useState() initializers above.

  // Persist localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_SELECTED, JSON.stringify(Array.from(selected).sort()));
  }, [selected]);

  useEffect(() => {
    const toStore = manualRows.map(({ flavor, category, allergens }) => ({ flavor, category, allergens }));
    localStorage.setItem(STORAGE_MANUAL, JSON.stringify(toStore));
  }, [manualRows]);

  useEffect(() => {
    localStorage.setItem(STORAGE_UI, JSON.stringify(ui));
  }, [ui]);

  const allRows: FlavorRecord[] = useMemo(() => {
    const masters: FlavorRecord[] = masterRows.map((r) => ({ ...r, source: 'master' }));
    return [...manualRows, ...masters].sort((a, b) => a.flavor.localeCompare(b.flavor));
  }, [masterRows, manualRows]);

  const categories: Category[] = useMemo(() => {
    const set = new Set<Category>();
    for (const r of allRows) set.add(r.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allRows]);

  const activeCategorySet = useMemo(() => {
    const arr = ui.activeCategories.length ? ui.activeCategories : categories;
    return new Set(arr);
  }, [ui.activeCategories, categories]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (!activeCategorySet.has(r.category)) return false;
      if (!q) return true;
      return r.flavor.toLowerCase().includes(q);
    });
  }, [allRows, search, activeCategorySet]);

  const selectedRows = useMemo(() => {
    const sel = selected;
    const rows = allRows.filter((r) => sel.has(r.flavor));
    return rows.sort((a, b) => a.flavor.localeCompare(b.flavor));
  }, [allRows, selected]);

  const outputRows = useMemo(() => {
    // What will print / export.
    return selectedRows.filter((r) => activeCategorySet.has(r.category));
  }, [selectedRows, activeCategorySet]);

  const masterFlavorCount = masterRows.length;

  function toggleFlavor(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function selectAllMaster() {
    setSelected(new Set(masterRows.map((r) => r.flavor)));
  }

  function onPrint() {
    setPrintedAt(nowLabel());
    if (!confirmIfMissing(selectedRows.length, masterFlavorCount)) return;
    window.print();
  }

  function onDownloadPdf() {
    setPrintedAt(nowLabel());
    if (!confirmIfMissing(selectedRows.length, masterFlavorCount)) return;

    const printed = nowLabel();

    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const title = 'Food Allergies and Sensitivities';

    doc.setFontSize(16);
    doc.text(title, 40, 40);

    doc.setFontSize(10);
    doc.text(`Printed: ${printed}`, 40, 58);

    const head = [['Flavor', ...ALLERGENS]];

    const rowsByCategory = ui.splitByCategory ? groupByCategory(outputRows) : null;

    if (rowsByCategory) {
      let first = true;
      for (const cat of Object.keys(rowsByCategory) as Category[]) {
        const catRows = rowsByCategory[cat];
        if (!catRows.length) continue;
        if (!first) doc.addPage();
        first = false;

        doc.setFontSize(12);
        doc.text(cat, 40, 78);

        const body = catRows.map((r) => [
          r.flavor,
          ...ALLERGENS.map((a) => r.allergens[a] ?? 'Unknown'),
        ]);

        autoTable(doc, {
          startY: 90,
          head,
          body,
          styles: { fontSize: 9, cellPadding: 4, overflow: 'linebreak' },
          headStyles: { fillColor: [33, 33, 33] },
          columnStyles: {
            0: { cellWidth: 200 },
          },
        });

        doc.setFontSize(9);
        doc.text(`Source: ${SOURCE_TITLE}`, 40, 740);
        doc.text(SOURCE_PDF_URL, 40, 754);
      }
    } else {
      const body = outputRows.map((r) => [
        r.flavor,
        ...ALLERGENS.map((a) => r.allergens[a] ?? 'Unknown'),
      ]);

      autoTable(doc, {
        startY: 76,
        head,
        body,
        styles: { fontSize: 9, cellPadding: 4, overflow: 'linebreak' },
        headStyles: { fillColor: [33, 33, 33] },
        columnStyles: {
          0: { cellWidth: 200 },
        },
      });

      doc.setFontSize(9);
      doc.text(`Source: ${SOURCE_TITLE}`, 40, 740);
      doc.text(SOURCE_PDF_URL, 40, 754);
    }

    doc.save(`food-allergy-chart-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  function addManualFlavor(rec: Omit<FlavorRecord, 'source'>) {
    const flavor = rec.flavor.trim();
    if (!flavor) return;

    setManualRows((prev) => {
      // Replace if same name already exists in manual
      const without = prev.filter((p) => p.flavor !== flavor);
      const next = [...without, { ...rec, flavor, source: 'manual' as const }].sort((a, b) =>
        a.flavor.localeCompare(b.flavor),
      );
      return next;
    });

    setSelected((prev) => new Set([...prev, flavor]));
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Food Allergies and Sensitivities</h1>
          <div className="printed">Printed: {printedAt}</div>
        </div>
        <div className="actions no-print">
          <button className="secondary" onClick={() => setIsModalOpen(true)}>
            Add flavor
          </button>
          <button className="secondary" onClick={clearSelection}>
            Clear
          </button>
          <button className="secondary" onClick={selectAllMaster}>
            Select all (master)
          </button>
          <button onClick={onDownloadPdf}>Download PDF</button>
          <button onClick={onPrint}>Print</button>
        </div>
      </header>

      <main className="split">
        <aside className="left no-print">
          <div className="searchRow">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search flavors..."
              aria-label="Search flavors"
            />
            <div className="meta">{filteredRows.length} shown</div>
          </div>

          <div className="filters">
            <div className="filterRow">
              <div className="filterLabel">Print / export categories</div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={ui.splitByCategory}
                  onChange={(e) => setUi((p) => ({ ...p, splitByCategory: e.target.checked }))}
                />
                <span>Split by category</span>
              </label>
            </div>

            <div className="chips" role="group" aria-label="Category filters">
              {categories.map((c) => {
                const on = activeCategorySet.has(c);
                return (
                  <button
                    key={c}
                    type="button"
                    className={on ? 'chip chipOn' : 'chip'}
                    onClick={() => {
                      setUi((prev) => {
                        const current = new Set(
                          (prev.activeCategories.length ? prev.activeCategories : categories) as Category[],
                        );
                        if (current.has(c)) current.delete(c);
                        else current.add(c);
                        return { ...prev, activeCategories: Array.from(current) };
                      });
                    }}
                  >
                    {c}
                  </button>
                );
              })}
              <button
                type="button"
                className="chip"
                onClick={() => setUi((p) => ({ ...p, activeCategories: [] }))}
                title="Reset to all"
              >
                All
              </button>
            </div>

            <div className="sourceBox">
              <div className="sourceTitle">Source</div>
              <a href={SOURCE_PDF_URL} target="_blank" rel="noreferrer">
                {SOURCE_TITLE} (PDF)
              </a>
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                Nutrition page
              </a>
            </div>
          </div>

          <div className="list" role="list">
            {filteredRows.map((r) => (
              <label key={`${r.source}:${r.flavor}`} className="row" role="listitem">
                <input
                  type="checkbox"
                  checked={selected.has(r.flavor)}
                  onChange={() => toggleFlavor(r.flavor)}
                />
                <span className="flavorName">{r.flavor}</span>
                {r.source === 'manual' && <span className="badge">Manual</span>}
              </label>
            ))}
          </div>

          <div className="hint">
            Tip: selections and manual additions are saved in this browser (localStorage).
          </div>
        </aside>

        <section className="right" ref={printAreaRef}>
          <div className="tableWrap">
            {outputRows.length === 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th className="colFlavor">Flavor</th>
                    {ALLERGENS.map((a) => (
                      <th key={a}>{a}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={1 + ALLERGENS.length} className="empty">
                      Select flavors on the left (or add one manually) to preview.
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : ui.splitByCategory ? (
              (Object.entries(groupByCategory(outputRows)) as Array<[Category, FlavorRecord[]]>).map(
                ([cat, rows]) =>
                  rows.length ? (
                    <div key={cat} className="printSection">
                      <div className="sectionTitle">{cat}</div>
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="colFlavor">Flavor</th>
                            {ALLERGENS.map((a) => (
                              <th key={a}>{a}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={`${r.source}:${r.flavor}`}>
                              <td className="flavorCell">{r.flavor}</td>
                              {ALLERGENS.map((a) => (
                                <td
                                  key={a}
                                  className={`cell v-${(r.allergens[a] ?? 'Unknown').toLowerCase()}`}
                                >
                                  {r.allergens[a] ?? 'Unknown'}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null,
              )
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th className="colFlavor">Flavor</th>
                    {ALLERGENS.map((a) => (
                      <th key={a}>{a}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {outputRows.map((r) => (
                    <tr key={`${r.source}:${r.flavor}`}>
                      <td className="flavorCell">{r.flavor}</td>
                      {ALLERGENS.map((a) => (
                        <td key={a} className={`cell v-${(r.allergens[a] ?? 'Unknown').toLowerCase()}`}>
                          {r.allergens[a] ?? 'Unknown'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="printFooter">
              <div>
                Source: <span className="mono">{SOURCE_PDF_URL}</span>
              </div>
              <div className="disclaimer">
                Note: Provided for reference; ingredients and cross-contact risk can change. Verify with
                Cold Stone and local store practices.
              </div>
            </div>
          </div>
        </section>
      </main>

      {isModalOpen && (
        <AddFlavorModal
          onClose={() => setIsModalOpen(false)}
          onAdd={(rec) => {
            addManualFlavor(rec);
            setIsModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AddFlavorModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (rec: Omit<FlavorRecord, 'source'>) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('Mix-In');
  const [allergens, setAllergens] = useState<Record<Allergen, AllergenValue>>(() =>
    Object.fromEntries(ALLERGENS.map((a) => [a, 'Unknown'])) as Record<Allergen, AllergenValue>,
  );

  function setAllergen(a: Allergen, v: AllergenValue) {
    setAllergens((prev) => ({ ...prev, [a]: v }));
  }

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHeader">
          <div className="modalTitle">Add flavor</div>
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modalBody">
          <label className="field">
            <div className="label">Flavor name</div>
            <input
              value={name}
              onChange={(e) => {
                const v = e.target.value;
                setName(v);
                if (v.trim()) setCategory(inferCategory(v.trim()));
              }}
            />
          </label>

          <label className="field" style={{ marginTop: 10 }}>
            <div className="label">Category</div>
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              <option value="Ice Cream">Ice Cream</option>
              <option value="Mix-In">Mix-In</option>
              <option value="Cake">Cake</option>
              <option value="Cone/Bowl">Cone/Bowl</option>
              <option value="Other">Other</option>
            </select>
          </label>

          <div className="grid">
            {ALLERGENS.map((a) => (
              <label key={a} className="field">
                <div className="label">{a}</div>
                <select
                  value={allergens[a]}
                  onChange={(e) => setAllergen(a, e.target.value as AllergenValue)}
                >
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                  <option value="Unknown">Unknown</option>
                </select>
              </label>
            ))}
          </div>
        </div>

        <div className="modalFooter">
          <button
            onClick={() => {
              if (!name.trim()) {
                window.alert('Please enter a flavor name.');
                return;
              }
              onAdd({ flavor: name.trim(), category, allergens });
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
