// Fast POS screen used for both sales (#/pos) and purchases (#/purchase/new). Edit: #/pos/edit/:id, #/purchase/edit/:id
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, uuid, round2, round3, num, debounce, today, AppError } from '../core/utils.js';
import { getSettings, pref } from '../core/settings.js';
import { storageKey } from '../config.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';
import * as Scanner from '../scanner/scanner.js';
import { partyPicker } from './parties.js';
import { sortSizes } from '../core/shoe.js';

const $ = window.jQuery;
let st; let $root; let detachWedge = null; let payAccounts = [];

const isSale = () => st.mode === 'sale';
const draftKey = () => storageKey('draft.' + st.mode);
const cur = () => getSettings().currency;

function fresh(mode) {
  return { mode, id: uuid(), editId: null, date: today(), partyId: null, partyName: '', lines: [], discount: 0, note: '', refNo: '', tendered: null, priceMode: pref.get('priceMode', 'retail') };
}
function persist() { if (!st.editId) localStorage.setItem(draftKey(), JSON.stringify(st)); }
function taxRate() {
  if (!isSale()) return 0;
  if (st.editId) return st.taxRate || 0;
  const s = getSettings(); return s.taxEnabled ? num(s.taxRate) : 0;
}
function totals() {
  return Posting.previewDoc(st.lines, st.discount, taxRate()) || { subtotal: 0, discount: 0, tax: 0, total: 0, qtyTotal: 0, lines: [] };
}

