# Food Allergy Chart (MVP)

Desktop-first web app to select ice cream flavors and export a clean allergen chart.

## Requirements covered (MVP)
- Desktop-first split layout: search + checkbox list (left) + preview table (right)
- Export:
  - **Download PDF** (jsPDF + autoTable)
  - **Print** fallback (window.print + print CSS)
- Output content:
  - Title: **Food Allergies and Sensitivities**
  - Header: **Printed: <date/time>**
  - Table: rows = flavors, columns = Egg/Milk/Peanuts/Sesame/Soy/Tree Nuts/Wheat
  - Cells: Yes / No / Unknown
- Sorting: alphabetical by flavor name
- Missing flavors reminder before Print/PDF: **“Do you see every flavor you carry?”**
- Manual add flavor (defaults to Unknown per allergen)
- Remember last selection + manual flavors in localStorage

## Data
- Master CSV lives at `data/master.csv`.
- The UI loads it via `GET /api/flavors`.

## Dev

```bash
cd /home/kyle/projects/apps/food-allergy-chart
npm install
npm run dev
# http://localhost:3000
```

## Build

```bash
npm run lint
npm run build
```

## Notes
- Print styling is portrait letter via `@page { size: letter portrait; }`.
- PDF export uses **letter portrait**.
