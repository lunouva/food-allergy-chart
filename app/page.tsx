'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';

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

function toBase64Url(s: string) {
  // Must be UTF-8 safe (flavor names include ™ and other non-Latin1 chars).
  const b64 =
    typeof window === 'undefined'
      ? Buffer.from(s, 'utf8').toString('base64')
      : (() => {
          const bytes = new TextEncoder().encode(s);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          return btoa(bin);
        })();

  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const full = b64 + pad;

  if (typeof window === 'undefined') return Buffer.from(full, 'base64').toString('utf8');

  const bin = atob(full);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

type SharePayloadV1 = {
  v?: number;
  selected?: unknown;
  ui?: unknown;
};

function makeShareUrl(payload: SharePayloadV1) {
  if (typeof window === 'undefined') return '';
  const base = window.location.origin + window.location.pathname;
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${base}?s=${encoded}`;
}

function readSharePayload(): { payload: SharePayloadV1 | null; error?: string } {
  if (typeof window === 'undefined') return { payload: null };
  const params = new URLSearchParams(window.location.search);
  const s = params.get('s');
  if (!s) return { payload: null };

  // Base64url should only include A-Z a-z 0-9 - _
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return { payload: null, error: 'Invalid share link (bad characters).' };

  try {
    const decoded = fromBase64Url(s);
    const payload = safeParseJson(decoded);
    if (!payload) return { payload: null, error: 'Invalid share link (could not parse).' };
    return { payload };
  } catch {
    return { payload: null, error: 'Invalid share link (could not decode).' };
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
  const [masterStatus, setMasterStatus] = useState<'loading' | 'ready' | 'error'>('loading');
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

  const [ui, setUi] = useState<{
    splitByCategory: boolean;
    activeCategories: Category[];
    qrPrintHeadline: string;
    qrPrintSupport: string;
  }>(() => {
    const defaults = {
      splitByCategory: true,
      activeCategories: [] as Category[],
      qrPrintHeadline: 'Food allergies',
      qrPrintSupport: 'Show this chart on your phone',
    };

    if (typeof window === 'undefined') return defaults;

    const saved = safeParseJson<{
      splitByCategory?: boolean;
      activeCategories?: unknown;
      qrPrintHeadline?: unknown;
      qrPrintSupport?: unknown;
    }>(localStorage.getItem(STORAGE_UI));

    return {
      splitByCategory: saved?.splitByCategory ?? defaults.splitByCategory,
      activeCategories: Array.isArray(saved?.activeCategories)
        ? (saved?.activeCategories.map(safeCategory) as Category[])
        : defaults.activeCategories,
      qrPrintHeadline:
        typeof saved?.qrPrintHeadline === 'string' ? saved.qrPrintHeadline : defaults.qrPrintHeadline,
      qrPrintSupport:
        typeof saved?.qrPrintSupport === 'string' ? saved.qrPrintSupport : defaults.qrPrintSupport,
    };
  });

  const [printedAt, setPrintedAt] = useState(() => nowLabel());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrHint, setQrHint] = useState<string>('');
  const [shareLoadError, setShareLoadError] = useState<string>('');
  const [copyHint, setCopyHint] = useState<string>('');
  const [printMode, setPrintMode] = useState<'full' | 'qr'>('full');

  const printAreaRef = useRef<HTMLDivElement | null>(null);

  // Load master data
  useEffect(() => {
    let cancelled = false;
    setMasterStatus('loading');

    (async () => {
      try {
        const res = await fetch('/api/flavors');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

        if (!cancelled) {
          setMasterRows(rows);
          setMasterStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setMasterRows([]);
          setMasterStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load shared selection from URL (?s=...)
  useEffect(() => {
    const { payload, error } = readSharePayload();
    if (error) setShareLoadError(error);
    if (!payload) return;

    try {
      if (Array.isArray(payload.selected)) {
        setSelected(new Set(payload.selected.map((x) => String(x))));
      }

      if (payload.ui && typeof payload.ui === 'object' && !Array.isArray(payload.ui)) {
        const u = payload.ui as Partial<{
          splitByCategory: unknown;
          activeCategories: unknown;
          qrPrintHeadline: unknown;
          qrPrintSupport: unknown;
        }>;

        setUi((prev) => ({
          ...prev,
          splitByCategory:
            typeof u.splitByCategory === 'boolean' ? u.splitByCategory : prev.splitByCategory,
          activeCategories: Array.isArray(u.activeCategories)
            ? (u.activeCategories.map(safeCategory) as Category[])
            : prev.activeCategories,
          qrPrintHeadline:
            typeof u.qrPrintHeadline === 'string' ? u.qrPrintHeadline : prev.qrPrintHeadline,
          qrPrintSupport:
            typeof u.qrPrintSupport === 'string' ? u.qrPrintSupport : prev.qrPrintSupport,
        }));
      }
    } catch {
      setShareLoadError('Invalid share link (could not apply selection).');
    }
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

  // Share URL + QR (auto updates as selection changes)
  useEffect(() => {
    const url = makeShareUrl({ v: 1, selected: Array.from(selected), ui });
    setShareUrl(url);

    // Keep QR reliably scannable by enforcing a max URL length.
    const MAX_SHARE_URL_LENGTH = 1500;

    let cancelled = false;
    (async () => {
      if (!url) {
        setQrDataUrl('');
        setQrHint('');
        return;
      }

      if (url.length > MAX_SHARE_URL_LENGTH) {
        setQrDataUrl('');
        setQrHint('Too many items selected for a scannable QR. Reduce selection.');
        return;
      }

      try {
        const dataUrl = await QRCode.toDataURL(url, {
          margin: 1,
          width: 180,
          errorCorrectionLevel: 'M',
        });
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          setQrHint('');
        }
      } catch {
        if (!cancelled) {
          setQrDataUrl('');
          setQrHint('QR could not be generated for this selection.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, ui]);

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

  async function onCopyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyHint('Copied.');
    } catch {
      setCopyHint('Could not copy (browser blocked clipboard).');
    } finally {
      window.setTimeout(() => setCopyHint(''), 1500);
    }
  }

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

  function selectAllShown() {
    setSelected((prev) => new Set([...prev, ...filteredRows.map((r) => r.flavor)]));
  }

  function clearShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filteredRows) next.delete(r.flavor);
      return next;
    });
  }

  function selectAllMaster() {
    setSelected(new Set(masterRows.map((r) => r.flavor)));
  }

  useEffect(() => {
    function onAfter() {
      setPrintMode('full');
    }
    window.addEventListener('afterprint', onAfter);
    return () => window.removeEventListener('afterprint', onAfter);
  }, []);

  function onPrint() {
    setPrintedAt(nowLabel());
    setPrintMode('full');
    if (!confirmIfMissing(selectedRows.length, masterFlavorCount)) return;
    window.print();
  }

  function onPrintQr() {
    setPrintedAt(nowLabel());
    setPrintMode('qr');
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

    // Add a final “QR + Disclosures” page (useful when sharing the PDF).
    doc.addPage();

    const pageW = doc.internal.pageSize.getWidth();

    doc.setFontSize(16);
    doc.text('QR + Disclosures', 40, 44);

    doc.setFontSize(10);
    doc.text(`Printed: ${printed}`, 40, 62);

    // QR card (headline/support first, then QR)
    const headline = (ui.qrPrintHeadline || 'Food allergies').trim() || 'Food allergies';
    const support = (ui.qrPrintSupport || 'Show this chart on your phone').trim() || 'Show this chart on your phone';
    const hint = (qrHint || 'Scan to open this exact selection.').trim();

    doc.setFontSize(13);
    doc.text(headline, 40, 92);

    doc.setFontSize(11);
    doc.text(doc.splitTextToSize(support, pageW - 80), 40, 110);

    if (qrDataUrl) {
      // Center the QR below the text.
      const qrSize = 180;
      const x = (pageW - qrSize) / 2;
      doc.addImage(qrDataUrl, 'PNG', x, 150, qrSize, qrSize);

      doc.setFontSize(9);
      doc.text(doc.splitTextToSize(hint, pageW - 80), 40, 350);
    }

    // Disclosures
    doc.setFontSize(12);
    doc.text('Disclosures (cross-contact / shared equipment)', 40, 400);

    doc.setFontSize(10);
    const disclosureLines = doc.splitTextToSize(
      [
        '• Many ingredients are handled in the same prep area. Even if an item does not list an allergen as an ingredient, cross-contact is possible.',
        '• Ask staff about store-specific practices (e.g., whether peanut butter or nut ingredients are used at the same mixing surface, scoop rinse station, blenders, or topping bins).',
        '• If you have a severe allergy, consider avoiding mix-ins and ask for fresh gloves/clean tools and a clean mixing surface.',
      ].join('\n'),
      pageW - 80,
    );
    doc.text(disclosureLines, 40, 420);

    doc.setFontSize(9);
    doc.text(`Source: ${SOURCE_TITLE}`, 40, 740);
    doc.text(SOURCE_PDF_URL, 40, 754);

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
          <div className="subtitle">Printable reference sheet (based on Cold Stone’s published chart)</div>
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
          <button className="secondary" onClick={onPrintQr}>Print QR</button>
          <button onClick={onPrint}>Print</button>
        </div>
      </header>

      <main className="split">
        <aside className="left no-print">
          <div className="searchRow">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search flavors…"
              aria-label="Search flavors"
            />
            <div className="meta">
              {filteredRows.length} shown
              <br />
              {selectedRows.length} selected
            </div>
          </div>

          <div className="actionsRow" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button className="secondary" type="button" onClick={selectAllShown} title="Select all currently shown">
              Select shown
            </button>
            <button className="secondary" type="button" onClick={clearShown} title="Clear selection for currently shown">
              Clear shown
            </button>
          </div>

          {shareLoadError ? <div className="banner">{shareLoadError}</div> : null}
          {masterStatus === 'loading' ? <div className="banner">Loading flavors…</div> : null}
          {masterStatus === 'error' ? (
            <div className="banner">
              Could not load the master flavor list. You can still add flavors manually.
            </div>
          ) : null}

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
                    aria-pressed={on}
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

            <div className="qrPrintBox">
              <div className="sourceTitle">Print QR card text</div>
              <div className="qrPrintFields">
                <label className="field">
                  <div className="label">Headline</div>
                  <input
                    value={ui.qrPrintHeadline}
                    onChange={(e) => setUi((p) => ({ ...p, qrPrintHeadline: e.target.value }))}
                    placeholder="Food allergies"
                  />
                </label>
                <label className="field">
                  <div className="label">Supporting text</div>
                  <textarea
                    value={ui.qrPrintSupport}
                    onChange={(e) => setUi((p) => ({ ...p, qrPrintSupport: e.target.value }))}
                    placeholder="Show this chart on your phone"
                    rows={2}
                  />
                </label>
              </div>
              <div className="qrPrintHint">Used in the “Print QR” output. Keep it short for the best print layout.</div>
            </div>

            <div className="sourceBox">
              <div className="sourceTitle">Source</div>
              <a href={SOURCE_PDF_URL} target="_blank" rel="noreferrer">
                {SOURCE_TITLE} (PDF)
              </a>
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">
                Nutrition page
              </a>

              <div className="sourceTitle" style={{ marginTop: 6 }}>
                Live QR
              </div>
              <div className="qrRow">
                {qrDataUrl ? (
                  <Image className="qr" src={qrDataUrl} alt="QR code" width={80} height={80} unoptimized />
                ) : null}
                <div className="qrMeta">
                  <div className="qrHint">{qrHint || 'Scan to view this exact selection on a phone.'}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button type="button" className="secondary" onClick={onCopyShareLink}>
                      Copy link
                    </button>
                    {copyHint ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{copyHint}</span> : null}
                  </div>

                  <details className="shareDetails">
                    <summary>Show share link</summary>
                    <a href={shareUrl} target="_blank" rel="noreferrer" className="qrLink">
                      {shareUrl}
                    </a>
                  </details>
                </div>
              </div>
            </div>
          </div>

          <div className="list" role="list">
            {filteredRows.length === 0 ? (
              <div className="empty">
                {search.trim() ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                    <div>No flavors match “{search.trim()}”.</div>
                    <button type="button" className="secondary" onClick={() => setSearch('')}>
                      Clear search
                    </button>
                  </div>
                ) : (
                  <div>No flavors to show.</div>
                )}
              </div>
            ) : (
              filteredRows.map((r) => (
                <label key={`${r.source}:${r.flavor}`} className="row" role="listitem">
                  <input
                    type="checkbox"
                    checked={selected.has(r.flavor)}
                    onChange={() => toggleFlavor(r.flavor)}
                  />
                  <span className="flavorName">{r.flavor}</span>
                  {r.source === 'manual' && <span className="badge">Manual</span>}
                </label>
              ))
            )}
          </div>

          <div className="hint">
            Tip: selections and manual additions are saved in this browser (localStorage).
          </div>
        </aside>

        <section className="right" ref={printAreaRef}>
          <div className={printMode === 'qr' ? 'printHeader hide' : 'printHeader'}>
            <div className="brandBar" />
            <div className="printHeaderInner">
              <div>
                <div className="printTitle">Food Allergies &amp; Sensitivities</div>
                <div className="printSub">Cold Stone Creamery (reference sheet) • Printed: {printedAt}</div>
              </div>

              <div className="printLegend" aria-label="Legend">
                <div className="legendTitle">Legend</div>
                <div className="legendItem" title="Contains allergen">
                  <span className="legendSwatch yes" aria-hidden="true" /> Y
                </div>
                <div className="legendItem" title="Does not contain allergen">
                  <span className="legendSwatch no" aria-hidden="true" /> N
                </div>
                <div className="legendItem" title="Unknown / not listed">
                  <span className="legendSwatch unknown" aria-hidden="true" /> ?
                </div>
              </div>
            </div>
          </div>

          <div className={printMode === 'qr' ? 'qrOnlyWrap' : 'qrOnlyWrap hide'}>
            <div className="brandBar" />
            <div className="qrOnlyCard">
              <div className="qrOnlyText">
                <div className="qrOnlyTitle">{ui.qrPrintHeadline || 'Food allergies'}</div>
                <div className="qrOnlySubTop" style={{ whiteSpace: 'pre-wrap' }}>
                  {ui.qrPrintSupport || 'Show this chart on your phone'}
                </div>
              </div>

              <div className="qrOnlyQr" aria-label="QR code">
                {qrDataUrl ? (
                  <Image className="qrBig" src={qrDataUrl} alt="QR code" width={110} height={110} unoptimized />
                ) : null}
              </div>

              <div className="qrOnlySub">{qrHint || 'Scan to open this exact selection.'}</div>
            </div>
          </div>

          <div className={printMode === 'qr' ? 'tableWrap hide' : 'tableWrap'}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
                        <div>Select flavors on the left (or add one manually) to preview.</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                          <button type="button" className="secondary" onClick={selectAllMaster}>
                            Select all (master)
                          </button>
                          <button type="button" className="secondary" onClick={() => setIsModalOpen(true)}>
                            Add a flavor
                          </button>
                        </div>
                      </div>
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
              {qrDataUrl ? (
                <div className="printQrCard" aria-label="QR code card">
                  <div className="printQrText">
                    <div className="printQrHeadline">{ui.qrPrintHeadline || 'Food allergies'}</div>
                    <div className="printQrSupport" style={{ whiteSpace: 'pre-wrap' }}>
                      {ui.qrPrintSupport || 'Show this chart on your phone'}
                    </div>
                    <div className="printQrHint">{qrHint || 'Scan to open this exact selection.'}</div>
                  </div>
                  <div className="printQrCode">
                    <Image
                      className="printQrImg"
                      src={qrDataUrl}
                      alt="QR code"
                      width={96}
                      height={96}
                      unoptimized
                    />
                  </div>
                </div>
              ) : null}

              <div>
                Source: <span className="mono">{SOURCE_PDF_URL}</span>
              </div>
              <div className="disclaimer">
                Note: Provided for reference; ingredients and cross-contact risk can change. Verify with Cold Stone
                and local store practices.
              </div>

              <div className="disclosures">
                <div className="disclosuresTitle">Disclosures (cross-contact / shared equipment)</div>
                <ul className="disclosuresList">
                  <li>
                    Many ingredients are handled in the same prep area. Even if an item does not list an allergen as an
                    ingredient, cross-contact is possible.
                  </li>
                  <li>
                    Ask staff about store-specific practices (e.g., whether peanut butter or nut ingredients are used at the
                    same mixing surface, scoop rinse station, blenders, or topping bins).
                  </li>
                  <li>
                    If you have a severe allergy, consider avoiding mix-ins and ask for fresh gloves/clean tools and a clean
                    mixing surface.
                  </li>
                </ul>
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Click outside the modal closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
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
              autoFocus
              placeholder="e.g., Birthday Cake Remix"
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