// ---------- rendering ----------
function layout() {
  const sale = isSale();
  return `<div class="pos">
    <div class="pos-left">
      <div class="d-flex gap-2 mb-2">
        <input type="search" class="form-control browse-q" placeholder="Filter shoes…" autocomplete="off">
        <button class="btn btn-light d-lg-none btn-close-browse" aria-label="Close"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="chips mb-2 cat-chips"></div>
      <div class="product-grid"></div>
    </div>
    <div class="pos-right">
      <div class="pos-search">
        <div class="input-group input-group-lg">
          <span class="input-group-text bg-body"><i class="bi bi-search"></i></span>
          <input type="search" class="form-control pos-q" placeholder="Search brand, model, size or scan barcode" autocomplete="off" enterkeyhint="search" aria-label="Search product">
          <button class="btn btn-outline-secondary btn-scan" title="Scan with camera" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button>
          <button class="btn btn-outline-secondary btn-browse d-lg-none" title="Browse products" aria-label="Browse"><i class="bi bi-grid-3x3-gap"></i></button>
        </div>
        <div class="search-results d-none"></div>
      </div>
      <div class="pos-meta">
        <button class="btn btn-light btn-party text-truncate"><i class="bi bi-person me-1"></i><span class="party-name"></span></button>
        ${sale ? `<button class="btn btn-light flex-grow-0 btn-holds" title="Held sales"><i class="bi bi-pause-circle"></i> <span class="badge text-bg-secondary holds-count"></span></button>` : ''}
        <div class="dropdown flex-grow-0">
          <button class="btn btn-light" data-bs-toggle="dropdown" aria-label="More options"><i class="bi bi-three-dots-vertical"></i></button>
          <ul class="dropdown-menu dropdown-menu-end">
            ${sale ? `<li><button class="dropdown-item btn-hold"><i class="bi bi-pause-circle me-2"></i>Hold this sale</button></li>
            <li><button class="dropdown-item btn-price-mode"><i class="bi bi-tags me-2"></i>Use <span class="pm-label"></span> prices</button></li>` : ''}
            <li><button class="dropdown-item btn-scan-cont"><i class="bi bi-upc-scan me-2"></i>Continuous scan</button></li>
            <li><button class="dropdown-item btn-quick-add"><i class="bi bi-plus-square me-2"></i>Add new shoe</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item text-danger btn-clear"><i class="bi bi-trash me-2"></i>${st.editId ? 'Cancel editing' : 'Clear cart'}</button></li>
          </ul>
        </div>
      </div>
      ${st.editId ? `<div class="alert alert-warning rounded-0 m-0 py-1 px-3 small"><i class="bi bi-pencil me-1"></i>Editing ${esc(st.editNumber)}</div>` : ''}
      <div class="pos-lines"></div>
      <div class="pos-footer">
        <div class="d-flex justify-content-between small text-body-secondary footer-sub"></div>
        <div class="d-flex align-items-center gap-2 mt-1">
          <div class="flex-grow-1"><div class="small text-body-secondary">Total</div><div class="total money"></div></div>
          <button class="btn btn-primary btn-pay"><i class="bi bi-${sale ? 'cash-coin' : 'bag-check'} me-1"></i>${sale ? 'Pay' : 'Save'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderLines() {
  const s = getSettings();
  const $l = $root.find('.pos-lines');
  if (!st.lines.length) {
    $l.html(UI.emptyState(isSale() ? 'Cart is empty. Search a shoe, scan a barcode or tap a model.' : 'No shoes yet. Search or scan the shoes you are buying.', 'cart'));
  } else {
    $l.html(st.lines.map((l, i) => {
      const p = Catalog.product(l.productId);
      const low = isSale() && !st.editId && p && p.trackStock !== false && !s.allowNegativeStock && l.qty > (p.stock || 0);
      const amt = round2(l.qty * l.rate - (l.discount || 0));
      return `<div class="cart-line" data-i="${i}">
        <div class="info btn-line" role="button" tabindex="0">
          <div class="name">${esc(l.name)}</div>
          <div class="meta">${fmtNum(l.rate)}${l.discount ? ` · disc ${fmtNum(l.discount)}` : ''}${p && p.trackStock !== false ? ` · <span class="${low ? 'text-danger fw-semibold' : ''}">stock ${fmtQty(p.stock)}</span>` : ''}</div>
        </div>
        <div class="qty-ctl"><button class="btn-dec" aria-label="Decrease">−</button><input class="qty-in" inputmode="decimal" value="${fmtQty(l.qty).replace(/,/g, '')}" aria-label="Quantity"><button class="btn-inc" aria-label="Increase">+</button></div>
        <div class="amt money">${fmtNum(amt)}</div>
      </div>`;
    }).join(''));
  }
  renderTotals();
}

function renderTotals() {
  const t = totals();
  $root.find('.total').text(`${cur()} ${fmtNum(t.total)}`);
  $root.find('.footer-sub').html(`<span>${st.lines.length} item(s) · qty ${fmtQty(t.qtyTotal)}</span><span>${t.discount ? `Disc ${fmtNum(t.discount)} · ` : ''}${t.tax ? `Tax ${fmtNum(t.tax)}` : ''}</span>`);
  $root.find('.btn-pay').prop('disabled', !st.lines.length);
  $root.find('.party-name').text(st.partyName || (isSale() ? 'Walk-in customer' : 'Select supplier / factory'));
  $root.find('.pm-label').text(st.priceMode === 'retail' ? 'wholesale' : 'retail');
  persist();
}

async function renderHoldCount() {
  if (!isSale()) return;
  const n = await idb.count('holds');
  $root.find('.holds-count').text(n || '');
}

// ---------- browse grid ----------
let browseCat = null;
// Browse grid: one tile per shoe model (shows all sizes/colours in a picker), one tile per single item.
function renderGrid() {
  const q = $root.find('.browse-q').val() || '';
  const list = Catalog.searchProducts(q, { limit: 600, categoryId: browseCat });
  const cats = Catalog.allCategories();
  $root.find('.cat-chips').html(`<span class="chip ${!browseCat ? 'active' : ''}" data-cat="">All</span>` + cats.map((c) => `<span class="chip ${browseCat === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">${esc(c.name)}</span>`).join(''));
  const tiles = groupByModel(list).slice(0, 120);
  $root.find('.product-grid').html(tiles.length ? tiles.map(modelTile).join('') : UI.emptyState('No shoes found', 'bag'));
}

// Keeps the search order; variants of the same model collapse into one tile.
function groupByModel(list) {
  const out = []; const byKey = new Map();
  for (const p of list) {
    if (!p.modelKey) { out.push({ single: p }); continue; }
    let g = byKey.get(p.modelKey);
    if (!g) { g = { key: p.modelKey, rep: p, variants: [] }; byKey.set(p.modelKey, g); out.push(g); }
    g.variants.push(p);
  }
  return out;
}

function modelTile(g) {
  if (g.single) {
    const p = g.single;
    return `<button class="product-tile" data-id="${esc(p.id)}">
      ${p.image ? `<img src="${p.image}" alt="" loading="lazy">` : `<div class="ph tint-${UI.tintFor(p.name)}">${esc(UI.initials(p.name))}</div>`}
      <div class="n">${esc(p.name)}</div>
      <div class="p">${fmtNum(priceOf(p))}</div>
      ${p.trackStock !== false ? `<div class="s">Stock: ${fmtQty(p.stock)}</div>` : ''}
    </button>`;
  }
  const r = g.rep; const active = g.variants.filter((v) => v.active);
  const stock = active.reduce((s, v) => s + (v.trackStock !== false ? Math.max(0, v.stock || 0) : 0), 0);
  const sizes = new Set(active.map((v) => v.size).filter(Boolean)).size;
  const title = [r.brand, r.model].filter(Boolean).join(' ') || r.name;
  return `<button class="product-tile model-tile" data-model="${esc(g.key)}">
      ${r.image ? `<img src="${r.image}" alt="" loading="lazy">` : `<div class="ph shoe-ph tint-${UI.tintFor(title)}"><i class="bi bi-bag-heart"></i><span>${esc(UI.initials(title))}</span></div>`}
      <div class="n">${esc(title)}</div>
      <div class="p">${fmtNum(priceOf(r))}</div>
      <div class="s">${sizes} size${sizes === 1 ? '' : 's'} · ${fmtQty(stock)} pr</div>
    </button>`;
}

// Picker: colours as rows, sizes as buttons with the pairs left in each. Tapping a size adds that pair.
function openModelPicker(key) {
  const variants = Catalog.allProducts().filter((p) => p.modelKey === key && p.active);
  if (!variants.length) return UI.toast('No sizes available for this model', 'warning');
  const colors = [...new Set(variants.map((v) => v.color || '—'))];
  const sizes = sortSizes([...new Set(variants.map((v) => v.size || '—'))]);
  const at = (c, s) => variants.find((v) => (v.color || '—') === c && (v.size || '—') === s);
  const head = variants[0];
  const title = [head.brand, head.model].filter(Boolean).join(' ') || head.name;
  const m = UI.modal({ title, size: 'lg',
    body: `<div class="model-picker">
      <div class="mp-hint small text-body-secondary mb-2">Tap a size to add one pair. The number under the size is the pairs in stock.</div>
      ${colors.map((c) => `<div class="mp-row">
        <div class="mp-color"><span class="mp-dot" style="background:${colorDot(c)}"></span>${esc(c)}</div>
        <div class="mp-sizes">${sizes.map((s) => {
          const v = at(c, s);
          if (!v) return '<span class="size-btn is-none" aria-hidden="true">·</span>';
          const out = v.trackStock !== false && (v.stock || 0) <= 0;
          const low = !out && v.trackStock !== false && (v.stock || 0) <= (v.minStock || 0);
          return `<button class="size-btn ${out ? 'is-out' : ''} ${low ? 'is-low' : ''}" data-id="${esc(v.id)}" aria-label="${esc(c)} size ${esc(s)}, ${fmtQty(v.stock)} in stock">
            <b>${esc(s)}</b><small>${v.trackStock === false ? '∞' : fmtQty(v.stock)}</small></button>`;
        }).join('')}</div>
      </div>`).join('')}
    </div>` });
  m.$el.on('click', '.size-btn[data-id]', function () {
    addProduct(Catalog.product(this.dataset.id));
    m.close();
  });
}

const COLOR_DOTS = { black: '#111827', brown: '#7c4a21', tan: '#c8a27a', white: '#f8fafc', navy: '#1e3a8a', grey: '#9ca3af', gray: '#9ca3af', maroon: '#7f1d1d', beige: '#e7d9bd', red: '#dc2626', green: '#15803d' };
const colorDot = (c) => COLOR_DOTS[String(c).toLowerCase()] || '#d6d3d1';

// Little shoe-stamp celebration after a completed sale or purchase.
function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'sale-stamp';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 200 120"><path class="s-sole" d="M14 92H186Q194 92 194 100V104Q194 112 186 112H14Q6 112 6 104V100Q6 92 14 92Z"/><path class="s-upper" d="M18 90V52Q18 34 36 32L60 30Q68 56 98 62L142 70Q178 76 188 88Z"/><path class="s-laces" d="M96 60l8-6M106 65l8-6M116 69l8-6"/></svg><span>Sold!</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

// ---------- cart operations ----------
function priceOf(p) {
  if (!isSale()) return p.purchasePrice || 0;
  return st.priceMode === 'wholesale' && p.wholesalePrice ? p.wholesalePrice : p.salePrice || 0;
}

function addProduct(p, qty = 1) {
  if (!p) return;
  if (!p.active) { UI.toast(`"${p.name}" is inactive`, 'warning'); return; }
  const i = st.lines.findIndex((l) => l.productId === p.id && !l.discount);
  if (i >= 0) {
    st.lines[i].qty = round3(st.lines[i].qty + qty);
    const [line] = st.lines.splice(i, 1); st.lines.unshift(line);
  } else {
    st.lines.unshift({ productId: p.id, name: p.name, unit: p.unit, qty, rate: priceOf(p), discount: 0 });
  }
  renderLines();
  $root.find('.cart-line').first().addClass('bg-success-subtle');
  setTimeout(() => $root.find('.cart-line').first().removeClass('bg-success-subtle'), 400);
  const s = getSettings();
  if (isSale() && !st.editId && p.trackStock !== false && !s.allowNegativeStock && st.lines[0].qty > (p.stock || 0)) UI.toast(`Only ${fmtQty(p.stock)} in stock for ${p.name}`, 'warning', 2500);
}

function addByCode(code) {
  const p = Catalog.findByCode(code);
  if (p) { UI.beep(); addProduct(p); return true; }
  UI.toast(`No product found for "${code}"`, 'warning');
  return false;
}

function hideResults() { $root.find('.search-results').addClass('d-none').empty(); }

let results = [];
const doSearch = debounce(() => {
  const q = $root.find('.pos-q').val().trim();
  if (!q) return hideResults();
  results = Catalog.searchProducts(q, { limit: 25 });
  $root.find('.search-results').removeClass('d-none').html(results.length ? results.map((p, i) => `
    <button class="list-row ${i === 0 ? 'bg-body-secondary' : ''}" data-i="${i}">
      <div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc([p.sku, p.barcode].filter(Boolean).join(' · '))}</div></div>
      <div class="end"><div class="fw-semibold money">${fmtNum(priceOf(p))}</div>${p.trackStock !== false ? `<div class="sub">stock ${fmtQty(p.stock)}</div>` : ''}</div>
    </button>`).join('') : `<div class="p-3 text-body-secondary small">No products match "${esc(q)}".${Auth.can('product.edit') ? ' <a href="#" class="quick-add-link">Add new product</a>' : ''}</div>`);
}, 120);

async function editLine(i) {
  const l = st.lines[i];
  const p = Catalog.product(l.productId);
  const r = await UI.formModal({
    title: l.name, submitLabel: 'Update',
    body: `<div class="row g-2">
      <div class="col-4"><label class="form-label">Quantity</label><input name="qty" class="form-control form-control-lg" inputmode="decimal" value="${l.qty}"></div>
      <div class="col-4"><label class="form-label">${isSale() ? 'Rate' : 'Cost rate'}</label><input name="rate" class="form-control form-control-lg" inputmode="decimal" value="${l.rate}"></div>
      <div class="col-4"><label class="form-label">Discount</label><input name="discount" class="form-control form-control-lg" inputmode="decimal" value="${l.discount || 0}"></div>
      ${p ? `<div class="col-12 small text-body-secondary">Sale ${fmtNum(p.salePrice)} · Wholesale ${fmtNum(p.wholesalePrice)} · Cost ${fmtNum(p.purchasePrice)}${p.trackStock !== false ? ` · Stock ${fmtQty(p.stock)}` : ''}</div>` : ''}
      <div class="col-12"><button type="button" class="btn btn-outline-danger w-100 btn-remove-line"><i class="bi bi-trash me-1"></i>Remove item</button></div></div>`,
    onShown: ($m) => { $m.find('[name=qty]').trigger('select'); $m.find('.btn-remove-line').on('click', () => { st.lines.splice(i, 1); renderLines(); $m.find('[data-bs-dismiss=modal]').first().trigger('click'); }); },
    onSubmit: (v) => {
      const qty = round3(num(v.qty)); const rate = round2(num(v.rate)); const discount = round2(num(v.discount));
      if (!(qty > 0)) throw new AppError('Quantity must be greater than zero.');
      if (rate < 0) throw new AppError('Rate cannot be negative.');
      if (discount < 0 || discount > qty * rate) throw new AppError('Discount must be between 0 and the line amount.');
      return { qty, rate, discount };
    },
  });
  if (r && st.lines[i] === l) { Object.assign(l, r); renderLines(); }
}

async function choosePartyFn() {
  const kind = isSale() ? 'customers' : 'suppliers';
  const p = await partyPicker(kind, { noneLabel: isSale() ? 'Walk-in customer' : 'No supplier (cash purchase)' });
  if (p === undefined) return;
  st.partyId = p?.id || null; st.partyName = p?.name || '';
  renderTotals();
}

async function loadPayAccounts() {
  payAccounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active).sort((a, b) => (a.id === 'cash' ? -1 : b.id === 'cash' ? 1 : a.name.localeCompare(b.name)));
}

// ---------- checkout ----------
async function checkout() {
  const t = Posting.previewDoc(st.lines, 0, 0);
  if (!t) { UI.toast('Please fix invalid quantities/rates in the cart.', 'warning'); return; }
  if (!st.lines.length) return;
  const sale = isSale();
  const s = getSettings();
  const canDate = Auth.can(sale ? 'sale.edit' : 'purchase.manage');
  const lastAcc = pref.get('payAccount', 'cash');
  const m = UI.modal({
    title: sale ? 'Payment' : 'Save purchase', static: true,
    body: `<form class="checkout" autocomplete="off">
      <div class="text-center mb-2"><div class="small text-body-secondary">Amount due</div><div class="checkout-total money co-total"></div></div>
      <button type="button" class="btn btn-light w-100 mb-3 text-start co-party"><i class="bi bi-person me-2"></i><span></span><i class="bi bi-chevron-right float-end"></i></button>
      <div class="row g-2 mb-2">
        <div class="col-6"><label class="form-label">Bill discount</label><div class="input-group"><input name="discount" class="form-control" inputmode="decimal" value="${st.discount || ''}" placeholder="0"><button type="button" class="btn btn-outline-secondary co-pct" title="Discount as percent">%</button></div></div>
        <div class="col-6"><label class="form-label">Pay via</label><select name="account" class="form-select">${UI.options(payAccounts, st.payAccount || lastAcc)}</select></div>
      </div>
      <div class="small text-body-secondary co-breakdown mb-2"></div>
      <label class="form-label">${sale ? 'Amount received' : 'Amount paid'}</label>
      <input name="tendered" class="form-control form-control-lg mb-2 money" inputmode="decimal" placeholder="0">
      <div class="d-flex flex-wrap gap-2 pay-quick mb-2"></div>
      <div class="alert py-2 mb-2 co-result"></div>
      ${!sale ? `<div class="mb-2"><label class="form-label">Supplier invoice no.</label><input name="refNo" class="form-control" value="${esc(st.refNo)}"></div>` : ''}
      <div class="row g-2">
        ${canDate ? `<div class="col-6"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${esc(st.date)}" max="${today()}"></div>` : ''}
        <div class="${canDate ? 'col-6' : 'col-12'}"><label class="form-label">Note</label><input name="note" class="form-control" value="${esc(st.note)}"></div>
      </div>
      ${sale ? `<div class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" id="co-print" ${s.printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="co-print">Print receipt</label></div>` : ''}
      <div class="alert alert-danger py-2 small d-none co-error mt-2 mb-0"></div>
    </form>`,
    footer: `<button class="btn btn-light" data-bs-dismiss="modal">Back</button><button class="btn btn-success btn-lg flex-grow-1 co-complete"><i class="bi bi-check2-circle me-1"></i>${sale ? 'Complete sale' : 'Save purchase'}</button>`,
  });
  const $m = m.$el;
  let tenderedTouched = st.tendered !== null && st.editId;
  const calc = () => Posting.previewDoc(st.lines, num($m.find('[name=discount]').val()), taxRate());
  const update = () => {
    const c = calc();
    $m.find('.co-party span').text(st.partyName || (sale ? 'Walk-in customer' : 'No supplier (cash purchase)'));
    if (!c) { $m.find('.co-total').text('—'); $m.find('.co-result').attr('class', 'alert alert-danger py-2 mb-2 co-result').text('Discount cannot exceed the subtotal.'); $m.find('.co-complete').prop('disabled', true); return; }
    $m.find('.co-total').text(`${cur()} ${fmtNum(c.total)}`);
    $m.find('.co-breakdown').text(`Subtotal ${fmtNum(c.subtotal)}${c.discount ? ` − discount ${fmtNum(c.discount)}` : ''}${c.tax ? ` + tax ${fmtNum(c.tax)} (${c.taxRate}%)` : ''}`);
    const $tin = $m.find('[name=tendered]');
    if (!tenderedTouched) $tin.val(st.partyId ? (st.tendered ?? '') : c.total);
    const tendered = num($tin.val());
    const diff = round2(tendered - c.total);
    let cls = 'success'; let msg;
    if (diff >= 0) msg = sale ? `Change: <b>${cur()} ${fmtNum(diff)}</b>` : (diff > 0 ? '<b>Paid amount exceeds total</b>' : 'Fully paid');
    else if (st.partyId) { cls = 'warning'; msg = `${sale ? 'Balance due' : 'Payable'}: <b>${cur()} ${fmtNum(-diff)}</b> (added to ${sale ? 'customer' : 'supplier'} account)`; }
    else { cls = 'danger'; msg = `Short by ${cur()} ${fmtNum(-diff)}. Select a ${sale ? 'customer' : 'supplier'} for credit.`; }
    if (!sale && diff > 0) cls = 'danger';
    $m.find('.co-result').attr('class', `alert alert-${cls} py-2 mb-2 co-result`).html(msg);
    $m.find('.co-complete').prop('disabled', cls === 'danger');
    const quick = new Set([c.total]);
    if (sale) [10, 50, 100, 500, 1000, 5000].forEach((u) => { const v = Math.ceil(c.total / u) * u; if (v > c.total && quick.size < 5) quick.add(v); });
    $m.find('.pay-quick').html([...quick].map((v, i) => `<button type="button" class="btn btn-outline-primary" data-v="${v}">${i === 0 ? 'Exact' : fmtNum(v)}</button>`).join('')
      + (st.partyId ? `<button type="button" class="btn btn-outline-secondary" data-v="0">${sale ? 'Credit' : 'Unpaid'}</button>` : ''));
  };
  $m.on('input', '[name=discount]', update);
  $m.on('input', '[name=tendered]', () => { tenderedTouched = true; update(); });
  $m.on('click', '.pay-quick [data-v]', function () { tenderedTouched = true; $m.find('[name=tendered]').val(this.dataset.v); update(); });
  $m.on('click', '.co-pct', () => {
    const base = Posting.previewDoc(st.lines, 0, 0)?.subtotal || 0;
    const pct = prompt('Discount percent (%)', '');
    if (pct !== null && num(pct) >= 0 && num(pct) <= 100) { $m.find('[name=discount]').val(round2(base * num(pct) / 100)); update(); }
  });
  $m.on('click', '.co-party', async () => {
    m.bs.hide(); await new Promise((r) => $m.one('hidden.bs.modal', r));
    await choosePartyFn(); m.bs.show(); tenderedTouched = false; update();
  });
  // Our modal helper removes the element on hide; keep it alive while choosing a party.
  $m.off('hidden.bs.modal');
  let finished = false;
  // Bootstrap may already have disposed the modal when its own data-bs-dismiss handler ran; ignore that second dispose.
  const closeAll = () => { finished = true; m.bs.hide(); $m.one('hidden.bs.modal', () => { try { m.bs.dispose(); } catch { /* already disposed */ } $m.remove(); }); };
  $m.find('[data-bs-dismiss=modal]').on('click', (e) => { e.preventDefault(); closeAll(); });
  $m.find('.btn-close').on('click', (e) => { e.preventDefault(); closeAll(); });
  $m.on('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAll(); } });
  $m.find('form').on('submit', (e) => { e.preventDefault(); $m.find('.co-complete').trigger('click'); });
  $m.on('shown.bs.modal', () => { if (!finished) $m.find('[name=tendered]').trigger('select'); });

  let busy = false;
  $m.find('.co-complete').on('click', async function () {
    if (busy) return; busy = true;
    const $b = $(this).prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Saving…');
    $m.find('.co-error').addClass('d-none');
    try {
      const account = $m.find('[name=account]').val();
      pref.set('payAccount', account);
      st.discount = num($m.find('[name=discount]').val());
      st.note = $m.find('[name=note]').val() || '';
      if (canDate) st.date = $m.find('[name=date]').val() || today();
      if (!sale) st.refNo = $m.find('[name=refNo]').val() || '';
      const input = {
        id: st.id, editId: st.editId, date: st.date, items: st.lines, discount: st.discount, taxRate: taxRate(),
        tendered: num($m.find('[name=tendered]').val()), paymentAccountId: account, note: st.note, refNo: st.refNo,
        customerId: sale ? st.partyId : undefined, supplierId: sale ? undefined : st.partyId,
      };
      const { doc, duplicate } = sale ? await Posting.saveSale(input) : await Posting.savePurchase(input);
      const doPrint = sale && $m.find('#co-print').prop('checked');
      closeAll();
      const wasEdit = !!st.editId;
      localStorage.removeItem(draftKey());
      st = fresh(st.mode);
      if (wasEdit) { location.hash = `#/${sale ? 'sales' : 'purchases'}/${doc.id}`; UI.toast(`${doc.number} updated`); return; }
      $root.html(layout()); renderLines(); renderHoldCount();
      UI.toast(duplicate ? `${doc.number} was already saved` : `${doc.number} saved — ${cur()} ${fmtNum(doc.total)}`);
      if (doPrint) await Printer.printDocument('sale', doc, { silentFail: true });
      afterSave(doc);
    } catch (err) {
      console.warn(err);
      $m.find('.co-error').text(err.message || String(err)).removeClass('d-none');
      $b.prop('disabled', false).html(`<i class="bi bi-check2-circle me-1"></i>${sale ? 'Complete sale' : 'Save purchase'}`);
    } finally { busy = false; }
  });
  update();
}

