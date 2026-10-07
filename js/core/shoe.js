// Shoe-shop helpers: size and colour presets, shoe categories, model grouping and variant naming.
// A shoe model (brand + style) is stored as one product per colour × size, so stock, ledger and
// receipts keep working per pair. Variants of the same model share the same `modelKey`.

export const SIZE_PRESETS = [
  { id: 'men', label: 'Men 38–45', sizes: '38,39,40,41,42,43,44,45' },
  { id: 'women', label: 'Women 36–41', sizes: '36,37,38,39,40,41' },
  { id: 'kids', label: 'Kids 24–36', sizes: '24,25,26,27,28,29,30,31,32,33,34,35,36' },
];

export const COLOR_PRESETS = ['Black', 'Brown', 'Tan', 'White', 'Navy', 'Grey', 'Maroon', 'Beige', 'Red', 'Green'];

// Seeded as categories on first use. Shop owners can rename or add more under Products → Categories.
export const SHOE_TYPES = ['Men', 'Women', 'Kids', 'Sports', 'Formal', 'Casual', 'Sandals & Chappal', 'Loafers', 'Boots'];

// Seeded as payment accounts on first use (Accounts page). Cash in Hand already exists.
export const PAYMENT_ACCOUNTS = [
  { name: 'JazzCash', type: 'bank' },
  { name: 'Easypaisa', type: 'bank' },
  { name: 'Bank Account', type: 'bank' },
];

// Accepts "38, 39 40" / Urdu comma (،) / new lines. Keeps order, removes duplicates.
export function splitList(s) {
  const out = [];
  for (const t of String(s || '').split(/[,،\n;]+|\s{2,}/)) {
    const v = t.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

// Sort numeric sizes numerically and keep letter sizes (S, M, L…) after them.
export function sortSizes(list) {
  return [...list].sort((a, b) => {
    const na = parseFloat(a); const nb = parseFloat(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    if (!Number.isNaN(na)) return -1;
    if (!Number.isNaN(nb)) return 1;
    return String(a).localeCompare(String(b));
  });
}

export const modelKeyOf = (brand, model) => {
  const b = String(brand || '').trim().toLowerCase();
  const m = String(model || '').trim().toLowerCase();
  return b || m ? `${b}|${m}` : '';
};

// Human name for one pair, e.g. "Bata Derby · Black · 42".
export function variantName({ brand, model, color, size }) {
  return [[brand, model].filter(Boolean).join(' '), color, size].filter(Boolean).join(' · ');
}

export const hasModel = (p) => !!p?.modelKey;
