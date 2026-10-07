// Shoes: single pairs, whole shoe models (colour × size grid), and shoe categories.
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, debounce, compressImage, AppError, num } from '../core/utils.js';
import { money, pager } from '../core/views.js';
import { COLOR_PRESETS, SIZE_PRESETS, splitList, sortSizes, variantName } from '../core/shoe.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;
const UNITS = ['pair', 'pcs', 'set', 'dozen'];
const MAX_PAIRS_AT_ONCE = 300;

// Internal EAN-13 barcode in the "in-store" 20-29 prefix range.
export function generateBarcode() {
  let tries = 0; let code;
  do {
    const digits = '2' + String(Math.floor(Math.random() * 10)) + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b % 10).join('');
    const sum = [...digits].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    code = digits + ((10 - (sum % 10)) % 10);
  } while (Catalog.findByCode(code) && ++tries < 20);
  return code;
}

const brandList = () => [...new Set(Catalog.allProducts().map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const datalist = (id, items) => `<datalist id="${id}">${items.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>`;

// Single pair (one colour and size). Used for editing and for adding one pair at a time.
export async function editProduct(product = null, prefill = {}) {
  const p = { unit: 'pair', trackStock: true, active: 1, ...prefill, ...(product || {}) };
  let image = p.image || '';
  const cats = Catalog.allCategories();
  return UI.formModal({
    title: product ? 'Edit shoe' : 'New shoe', size: 'lg',
    body: `<div class="row g-2">
      <div class="col-6 col-md-4"><label class="form-label">Brand</label><input name="brand" class="form-control" list="brand-list" value="${esc(p.brand || '')}" placeholder="e.g. Servis">${datalist('brand-list', brandList())}</div>
      <div class="col-6 col-md-4"><label class="form-label">Model / style *</label><input name="model" class="form-control" value="${esc(p.model || '')}" placeholder="e.g. Derby"></div>
      <div class="col-6 col-md-2"><label class="form-label">Colour</label><input name="color" class="form-control" list="color-list" value="${esc(p.color || '')}">${datalist('color-list', COLOR_PRESETS)}</div>
      <div class="col-6 col-md-2"><label class="form-label">Size</label><input name="size" class="form-control" value="${esc(p.size || '')}" placeholder="42"></div>
      <div class="col-12"><label class="form-label">Display name <span class="small text-body-secondary">(leave empty to fill automatically)</span></label><input name="name" class="form-control" maxlength="150" value="${esc(p.name || '')}"></div>
      <div class="col-6 col-md-4"><label class="form-label">Type</label><select name="categoryId" class="form-select"><option value="">—</option>${UI.options(cats, p.categoryId)}</select></div>
      <div class="col-6 col-md-4"><label class="form-label">Style code / SKU</label><input name="sku" class="form-control" value="${esc(p.sku || '')}"></div>
      <div class="col-12 col-md-4"><label class="form-label">Barcode</label><div class="input-group">
        <input name="barcode" class="form-control" value="${esc(p.barcode || '')}" inputmode="numeric">
        <button type="button" class="btn btn-outline-secondary btn-scan-bc" title="Scan" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button>
        <button type="button" class="btn btn-outline-secondary btn-gen-bc" title="Generate" aria-label="Generate barcode"><i class="bi bi-magic"></i></button></div></div>
      <input type="hidden" name="unit" value="${esc(p.unit || 'pair')}">
      <div class="col-4"><label class="form-label">Cost price (factory)</label><input name="purchasePrice" class="form-control" inputmode="decimal" value="${p.purchasePrice ?? ''}"></div>
      <div class="col-4"><label class="form-label">Sale price</label><input name="salePrice" class="form-control" inputmode="decimal" value="${p.salePrice ?? ''}"></div>
      <div class="col-4"><label class="form-label">Wholesale price</label><input name="wholesalePrice" class="form-control" inputmode="decimal" value="${p.wholesalePrice ?? ''}"></div>
      <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="trackStock" id="pr-track" ${p.trackStock !== false ? 'checked' : ''}><label class="form-check-label" for="pr-track">Track stock (turn off for services like shoe repair)</label></div></div>
      <div class="col-4 stock-f"><label class="form-label">Opening stock (pairs)</label><input name="openingStock" class="form-control" inputmode="decimal" value="${p.openingStock ?? ''}"></div>
      <div class="col-4 stock-f"><label class="form-label">Minimum stock</label><input name="minStock" class="form-control" inputmode="decimal" value="${p.minStock ?? ''}"></div>
      <div class="col-4 stock-f"><label class="form-label">Current stock</label><input class="form-control" value="${fmtQty(p.stock || 0)}" disabled></div>
      <div class="col-12"><label class="form-label">Photo</label><div class="d-flex align-items-center gap-2">
        <div class="thumb img-prev">${image ? `<img src="${image}" alt="" class="thumb">` : '<i class="bi bi-image"></i>'}</div>
        <input type="file" accept="image/*" class="form-control img-file"><button type="button" class="btn btn-outline-danger btn-img-rm ${image ? '' : 'd-none'}" aria-label="Remove photo"><i class="bi bi-x"></i></button></div></div>
      ${product ? `<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="active" id="pr-active" ${p.active ? 'checked' : ''}><label class="form-check-label" for="pr-active">Active (available for sale)</label></div></div>` : ''}
    </div>`,
    onShown: ($m) => {
      const sync = () => $m.find('.stock-f').toggleClass('d-none', !$m.find('#pr-track').prop('checked'));
      $m.on('change', '#pr-track', sync); sync();
      $m.find('.btn-gen-bc').on('click', () => $m.find('[name=barcode]').val(generateBarcode()));
      $m.find('.btn-scan-bc').on('click', async () => {
        $m.addClass('d-none'); $('.modal-backdrop').last().addClass('d-none');
        const code = await Scanner.scan();
        $m.removeClass('d-none'); $('.modal-backdrop').first().removeClass('d-none');
        if (code) $m.find('[name=barcode]').val(code);
      });
      $m.find('.img-file').on('change', async function () {
        const f = this.files[0]; if (!f) return;
        try { image = await compressImage(f); $m.find('.img-prev').html(`<img src="${image}" alt="" class="thumb">`); $m.find('.btn-img-rm').removeClass('d-none'); } catch (e) { UI.toastError(e); }
      });
      $m.find('.btn-img-rm').on('click', function () { image = ''; $m.find('.img-prev').html('<i class="bi bi-image"></i>'); $(this).addClass('d-none'); $m.find('.img-file').val(''); });
      $m.find('[name=model]').trigger('focus');
    },
    onSubmit: async (v) => {
      if (!v.model.trim() && !v.name.trim()) throw new AppError('Enter the model name.');
      if (v.salePrice === '' && !product) throw new AppError('Enter a sale price.');
      const name = v.name.trim() || variantName(v);
      const saved = await Posting.saveProduct({ ...v, name, id: product?.id, image, active: product ? v.active : true });
      UI.toast(product ? 'Shoe updated' : 'Shoe added');
      return saved;
    },
  });
}

// Whole model: choose brand, colours and sizes, then enter pairs per colour × size.
// Every combination is created (sizes with 0 pairs too) so they can be sold later once stocked.
export async function newModel() {
  return UI.formModal({
    title: 'New shoe model', size: 'xl', submitLabel: 'Create all pairs',
    body: `<div class="row g-2">
      <div class="col-6 col-md-4"><label class="form-label">Brand *</label><input name="brand" class="form-control" list="brand-list" placeholder="e.g. Servis">${datalist('brand-list', brandList())}</div>
      <div class="col-6 col-md-4"><label class="form-label">Model / style *</label><input name="model" class="form-control" placeholder="e.g. Derby"></div>
      <div class="col-6 col-md-4"><label class="form-label">Type</label><select name="categoryId" class="form-select"><option value="">—</option>${UI.options(Catalog.allCategories(), '')}</select></div>
      <div class="col-6 col-md-4"><label class="form-label">Style code <span class="small text-body-secondary">(optional)</span></label><input name="code" class="form-control" placeholder="e.g. DRB01" maxlength="20"></div>
      <div class="col-4 col-md-2"><label class="form-label">Cost (factory)</label><input name="purchasePrice" class="form-control" inputmode="decimal"></div>
      <div class="col-4 col-md-2"><label class="form-label">Sale price *</label><input name="salePrice" class="form-control" inputmode="decimal"></div>
      <div class="col-4 col-md-2"><label class="form-label">Wholesale</label><input name="wholesalePrice" class="form-control" inputmode="decimal"></div>
      <div class="col-6 col-md-3"><label class="form-label">Minimum stock per pair</label><input name="minStock" class="form-control" inputmode="decimal" value="1"></div>
      <div class="col-12"><label class="form-label">Colours *</label>
        <input name="colors" class="form-control" placeholder="Black, Brown, Tan">
        <div class="chip-row mt-2">${COLOR_PRESETS.map((c) => `<button type="button" class="chip" data-add-color="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
      <div class="col-12"><label class="form-label">Sizes *</label>
        <input name="sizes" class="form-control" placeholder="38, 39, 40, 41">
        <div class="chip-row mt-2">${SIZE_PRESETS.map((s) => `<button type="button" class="chip" data-size-preset="${esc(s.sizes)}">${esc(s.label)}</button>`).join('')}</div></div>
      <div class="col-12"><div class="small fw-semibold mb-1">Pairs in stock</div>
        <div class="small text-body-secondary mb-2">Type how many pairs you have for each colour and size. Sizes you leave empty are still created with 0 stock.</div>
        <div class="table-responsive matrix"></div>
        <div class="small fw-semibold mt-2 matrix-total"></div></div>
    </div>`,
    onShown: ($m) => {
      const redraw = () => drawMatrix($m);
      $m.on('click', '[data-add-color]', function () { addToken($m.find('[name=colors]'), this.dataset.addColor); redraw(); });
      $m.on('click', '[data-size-preset]', function () { $m.find('[name=sizes]').val(this.dataset.sizePreset); redraw(); });
      $m.on('input change', '[name=colors], [name=sizes]', debounce(redraw, 200));
      $m.on('input', '.qty-cell', () => sumMatrix($m));
      redraw();
      $m.find('[name=brand]').trigger('focus');
    },
    onSubmit: async (v, $m) => {
      const brand = v.brand.trim(); const model = v.model.trim();
      if (!brand && !model) throw new AppError('Enter the brand or model name.');
      if (v.salePrice === '') throw new AppError('Enter the sale price.');
      const colors = splitList(v.colors); const sizes = sortSizes(splitList(v.sizes));
      if (!colors.length) throw new AppError('Add at least one colour.');
      if (!sizes.length) throw new AppError('Add at least one size.');
      if (colors.length * sizes.length > MAX_PAIRS_AT_ONCE) throw new AppError(`That is ${colors.length * sizes.length} pairs. Create at most ${MAX_PAIRS_AT_ONCE} at a time.`);
      const qty = new Map();
      $m.find('.qty-cell').each((_, el) => qty.set(`${el.dataset.c}|${el.dataset.s}`, num(el.value)));
      const code = v.code.trim().toUpperCase().replace(/\s+/g, '');
      let made = 0; const failed = [];
      await UI.withLoading(async () => {
        for (const color of colors) {
          for (const size of sizes) {
            try {
              await Posting.saveProduct({
                brand, model, color, size, name: variantName({ brand, model, color, size }),
                categoryId: v.categoryId, unit: 'pair', sku: code ? `${code}-${color}-${size}`.toUpperCase().replace(/\s+/g, '') : '',
                barcode: generateBarcode(), salePrice: v.salePrice, purchasePrice: v.purchasePrice, wholesalePrice: v.wholesalePrice,
                minStock: v.minStock, trackStock: true, openingStock: qty.get(`${color}|${size}`) || 0, active: true,
              });
              made++;
            } catch (e) { failed.push(`${color} ${size}: ${e.message}`); }
          }
        }
      }, 'Creating pairs…');
      if (!made) throw new AppError(failed[0] || 'Nothing was created.');
      if (failed.length) UI.toast(`${made} pairs created, ${failed.length} skipped. ${failed.slice(0, 2).join('; ')}`, 'warning', 7000);
      else UI.toast(`${made} pairs created`);
      return made;
    },
  });
}

// Adds a colour to the comma list unless it is already there.
function addToken($input, value) {
  const list = splitList($input.val());
  if (!list.some((x) => x.toLowerCase() === value.toLowerCase())) list.push(value);
  $input.val(list.join(', ')).trigger('change');
}

// Rebuilds the colour × size grid from the current colours and sizes, keeping values already typed.
function drawMatrix($m) {
  const keep = new Map();
  $m.find('.qty-cell').each((_, el) => keep.set(`${el.dataset.c}|${el.dataset.s}`, el.value));
  const colors = splitList($m.find('[name=colors]').val());
  const sizes = sortSizes(splitList($m.find('[name=sizes]').val()));
  const $box = $m.find('.matrix');
  if (!colors.length || !sizes.length) {
    $box.html(UI.emptyState('Choose colours and sizes to see the stock grid', 'grid-3x3'));
  } else {
    $box.html(`<table class="table table-sm align-middle text-center mb-0 matrix-table">
      <thead><tr><th class="text-start">Colour</th>${sizes.map((s) => `<th>${esc(s)}</th>`).join('')}</tr></thead>
      <tbody>${colors.map((c) => `<tr><th class="text-start text-nowrap">${esc(c)}</th>${sizes.map((s) => {
        const val = keep.get(`${c}|${s}`) ?? '';
        return `<td><input type="number" min="0" step="1" inputmode="numeric" class="form-control form-control-sm qty-cell" data-c="${esc(c)}" data-s="${esc(s)}" value="${esc(val)}" aria-label="${esc(c)} size ${esc(s)} pairs"></td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`);
  }
  sumMatrix($m);
}

function sumMatrix($m) {
  let pairs = 0;
  $m.find('.qty-cell').each((_, el) => { pairs += num(el.value); });
  const cells = $m.find('.qty-cell').length;
  $m.find('.matrix-total').text(cells ? `${fmtQty(pairs)} pairs in stock · ${cells} variants will be created` : '');
}

async function manageCategories() {
  const render = () => Catalog.allCategories().map((c) => {
    const n = Catalog.allProducts().filter((p) => p.categoryId === c.id).length;
    return `<div class="list-row"><div class="main"><div class="title">${esc(c.name)}</div><div class="sub">${n} pair(s)</div></div>
      <button class="btn btn-sm btn-light btn-cat-edit" data-id="${esc(c.id)}" aria-label="Rename"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-sm btn-light btn-cat-del" data-id="${esc(c.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button></div>`;
  }).join('') || UI.emptyState('No types yet', 'tags');
  const m = UI.modal({ title: 'Shoe types', body: `<p class="small text-body-secondary">Men, Women, Kids, Sports, Formal… Shoes are sorted by type.</p><form class="input-group mb-3 cat-add"><input class="form-control" placeholder="New type, e.g. Slippers" required><button class="btn btn-primary">Add</button></form><div class="list-card cat-list">${render()}</div>` });
  const refresh = () => m.$el.find('.cat-list').html(render());
  m.$el.find('.cat-add').on('submit', async (e) => {
    e.preventDefault();
    const $i = $(e.target).find('input');
    try { await Posting.saveCategory({ name: $i.val() }); $i.val(''); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-edit', async function () {
    const c = Catalog.category(this.dataset.id);
    const name = prompt('Type name', c.name);
    if (name === null) return;
    try { await Posting.saveCategory({ id: c.id, name }); refresh(); } catch (err) { UI.toastError(err); }
  });
  m.$el.on('click', '.btn-cat-del', async function () {
    try { await Posting.deleteCategory(this.dataset.id); refresh(); } catch (err) { UI.toastError(err); }
  });
  await m.closed;
}

async function renderList(el) {
  const $el = $(el).off();
  const canEdit = Auth.can('product.edit');
  $el.html(UI.pageHeader('Shoes', canEdit ? `<button class="btn btn-light btn-sm btn-cats"><i class="bi bi-tags"></i><span class="d-none d-sm-inline"> Types</span></button>
      <button class="btn btn-outline-primary btn-sm btn-add"><i class="bi bi-plus-lg"></i><span class="d-none d-sm-inline"> One pair</span></button>
      <button class="btn btn-primary btn-sm btn-model"><i class="bi bi-plus-lg"></i> New model</button>` : '') + `
    <div class="filters">
      <div class="input-group flex-grow-2"><input type="search" class="form-control q" placeholder="Search brand, model, colour, size, barcode…"><button class="btn btn-outline-secondary btn-scan" aria-label="Scan"><i class="bi bi-upc-scan"></i></button></div>
      <select class="form-select f-cat"><option value="">All types</option>${UI.options(Catalog.allCategories(), '')}</select>
      <select class="form-select f-status"><option value="active">Active</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="inactive">Inactive</option><option value="all">All</option></select>
    </div>
    <div class="small text-body-secondary mb-2 summary"></div>
    <div class="list-card list"></div>`);
  const draw = () => {
    const q = $el.find('.q').val();
    const cat = $el.find('.f-cat').val() || null;
    const f = $el.find('.f-status').val();
    const list = Catalog.searchProducts(q, { limit: Infinity, categoryId: cat, includeInactive: true }).filter((p) => {
      if (f === 'all') return true;
      if (f === 'inactive') return !p.active;
      if (!p.active) return false;
      if (f === 'low') return p.trackStock !== false && p.stock <= (p.minStock || 0);
      if (f === 'out') return p.trackStock !== false && p.stock <= 0;
      return true;
    });
    const pairs = list.reduce((s, p) => s + (p.trackStock !== false ? Math.max(0, p.stock || 0) : 0), 0);
    $el.find('.summary').text(`${list.length} shoe(s) · ${fmtQty(pairs)} pairs in stock`);
    pager($el.find('.list'), list, (p) => {
      const low = p.trackStock !== false && p.stock <= (p.minStock || 0);
      const label = p.name;
      const detail = [p.sku, p.barcode, Catalog.category(p.categoryId)?.name].filter(Boolean).join(' · ');
      return `<button class="list-row shoe-row" data-id="${esc(p.id)}">
        ${p.image ? `<img class="thumb" src="${p.image}" alt="" loading="lazy">` : `<div class="thumb shoe-thumb tint-${UI.tintFor(p.brand || p.name)}">${esc(UI.initials(p.brand || p.name))}</div>`}
        <div class="main"><div class="title">${esc(label)} ${p.active ? '' : '<span class="badge text-bg-secondary">Inactive</span>'}</div>
          <div class="sub">${esc(detail || '—')}</div></div>
        <div class="end"><div class="fw-semibold money">${money(p.salePrice)}</div>
          <div class="sub ${low ? 'text-danger fw-semibold' : ''}">${p.trackStock === false ? 'service' : `${fmtQty(p.stock)} pair${p.stock === 1 ? '' : 's'}`}</div></div></button>`;
    }, 60, UI.emptyState('No shoes found', 'bag', canEdit ? '<button class="btn btn-primary btn-sm mt-3 btn-model">Add a shoe model</button>' : ''));
  };
  draw();
  $el.on('input', '.q', debounce(draw, 150));
  $el.on('change', '.f-cat, .f-status', draw);
  $el.on('click', '.btn-add', async () => { if (await editProduct()) draw(); });
  $el.on('click', '.btn-model', async () => { if (await newModel()) draw(); });
  $el.on('click', '.btn-cats', async () => { await manageCategories(); renderList(el); });
  $el.on('click', '.btn-scan', async () => {
    const code = await Scanner.scan(); if (!code) return;
    const p = Catalog.findByCode(code);
    if (p) { $el.find('.q').val(code); draw(); } else if (canEdit && await UI.confirmDialog(`No shoe with barcode ${code}. Add it now?`)) { if (await editProduct(null, { barcode: code })) draw(); }
    else UI.toast('No shoe found with this barcode', 'warning');
  });
  $el.on('click', '.list-row[data-id]', async function () {
    const p = Catalog.product(this.dataset.id);
    if (!canEdit) { location.hash = `#/stock/${encodeURIComponent(p.id)}`; return; }
    productActions(p, draw);
  });
}

async function productActions(p, redraw) {
  const m = UI.modal({ title: p.name, fullscreenMobile: false,
    body: `<div class="row small mb-3">
        <div class="col-6">Sale: <b>${money(p.salePrice)}</b></div><div class="col-6">Wholesale: <b>${money(p.wholesalePrice)}</b></div>
        <div class="col-6">Cost: <b>${money(p.purchasePrice)}</b></div><div class="col-6">Stock: <b>${p.trackStock === false ? 'n/a' : fmtQty(p.stock) + ' pair(s)'}</b></div>
        <div class="col-6">Margin: <b>${p.salePrice ? fmtNum(((p.salePrice - p.purchasePrice) / p.salePrice) * 100) + '%' : '—'}</b></div><div class="col-6">Min stock: <b>${fmtQty(p.minStock || 0)}</b></div>
        ${p.brand || p.model ? `<div class="col-12 mt-2">Brand / model: <b>${esc([p.brand, p.model].filter(Boolean).join(' '))}</b></div>` : ''}
        ${p.color || p.size ? `<div class="col-12">Colour / size: <b>${esc([p.color, p.size].filter(Boolean).join(' · '))}</b></div>` : ''}</div>
      <div class="d-grid gap-2">
        <button class="btn btn-primary btn-edit"><i class="bi bi-pencil me-1"></i>Edit shoe</button>
        <a class="btn btn-outline-secondary" href="#/stock/${encodeURIComponent(p.id)}"><i class="bi bi-clock-history me-1"></i>Stock history</a>
        ${Auth.can('stock.adjust') && p.trackStock !== false ? `<a class="btn btn-outline-secondary" href="#/stock/adjust/${encodeURIComponent(p.id)}"><i class="bi bi-sliders me-1"></i>Adjust stock</a>` : ''}
        ${Auth.can('product.delete') ? '<button class="btn btn-outline-danger btn-del"><i class="bi bi-trash me-1"></i>Delete</button>' : ''}
      </div>` });
  m.$el.find('a').on('click', () => m.close());
  m.$el.find('.btn-edit').on('click', async () => { m.close(); await m.closed; if (await editProduct(p)) redraw(); });
  m.$el.find('.btn-del').on('click', async () => {
    m.close(); await m.closed;
    if (!await UI.confirmDialog(`Delete "${p.name}"? Shoes with sales or purchases are deactivated instead.`, { okLabel: 'Delete', okClass: 'btn-danger' })) return;
    try { const r = await Posting.deleteProduct(p.id); UI.toast(r === 'deleted' ? 'Shoe deleted' : 'Shoe hidden (it has sales or purchases)'); redraw(); } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) { await renderList(el); },
};