function afterSave(doc) {
  const sale = isSale();
  celebrate();
  const m = UI.modal({
    title: sale ? 'Sale completed' : 'Purchase saved', fullscreenMobile: false, scrollable: false,
    body: `<div class="text-center"><i class="bi bi-check-circle-fill text-success display-5"></i>
      <div class="h5 mt-2 mb-0">${esc(doc.number)}</div><div class="text-body-secondary">${cur()} ${fmtNum(doc.total)}</div>
      ${doc.change ? `<div class="alert alert-success mt-3 mb-0 py-2 fs-5">Change: <b>${cur()} ${fmtNum(doc.change)}</b></div>` : ''}
      ${doc.balance ? `<div class="alert alert-warning mt-3 mb-0 py-2">Balance due: <b>${cur()} ${fmtNum(doc.balance)}</b></div>` : ''}</div>`,
    footer: `<button class="btn btn-outline-secondary btn-print"><i class="bi bi-printer me-1"></i>Print</button>
      <a class="btn btn-outline-secondary" href="#/${sale ? 'sales' : 'purchases'}/${doc.id}"><i class="bi bi-eye me-1"></i>View</a>
      <button class="btn btn-primary flex-grow-1" data-bs-dismiss="modal">New ${sale ? 'sale' : 'purchase'}</button>`,
  });
  m.$el.find('.btn-print').on('click', () => Printer.printDocument(sale ? 'sale' : 'purchase', doc));
  m.$el.find('a').on('click', () => m.close());
  m.closed.then(() => $root?.find('.pos-q').trigger('focus'));
}

