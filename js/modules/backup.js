// Backup & Restore UI.
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, downloadFile } from '../core/utils.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Backup from '../services/backup.js';

const $ = window.jQuery;

export async function downloadBackup() {
  const b = await UI.withLoading(() => Backup.createBackup(), 'Preparing backup…');
  const stamp = b.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  downloadFile(`shoeshop-backup-${stamp}.json`, JSON.stringify(b), 'application/json');
  pref.set('lastBackupAt', b.createdAt);
  return b;
}

const LABELS = {
  products: 'Products', categories: 'Categories', customers: 'Customers', suppliers: 'Suppliers', accounts: 'Accounts', sales: 'Sales', saleItems: 'Sale items',
  purchases: 'Purchases', purchaseItems: 'Purchase items', saleReturns: 'Sale returns', purchaseReturns: 'Purchase returns', vouchers: 'Payments / vouchers',
  entries: 'Ledger entries', stockMoves: 'Stock movements', adjustments: 'Stock adjustments', holds: 'Held sales', auditLog: 'Activity log', meta: 'Counters / metadata',
};

// Offer to import data from the old shared database (see services/backup.js).
async function showLegacy($box) {
  const old = await Backup.readLegacyData();
  if (!old) return;
  const c = old.counts;
  const rows = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'saleReturns', 'vouchers', 'adjustments']
    .filter((k) => c[k]).map((k) => `<div class="list-row py-1"><div class="main">${esc(LABELS[k] || k)}</div><div class="end">${c[k]}</div></div>`).join('');
  $box.html(`<div class="card border-warning"><div class="card-body">
    <h2 class="h6"><i class="bi bi-database-exclamation me-2"></i>Data from an older version found</h2>
    <p class="small mb-2">Older versions stored data in a database shared by all apps on <b>${esc(location.host)}</b>
      (for example AgriSale or pharmaSaleApp). This app now keeps its own separate database. The data below may belong to
      this app or to one of the others — import it only if it is yours. The old database is not changed.</p>
    <div class="list-card mb-3 small">${rows}</div>
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-warning btn-legacy-import"><i class="bi bi-box-arrow-in-down me-1"></i>Import into this app</button>
      <button class="btn btn-outline-secondary btn-legacy-hide">Don't show again</button>
    </div></div></div>`);
  $box.on('click', '.btn-legacy-hide', () => { pref.set('legacyHandled', true); $box.empty(); });
  $box.on('click', '.btn-legacy-import', async () => {
    if (!await UI.confirmDialog('Merge the old data into this app? Records that already exist here are kept; missing ones are added.', { okLabel: 'Import' })) return;
    try {
      const r = await UI.withLoading(() => Backup.restore(old, 'merge'), 'Importing…');
      pref.set('legacyHandled', true);
      UI.toast(`Imported: ${r.added} added, ${r.updated} updated`);
      if (r.conflicts.length) await UI.confirmDialog(`<p>${r.conflicts.length} record(s) were skipped because of number conflicts:</p><div class="small">${r.conflicts.slice(0, 30).map(esc).join('<br>')}</div>`, { html: true, title: 'Import conflicts', okLabel: 'OK' });
      location.hash = '#/dashboard';
    } catch (e) { UI.toastError(e); }
  });
}

