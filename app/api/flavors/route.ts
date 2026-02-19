import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const ALLERGENS = ['Egg', 'Milk', 'Peanuts', 'Sesame', 'Soy', 'Tree Nuts', 'Wheat'] as const;

function parseCsvLine(line: string): string[] {
  // Minimal CSV parsing with quote support.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out.map((s) => s.trim());
}

export async function GET() {
  const filePath = path.join(process.cwd(), 'data', 'master.csv');
  const csv = await fs.readFile(filePath, 'utf8');

  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const header = parseCsvLine(lines[0]);
  const idxFlavor = header.findIndex((h) => h.toLowerCase() === 'flavor');
  const allergenIdx = Object.fromEntries(
    ALLERGENS.map((a) => [a, header.findIndex((h) => h.toLowerCase() === a.toLowerCase())]),
  ) as Record<(typeof ALLERGENS)[number], number>;

  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const flavor = (cols[idxFlavor] ?? '').trim();
    const allergens = Object.fromEntries(
      ALLERGENS.map((a) => {
        const i = allergenIdx[a];
        return [a, (i >= 0 ? cols[i] : '') ?? ''];
      }),
    );
    return { flavor, allergens };
  });

  return NextResponse.json({ rows });
}