// ---------- holds ----------
async function holdSale() {
  if (!st.lines.length) return UI.toast('Cart is empty', 'warning');
  await Posting.saveHold({ id: uuid(), label: st.partyName || `Sale ${new Date().toLocaleTimeString()}`, state: { ...st }, total: totals().total });
  localStorage.removeItem(draftKey());
  st = fresh('sale');
  renderLines(); renderHoldCount();
  UI.toast('Sale held');
}
async function showHolds() {
  const holds = (await idb.getAll('holds')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!holds.length) return UI.toast('No held sales', 'info');
  const picked = await UI.pick({ title: 'Held sales', search: async (q) => holds.filter((h) => h.label.toLowerCase().includes(q.toLowerCase())).map((h) => ({ id: h.id, title: h.label, subtitle: `${h.state.lines.length} item(s) · ${new Date(h.createdAt).toLocaleString()}`, right: fmtNum(h.total), value: h })) });
  if (!picked) return;
  if (st.lines.length && !await UI.confirmDialog('Replace the current cart with the held sale? (Hold the current cart first if you need it.)')) return;
  st = { ...fresh('sale'), ...picked.value.state, id: uuid(), editId: null };
  // The resumed cart is now the (persisted) active draft; remove it from the held list so it cannot be resumed twice.
  await Posting.deleteHold(picked.id);
  renderLines(); renderHoldCount();
}

