'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ALLERGENS = ['Egg', 'Milk', 'Peanuts', 'Sesame', 'Soy', 'Tree Nuts', 'Wheat'] as const;

type Allergen = (typeof ALLERGENS)[number];

type AllergenValue = 'Yes' | 'No' | 'Unknown';

type FlavorRecord = {
  flavor: string;
  allergens: Record<Allergen, AllergenValue>;
  source: 'master' | 'manual';
};

const STORAGE_SELECTED = 'fac_selected_flavors_v1';
const STORAGE_MANUAL = 'fac_manual_flavors_v1';

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

export default function HomePage() {
  const [search, setSearch] = useState('');
  const [masterRows, setMasterRows] = useState<Array<Omit<FlavorRecord, 'source'>>>([]);
  const [manualRows, setManualRows] = useState<FlavorRecord[]>(() => {
    if (typeof window === 'undefined') return [];
    const manual =
      safeParseJson<Array<{ flavor: string; allergens: Record<string, AllergenValue> }>>(
        localStorage.getItem(STORAGE_MANUAL),
      ) ?? [];

    const manualClean: FlavorRecord[] = manual
      .map((m) => {
        const flavor = (m.flavor ?? '').trim();
        if (!flavor) return null;
        const allergens = Object.fromEntries(
          ALLERGENS.map((a) => [a, (m.allergens?.[a] ?? 'Unknown') as AllergenValue]),
        ) as Record<Allergen, AllergenValue>;
        return { flavor, allergens, source: 'manual' };
      })
      .filter(Boolean) as FlavorRecord[];

    return manualClean.sort((a, b) => a.flavor.localeCompare(b.flavor));
  });

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    const selectedArr = safeParseJson<string[]>(localStorage.getItem(STORAGE_SELECTED)) ?? [];
    return new Set(selectedArr);
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

          return { flavor: r.flavor, allergens };
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
    const toStore = manualRows.map(({ flavor, allergens }) => ({ flavor, allergens }));
    localStorage.setItem(STORAGE_MANUAL, JSON.stringify(toStore));
  }, [manualRows]);

  const allRows: FlavorRecord[] = useMemo(() => {
    const masters: FlavorRecord[] = masterRows.map((r) => ({ ...r, source: 'master' }));
    return [...manualRows, ...masters].sort((a, b) => a.flavor.localeCompare(b.flavor));
  }, [masterRows, manualRows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => r.flavor.toLowerCase().includes(q));
  }, [allRows, search]);

  const selectedRows = useMemo(() => {
    const sel = selected;
    const rows = allRows.filter((r) => sel.has(r.flavor));
    return rows.sort((a, b) => a.flavor.localeCompare(b.flavor));
  }, [allRows, selected]);

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
    const body = selectedRows.map((r) => [
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
                {selectedRows.length === 0 ? (
                  <tr>
                    <td colSpan={1 + ALLERGENS.length} className="empty">
                      Select flavors on the left (or add one manually) to preview.
                    </td>
                  </tr>
                ) : (
                  selectedRows.map((r) => (
                    <tr key={`${r.source}:${r.flavor}`}>
                      <td className="flavorCell">{r.flavor}</td>
                      {ALLERGENS.map((a) => (
                        <td key={a} className={`cell v-${(r.allergens[a] ?? 'Unknown').toLowerCase()}`}>
                          {r.allergens[a] ?? 'Unknown'}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
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
            <input value={name} onChange={(e) => setName(e.target.value)} />
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
              onAdd({ flavor: name.trim(), allergens });
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