export default {
  async render(el) {
    const $el = $(el);
    const canRestore = Auth.can('backup.restore');
    const last = pref.get('lastBackupAt');
    $el.html(UI.pageHeader('Backup & Restore') + `
      <div class="row g-3">
        <div class="col-lg-6"><div class="card h-100"><div class="card-body">
          <h2 class="h6"><i class="bi bi-cloud-arrow-down me-2"></i>Export backup</h2>
          <p class="small text-body-secondary">Downloads a complete JSON backup of all POS data on this device: products, customers, suppliers, accounts, sales, purchases, returns, payments, stock movements, ledger and settings. Passwords and login credentials are <b>never</b> included.</p>
          <div class="small mb-3">Last backup on this device: <b>${last ? fmtDateTime(last) : 'never'}</b></div>
          <button class="btn btn-primary btn-export"><i class="bi bi-download me-1"></i>Download backup</button>
        </div></div></div>
        <div class="col-lg-6"><div class="card h-100"><div class="card-body">
          <h2 class="h6"><i class="bi bi-cloud-arrow-up me-2"></i>Restore backup</h2>
          ${canRestore ? `<p class="small text-body-secondary">Select a backup file. It is validated before anything changes; you will see its date and record counts and must confirm.</p>
            <input type="file" accept="application/json,.json" class="form-control file">
            <div class="preview mt-3"></div>` : '<div class="alert alert-secondary small mb-0">Only administrators can restore backups.</div>'}
        </div></div></div>
      </div>
      <div class="legacy mt-3"></div>`);
    if (canRestore && pref.get('legacyHandled') !== true) showLegacy($el.find('.legacy'));
    $el.on('click', '.btn-export', async () => {
      try { const b = await downloadBackup(); UI.toast('Backup downloaded'); $el.find('.card-body b').first().text(fmtDateTime(b.createdAt)); } catch (e) { UI.toastError(e); }
    });
    let obj = null;
    $el.on('change', '.file', async function () {
      const f = this.files[0];
      const $p = $el.find('.preview').html(UI.spinner('Validating…'));
      obj = null;
      if (!f) return $p.empty();
      try {
        if (f.size > 500 * 1024 * 1024) throw new Error('File is too large.');
        let parsed;
        try { parsed = JSON.parse(await f.text()); } catch { throw new Error('The file is not valid JSON (it may be corrupted).'); }
        const v = Backup.validateBackup(parsed);
        const sumOk = v.ok ? await Backup.verifyChecksum(parsed) : null;
        if (sumOk === false) v.errors.push('Checksum mismatch: the backup data was modified or corrupted.');
        const ok = v.ok && sumOk !== false;
        $p.html(`<div class="alert ${ok ? 'alert-success' : 'alert-danger'} py-2 small">${ok ? '<i class="bi bi-check-circle me-1"></i>Backup is valid.' : '<i class="bi bi-x-octagon me-1"></i>This backup cannot be restored.'}
            ${v.errors.map((e) => `<div>• ${esc(e)}</div>`).join('')}${v.warnings.map((w) => `<div class="text-warning-emphasis">• ${esc(w)}</div>`).join('')}</div>
          ${v.counts ? `<div class="small mb-2">Created: <b>${esc(fmtDateTime(v.createdAt))}</b> · App ${esc(v.appVersion || '?')}${v.createdBy ? ` · by ${esc(v.createdBy.name)}` : ''}${sumOk ? ' · checksum verified' : ''}</div>
          <div class="list-card mb-3 small">${Object.entries(v.counts).filter(([, n]) => n).map(([k, n]) => `<div class="list-row py-1"><div class="main">${esc(LABELS[k] || k)}</div><div class="end">${n}</div></div>`).join('')}</div>` : ''}
          ${ok ? `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="safety" checked><label class="form-check-label small" for="safety">Download a backup of the current data first (recommended)</label></div>
          <div class="d-grid gap-2">
            <button class="btn btn-outline-primary btn-merge"><i class="bi bi-intersect me-1"></i>Merge into local data</button>
            <button class="btn btn-danger btn-replace"><i class="bi bi-arrow-repeat me-1"></i>Replace all local data</button>
          </div>
          <div class="form-text">Merge adds records that are missing and updates records that are newer in the backup. Replace erases all POS data on this device and loads the backup.</div>` : ''}`);
        if (ok) obj = parsed;
      } catch (e) { $p.html(UI.errorState(e)); }
    });
    const doRestore = async (mode) => {
      if (!obj) return;
      const msg = mode === 'replace'
        ? '<p>This will <b>erase all POS data on this device</b> and replace it with the backup. This cannot be undone.</p><label class="form-label small">Type <b>REPLACE</b> to confirm</label><input class="form-control confirm-text">'
        : '<p>Records from the backup will be merged into the local data. Existing newer records are kept.</p>';
      let typed = '';
      const m = UI.confirmDialog(msg, { html: true, okLabel: mode === 'replace' ? 'Replace data' : 'Merge', okClass: mode === 'replace' ? 'btn-danger' : 'btn-primary', title: mode === 'replace' ? 'Replace all data?' : 'Merge backup?' });
      $(document).on('input.confirmtext', '.confirm-text', function () { typed = this.value; });
      const ok = await m;
      $(document).off('input.confirmtext');
      if (!ok) return;
      if (mode === 'replace' && typed.trim().toUpperCase() !== 'REPLACE') { UI.toast('Restore cancelled: confirmation text did not match.', 'warning'); return; }
      try {
        if ($el.find('#safety').prop('checked')) await downloadBackup();
        const r = await UI.withLoading(() => Backup.restore(obj, mode), 'Restoring data…');
        UI.toast(mode === 'replace' ? 'Backup restored' : `Merged: ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged`);
        if (r.conflicts.length) await UI.confirmDialog(`<p>${r.conflicts.length} record(s) were skipped because of number conflicts:</p><div class="small">${r.conflicts.slice(0, 30).map(esc).join('<br>')}</div>`, { html: true, title: 'Merge conflicts', okLabel: 'OK' });
        location.hash = '#/dashboard';
      } catch (e) { UI.toastError(e); }
    };
    $el.on('click', '.btn-merge', () => doRestore('merge'));
    $el.on('click', '.btn-replace', () => doRestore('replace'));
  },
};