// ---------- quick product add ----------
async function quickAdd(prefill = '') {
  if (!Auth.can('product.edit')) return UI.toast('You do not have permission to add products', 'warning');
  const { editProduct } = await import('./products.js');
  const p = await editProduct(null, /^\d{6,}$/.test(prefill) ? { barcode: prefill } : { name: prefill });
  if (p) { addProduct(Catalog.product(p.id)); $root.find('.pos-q').val(''); hideResults(); }
}

// ---------- module ----------
export default {
  async render(el, { route, params, setTitle }) {
    const mode = route === 'purchase' ? 'purchase' : 'sale';
    await loadPayAccounts();
    if (params[0] === 'edit' && params[1]) {
      Auth.require(mode === 'sale' ? 'sale.edit' : 'purchase.manage');
      const doc = await idb.get(mode === 'sale' ? 'sales' : 'purchases', params[1]);
      if (!doc) throw new AppError('Document not found.');
      if (doc.status === 'void') throw new AppError('Voided documents cannot be edited.');
      const items = (await idb.getAllByIndex(mode === 'sale' ? 'saleItems' : 'purchaseItems', mode === 'sale' ? 'saleId' : 'purchaseId', doc.id)).sort((a, b) => a.line - b.line);
      st = { ...fresh(mode), id: doc.id, editId: doc.id, editNumber: doc.number, date: doc.date, partyId: doc.customerId || doc.supplierId || null,
        partyName: doc.customerId ? doc.customerName : doc.supplierId ? doc.supplierName : '', discount: doc.discount, note: doc.note || '', refNo: doc.refNo || '',
        tendered: mode === 'sale' ? doc.tendered : doc.paid, taxRate: doc.taxRate || 0, payAccount: doc.paymentAccountId,
        lines: items.map((i) => ({ productId: i.productId, name: i.name, unit: i.unit, qty: i.qty, rate: i.rate, discount: i.discount })) };
      setTitle(`Edit ${doc.number}`);
    } else {
      st = fresh(mode);
      try { const d = JSON.parse(localStorage.getItem(storageKey('draft.' + mode)) || 'null'); if (d && d.mode === mode && !d.editId) st = { ...st, ...d }; } catch { /* ignore */ }
      if (st.date !== today()) st.date = today();
    }
    $root = $(el);
    $root.html(layout());
    renderLines(); renderHoldCount(); renderGrid();
    const $q = $root.find('.pos-q');
    if (window.matchMedia('(min-width: 992px)').matches) $q.trigger('focus');

    $root.on('input', '.pos-q', doSearch);
    $root.on('keydown', '.pos-q', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = $q.val().trim();
        if (!q) return;
        const exact = Catalog.findByCode(q);
        if (exact) { addProduct(exact); UI.beep(); }
        else { const r = Catalog.searchProducts(q, { limit: 2 }); if (r.length) addProduct(r[0]); else { UI.toast(`No product found for "${q}"`, 'warning'); return; } }
        $q.val(''); hideResults();
      } else if (e.key === 'Escape') { $q.val(''); hideResults(); }
    });
    $root.on('click', '.search-results [data-i]', function () { addProduct(results[+this.dataset.i]); $q.val(''); hideResults(); $q.trigger('focus'); });
    $root.on('click', '.quick-add-link', (e) => { e.preventDefault(); quickAdd($q.val().trim()); });
    $(document).on('click.posres', (e) => { if (!$(e.target).closest('.pos-search').length) hideResults(); });

    $root.on('click', '.btn-inc, .btn-dec', function () {
      const i = +$(this).closest('.cart-line').data('i');
      const l = st.lines[i];
      const q = round3(l.qty + ($(this).hasClass('btn-inc') ? 1 : -1));
      if (q <= 0) st.lines.splice(i, 1); else l.qty = q;
      renderLines();
    });
    $root.on('change', '.qty-in', function () {
      const i = +$(this).closest('.cart-line').data('i');
      const q = round3(num(this.value));
      if (q > 0) st.lines[i].qty = q; else st.lines.splice(i, 1);
      renderLines();
    });
    $root.on('focus', '.qty-in', function () { this.select(); });
    $root.on('click keydown', '.btn-line', function (e) { if (e.type === 'keydown' && e.key !== 'Enter') return; editLine(+$(this).closest('.cart-line').data('i')); });
    $root.on('click', '.btn-pay', checkout);
    $root.on('click', '.btn-party', choosePartyFn);
    $root.on('click', '.btn-clear', async () => {
      if (st.editId) { if (await UI.confirmDialog('Discard changes to this document?')) history.back(); return; }
      if (st.lines.length && !await UI.confirmDialog('Clear all items from the cart?', { okLabel: 'Clear', okClass: 'btn-danger' })) return;
      st = fresh(st.mode); renderLines();
    });
    $root.on('click', '.btn-hold', holdSale);
    $root.on('click', '.btn-holds', showHolds);
    $root.on('click', '.btn-price-mode', () => { st.priceMode = st.priceMode === 'retail' ? 'wholesale' : 'retail'; pref.set('priceMode', st.priceMode); UI.toast(`Using ${st.priceMode} prices for new items`, 'info'); renderTotals(); renderGrid(); });
    $root.on('click', '.btn-quick-add', () => quickAdd(''));
    $root.on('click', '.btn-scan', async () => { const code = await Scanner.scan(); if (code) addByCode(code); });
    $root.on('click', '.btn-scan-cont', () => Scanner.scan({ continuous: true, title: 'Continuous scan', onCode: addByCode }));
    $root.on('click', '.btn-browse', () => { $root.find('.pos').addClass('show-browse'); renderGrid(); });
    $root.on('click', '.btn-close-browse', () => $root.find('.pos').removeClass('show-browse'));
    $root.on('input', '.browse-q', debounce(renderGrid, 150));
    $root.on('click', '.cat-chips [data-cat]', function () { browseCat = this.dataset.cat || null; renderGrid(); });
    $root.on('click', '.model-tile', function () { openModelPicker(this.dataset.model); });
    $root.on('click', '.product-tile:not(.model-tile)', function () {
      addProduct(Catalog.product(this.dataset.id));
      if (!window.matchMedia('(min-width: 992px)').matches) UI.toast('Added', 'success', 800);
    });
    detachWedge = Scanner.attachWedge(addByCode);
  },
  destroy() {
    detachWedge?.(); detachWedge = null;
    $(document).off('click.posres');
    $root?.off(); $root = null;
  },
};
