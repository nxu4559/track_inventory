// ══════════════════════════════════════════════════════
// WAREHOUSE IMS — app.js
// ══════════════════════════════════════════════════════

// ─── STATE ───────────────────────────────────────────
let sbClient = null;
let items = [];
let activityLog = [];
let invFilter  = 'all';
let actFilter  = 'all';
let flowState  = {};
let scanners   = {};
let quickAddReturnFlow = null;

// ─── WAREHOUSE ZONES ─────────────────────────────────
// Add more zones here as your warehouse grows
const ZONES = {
  M08: {
    label: 'M08',
    aisles: {
      A: { rows: ['A1','A2','A3','A4'], bays: ['#01','#02'] },
      B: { rows: ['B1','B2','B3','B4'], bays: ['#01','#02'] },
      C: { rows: ['C1','C2','C3','C4'], bays: ['#01','#02','#03','#04'] },
      D: { rows: ['D1','D2','D3','D4'], bays: ['#01','#02','#03','#04'] },
    }
  },
  // Uncomment and fill in when you add more zones:
  // M07: {
  //   label: 'M07',
  //   aisles: {
  //     A: { rows: ['A1','A2','A3','A4'], bays: ['#01','#02'] },
  //   }
  // },
};

function getAllShelves() {
  // Returns all shelf codes like M08A1, M08B3, M07A2 etc.
  const shelves = [];
  for (const [zone, zdata] of Object.entries(ZONES)) {
    for (const [aisle, adata] of Object.entries(zdata.aisles)) {
      for (const row of adata.rows) {
        shelves.push({ code: zone + aisle + row, zone, aisle, row, bays: adata.bays });
      }
    }
  }
  return shelves;
}

function getBaysForShelf(shelfCode) {
  // e.g. "M08A1" → bays for aisle A in zone M08
  for (const [zone, zdata] of Object.entries(ZONES)) {
    for (const [aisle, adata] of Object.entries(zdata.aisles)) {
      if (shelfCode.startsWith(zone + aisle)) {
        return adata.bays;
      }
    }
  }
  return ['#01','#02'];
}

// ─── HELPERS ─────────────────────────────────────────
function totalQty(item) {
  return (item.locations || []).reduce((s, l) => s + (l.qty || 0), 0);
}

function statusOf(item) {
  if (item.sold) return 'sold';
  const t = totalQty(item);
  if (t <= 0) return 'out';
  if (t <= item.thresh) return 'low';
  return 'in';
}

function statusLabel(s) {
  return { in:'In Stock', low:'Low Stock', out:'Out of Stock', sold:'Sold' }[s] || s;
}

function actColor(t) {
  return { addstock:'#16A34A', sell:'#DC2626', move:'#1A6BFF', adjust:'#D97706' }[t] || '#8A8A86';
}

function actLabel(t) {
  return { addstock:'Add Stock', sell:'Sell/Remove', move:'Move', adjust:'Adjust' }[t] || t;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function findItem(val) {
  if (!val) return null;
  const q = val.toLowerCase().trim();
  return items.find(i =>
    i.sku.toLowerCase() === q ||
    (i.barcode && i.barcode === q) ||
    i.sku.toLowerCase().includes(q) ||
    i.name.toLowerCase().includes(q) ||
    (i.barcode && i.barcode.includes(q))
  );
}

// ─── DATABASE ─────────────────────────────────────────
async function dbSaveItem(item) {
  if (!sbClient) return;
  const payload = {
    name: item.name, sku: item.sku, barcode: item.barcode || '',
    unit: item.unit, thresh: item.thresh, sold: item.sold,
    locations: item.locations
  };
  if (item.id && item.id.length > 8) {
    await sbClient.from('items').update(payload).eq('id', item.id);
  } else {
    const { data } = await sbClient.from('items').insert(payload).select().single();
    if (data) item.id = data.id;
  }
}

async function dbLogActivity(entry) {
  if (!sbClient) return;
  await sbClient.from('activity').insert({
    type: entry.type, item_id: entry.itemId,
    item_name: entry.itemName, location: entry.location,
    qty: entry.qty, reason: entry.reason || '',
    notes: entry.notes || ''
  });
}

async function loadData() {
  const [itemsRes, actRes] = await Promise.all([
    sbClient.from('items').select('*').order('created_at', { ascending: false }),
    sbClient.from('activity').select('*').order('ts', { ascending: false }).limit(150)
  ]);
  if (itemsRes.error) throw itemsRes.error;
  items = (itemsRes.data || []).map(r => ({
    id: r.id, name: r.name, sku: r.sku,
    barcode: r.barcode || '', unit: r.unit || 'pcs',
    thresh: r.thresh || 5, sold: r.sold || false,
    locations: r.locations || []
  }));
  activityLog = (actRes.data || []).map(r => ({
    id: r.id, type: r.type, itemId: r.item_id,
    itemName: r.item_name, location: r.location,
    qty: r.qty, reason: r.reason, notes: r.notes,
    ts: new Date(r.ts).getTime()
  }));
}

// ─── INIT ─────────────────────────────────────────────
(async () => {
  try {
    document.getElementById('loading-status').textContent = 'Connecting to database…';
    var cfg = { url: '%%SUPABASE_URL%%', key: '%%SUPABASE_KEY%%' };
    sbClient = window.supabase.createClient(cfg.url, cfg.key);
    const { error } = await sbClient.from('items').select('id').limit(1);
    if (error) throw error;
    document.getElementById('loading-status').textContent = 'Loading inventory…';
    await loadData();
    // Hide loading, show app
    document.getElementById('loading-screen').classList.add('fade-out');
    document.getElementById('app').classList.remove('hidden');
    setTimeout(() => document.getElementById('loading-screen').style.display = 'none', 400);
    renderAll();
  } catch(e) {
    document.getElementById('loading-status').textContent = 'Connection failed: ' + (e.message || e);
    document.getElementById('loading-fill').style.background = '#DC2626';
  }
})();

// ─── RENDER ALL ───────────────────────────────────────
function renderAll() {
  renderStats();
  renderDashAlerts();
  renderDashActivity();
  renderInvTable();
  renderActivity();
  renderMap();
  const low = items.filter(i => statusOf(i) === 'low').length;
  const badge = document.getElementById('nav-low-badge');
  if (badge) {
    badge.textContent = low;
    badge.classList.toggle('hidden', low === 0);
  }
}

function renderStats() {
  const locs = new Set(items.flatMap(i => (i.locations || []).map(l => l.loc))).size;
  document.getElementById('stat-total').textContent = items.length;
  document.getElementById('stat-low').textContent   = items.filter(i => statusOf(i) === 'low').length;
  document.getElementById('stat-out').textContent   = items.filter(i => statusOf(i) === 'out').length;
  document.getElementById('stat-locs').textContent  = locs;
}

function renderDashAlerts() {
  const low = items.filter(i => statusOf(i) === 'low' || statusOf(i) === 'out');
  const el = document.getElementById('dash-alerts');
  if (!low.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">🎉</div>No low stock alerts</div>';
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>SKU / Code</th>
          <th>Barcode</th>
          <th>Status</th>
          <th>Qty</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        ${low.map(i => `<tr onclick="openDetailModal('${i.id}')" style="cursor:pointer">
          <td><div class="td-name">${i.name}</div></td>
          <td><span class="mono">${i.sku}</span></td>
          <td><span class="mono" style="color:var(--muted)">${i.barcode || '—'}</span></td>
          <td><span class="tag ${statusOf(i)}">${statusLabel(statusOf(i))}</span></td>
          <td><strong>${totalQty(i)}</strong> <span style="color:var(--muted)">${i.unit}</span></td>
          <td><div class="loc-chips">${(i.locations || []).map(l => '<span class="loc-chip">' + l.loc + ' (' + l.qty + ')</span>').join('') || '—'}</div></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderDashActivity() {
  const el = document.getElementById('dash-activity');
  if (!activityLog.length) {
    el.innerHTML = '<div class="empty">No activity yet</div>';
    return;
  }
  el.innerHTML = activityLog.slice(0, 6).map(a => `
    <div class="act-row">
      <div class="act-dot" style="background:${actColor(a.type)}"></div>
      <div class="act-body">
        <div class="act-title">${actLabel(a.type)} · ${a.itemName || ''}</div>
        <div class="act-meta">${[a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="act-time">${timeAgo(a.ts)}</div>
    </div>`).join('');
}

// ─── INVENTORY TABLE ──────────────────────────────────
function renderInvTable(subset) {
  const src = subset || (invFilter === 'all' ? items : items.filter(i => statusOf(i) === invFilter));
  const tbody = document.getElementById('inv-tbody');
  if (!src.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-icon">📦</div>No items found</div></td></tr>`;
    return;
  }
  tbody.innerHTML = src.map(item => {
    const s = statusOf(item);
    return `<tr>
      <td><div class="td-name">${item.name}</div><div class="td-sub">${item.unit} · alert at ${item.thresh}</div></td>
      <td><span class="mono">${item.sku}</span></td>
      <td><span class="mono">${item.barcode || '—'}</span></td>
      <td><span class="tag ${s}">${statusLabel(s)}</span></td>
      <td><strong>${totalQty(item)}</strong> <span style="color:var(--muted)">${item.unit}</span></td>
      <td><div class="loc-chips">${(item.locations || []).map(l => `<span class="loc-chip">${l.loc} (${l.qty})</span>`).join('') || '<span style="color:var(--muted2)">—</span>'}</div></td>
      <td><div class="td-actions">
        <button class="tbl-btn g" onclick="openFlowWithItem('addstock','${item.id}')">+</button>
        <button class="tbl-btn r" onclick="openFlowWithItem('sell','${item.id}')">−</button>
        <button class="tbl-btn"   onclick="openDetailModal('${item.id}')">Detail</button>
        <button class="tbl-btn"   onclick="toggleSold('${item.id}')">${item.sold ? 'Unmark' : 'Sold'}</button>
      </div></td>
    </tr>`;
  }).join('');
}

function setInvFilter(f, btn) {
  invFilter = f;
  document.querySelectorAll('#page-inventory .pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderInvTable();
}

function globalSearch(val) {
  if (!val.trim()) { renderInvTable(); return; }
  const terms = val.toLowerCase().trim().split(/\s+/);
  const results = items.filter(item => {
    const hay = [item.name, item.sku, item.barcode || '',
      ...(item.locations || []).map(l => l.loc),
      statusLabel(statusOf(item)), item.unit
    ].join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  showPage('inventory');
  renderInvTable(results);
}

// ─── ACTIVITY ─────────────────────────────────────────
function renderActivity() {
  const src = actFilter === 'all' ? activityLog : activityLog.filter(a => a.type === actFilter);
  const el = document.getElementById('activity-list');
  if (!src.length) { el.innerHTML = '<div class="empty">No activity yet</div>'; return; }
  el.innerHTML = src.slice(0, 100).map(a => `
    <div class="act-row">
      <div class="act-dot" style="background:${actColor(a.type)}"></div>
      <div class="act-body">
        <div class="act-title">${actLabel(a.type)} · ${a.itemName || ''}</div>
        <div class="act-meta">${[a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="act-time">${timeAgo(a.ts)}</div>
    </div>`).join('');
}

function setActFilter(f, btn) {
  actFilter = f;
  document.querySelectorAll('#page-activity .pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderActivity();
}

// ─── MAP ──────────────────────────────────────────────
function renderMap() {
  const el = document.getElementById('map-grid');
  if (!el) return;

  // Layout: A(4 rows × 2 bays), B(4 rows × 2 bays), C(4 rows × 4 cols/side), D(4 rows × 4 bays full)
  const CELL_W_AB = 88, CELL_W_C = 68, CELL_W_D = 170, CELL_H = 44;

  function cellInfo(locCode) {
    const here = items.filter(i => (i.locations || []).some(l => l.loc === locCode));
    const qty = here.reduce((s, i) => s + (i.locations || []).filter(l => l.loc === locCode).reduce((a, l) => a + l.qty, 0), 0);
    const isLow = here.some(i => statusOf(i) === 'low' || statusOf(i) === 'out');
    const cls = qty > 0 ? (isLow ? 'low' : 'has') : '';
    return { qty, cls, items: here };
  }

  function makeCell(loc, w, h) {
    const { qty, cls } = cellInfo(loc);
    return `<div class="map-cell ${cls}" style="width:${w}px;height:${h}px" onclick="mapCellClick('${loc}')" title="${loc}">
      <div class="map-cell-loc">${loc}</div>
      <div class="map-cell-qty">${qty || '·'}</div>
    </div>`;
  }

  function bayLabels(bays, cellW) {
    return '<div class="map-bay-labels">' + bays.map(b =>
      `<div class="map-bay-label" style="width:${cellW}px">${b}</div>`
    ).join('') + '</div>';
  }

  let html = '';

  // ── A & B side by side ──
  html += '<div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:24px">';

  // A
  html += '<div>';
  html += '<div class="map-section-label" style="margin-bottom:8px">A</div>';
  html += bayLabels(['#01','#02'], CELL_W_AB);
  ['A4','A3','A2','A1'].forEach(row => {
    html += `<div class="map-row"><div class="map-row-label">${row}</div>`;
    ['#01','#02'].forEach(bay => { html += makeCell('M08' + row + bay, CELL_W_AB, CELL_H); });
    html += '</div>';
  });
  html += '</div>';

  // B
  html += '<div>';
  html += '<div class="map-section-label" style="margin-bottom:8px">B</div>';
  html += bayLabels(['#01','#02'], CELL_W_AB);
  ['B4','B3','B2','B1'].forEach(row => {
    html += `<div class="map-row"><div class="map-row-label">${row}</div>`;
    ['#01','#02'].forEach(bay => { html += makeCell('M08' + row + bay, CELL_W_AB, CELL_H); });
    html += '</div>';
  });
  html += '</div>';

  // C (side access)
  html += '<div>';
  html += '<div class="map-section-label" style="margin-bottom:8px">C <span style="font-size:12px;font-style:normal;color:var(--muted)">(side access)</span></div>';
  html += bayLabels(['C1','C2','C3','C4'], CELL_W_C);
  ['#01','#02','#03','#04'].forEach(row => {
    html += `<div class="map-row"><div class="map-row-label">${row}</div>`;
    ['C1','C2','C3','C4'].forEach(col => { html += makeCell('M08' + col + row, CELL_W_C, CELL_H); });
    html += '</div>';
  });
  html += '</div>';
  html += '</div>'; // end A/B/C row

  // Walking aisle
  html += '<div class="map-aisle-gap"><div class="map-aisle-gap-line"></div><div class="map-aisle-gap-text">— walking aisle —</div><div class="map-aisle-gap-line"></div></div>';

  // D full width
  html += '<div>';
  html += '<div class="map-section-label" style="margin-bottom:8px">D</div>';
  html += bayLabels(['#01','#02','#03','#04'], CELL_W_D);
  ['D4','D3','D2','D1'].forEach(row => {
    html += `<div class="map-row"><div class="map-row-label">${row}</div>`;
    ['#01','#02','#03','#04'].forEach(bay => { html += makeCell('M08' + row + bay, CELL_W_D, CELL_H); });
    html += '</div>';
  });
  // Entrance label
  html += '<div style="text-align:center;font-size:11px;color:var(--muted2);margin-top:10px;letter-spacing:0.06em">▼ ENTRANCE / FRONT</div>';
  html += '</div>';

  el.innerHTML = html;
}

function mapCellClick(loc) {
  const here = items.filter(i => (i.locations || []).some(l => l.loc === loc));
  if (!here.length) { showToast(loc + ' — empty'); return; }
  showToast(loc + ': ' + here.map(i => i.sku + ' (' + ((i.locations || []).find(l => l.loc === loc) || {qty:0}).qty + ')').join(', '));
}

// ─── ADD ITEM ─────────────────────────────────────────
async function saveNewItem() {
  const name    = document.getElementById('ai-name').value.trim();
  const sku     = document.getElementById('ai-sku').value.trim();
  const barcode = document.getElementById('ai-barcode').value.trim();
  const unit    = document.getElementById('ai-unit').value.trim() || 'pcs';
  const thresh  = parseInt(document.getElementById('ai-thresh').value) || 5;
  if (!name || !sku) { showToast('Name and SKU required', 'err'); return; }
  if (items.find(i => i.sku.toLowerCase() === sku.toLowerCase())) { showToast('SKU already exists', 'err'); return; }
  const item = { id: uid(), name, sku, barcode, unit, thresh, sold: false, locations: [] };
  items.unshift(item);
  await dbSaveItem(item);
  ['ai-name','ai-sku','ai-barcode','ai-unit','ai-thresh'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  closeModal('modal-additem');
  renderAll();
  showToast('"' + name + '" added', 'ok');
}

function toggleSold(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  item.sold = !item.sold;
  dbSaveItem(item);
  renderAll();
  showToast(item.sold ? 'Marked as Sold' : 'Marked as Available', 'ok');
}

// ─── QUICK ADD ────────────────────────────────────────
function openQuickAdd(scanned, returnFlow) {
  quickAddReturnFlow = returnFlow;
  document.getElementById('qa-scanned-val').textContent = scanned;
  const isNum = /^\d+$/.test(scanned);
  document.getElementById('qa-sku').value  = isNum ? '' : scanned;
  document.getElementById('qa-name').value = '';
  document.getElementById('qa-unit').value = 'pcs';
  document.getElementById('qa-thresh').value = '5';
  openModal('modal-quickadd');
  setTimeout(() => document.getElementById('qa-name').focus(), 100);
}

async function saveQuickAdd() {
  const scanned = document.getElementById('qa-scanned-val').textContent.trim();
  const name    = document.getElementById('qa-name').value.trim();
  const sku     = document.getElementById('qa-sku').value.trim();
  const unit    = document.getElementById('qa-unit').value.trim() || 'pcs';
  const thresh  = parseInt(document.getElementById('qa-thresh').value) || 5;
  if (!name) { showToast('Name required', 'err'); return; }
  if (!sku)  { showToast('SKU required', 'err'); return; }
  if (items.find(i => i.sku.toLowerCase() === sku.toLowerCase())) { showToast('SKU already exists', 'err'); return; }
  const barcode = scanned !== sku ? scanned : '';
  const item = { id: uid(), name, sku, barcode, unit, thresh, sold: false, locations: [] };
  items.unshift(item);
  await dbSaveItem(item);
  renderAll();
  closeModal('modal-quickadd');
  showToast('"' + name + '" added!', 'ok');
  if (quickAddReturnFlow) {
    flowState.item = item;
    flowState.step = 2;
    openModal('modal-' + quickAddReturnFlow);
    renderFlow(quickAddReturnFlow);
    quickAddReturnFlow = null;
  }
}

// ─── DETAIL MODAL ─────────────────────────────────────
function openDetailModal(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const s = statusOf(item);
  document.getElementById('detail-content').innerHTML = `
    <div class="modal-head">
      <div class="modal-title">${item.name}</div>
      <button class="modal-x" onclick="closeModal('modal-detail')">✕</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span class="mono" style="color:var(--muted)">${item.sku}${item.barcode ? ' · ' + item.barcode : ''}</span>
      <span class="tag ${s}">${statusLabel(s)}</span>
    </div>
    <div style="font-family:var(--font-serif);font-size:40px;line-height:1;margin-bottom:4px">${totalQty(item)}</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:16px">${item.unit} total · low alert at ${item.thresh}</div>
    <div class="divider"></div>
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:10px">Locations</div>
    ${(item.locations || []).map(l => `
      <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">
        <div><div class="mono" style="font-size:13px">${l.loc}</div><div style="font-size:12px;color:var(--muted)">${l.shelf||''}</div></div>
        <div style="font-weight:700">${l.qty} ${item.unit}</div>
      </div>`).join('') || '<div style="color:var(--muted);font-size:13px">No locations yet</div>'}
    <div class="divider"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-primary green" onclick="closeModal('modal-detail');openFlowWithItem('addstock','${id}')">+ Add Stock</button>
      <button class="btn-primary red"   onclick="closeModal('modal-detail');openFlowWithItem('sell','${id}')">Sell / Remove</button>
      <button class="btn-ghost"         onclick="closeModal('modal-detail');openFlowWithItem('move','${id}')">Move</button>
      <button class="btn-ghost"         onclick="toggleSold('${id}');closeModal('modal-detail')">${item.sold ? 'Mark Available' : 'Mark Sold'}</button>
    </div>`;
  openModal('modal-detail');
}

// ─── FLOWS ────────────────────────────────────────────
function openFlow(type) {
  flowState = { type, step: 1, item: null, section: null, shelf: null, qty: 1, location: null, reason: 'Sold/Picked', notes: '', toSection: null, toBay: null };
  openModal('modal-' + type);
  renderFlow(type);
}

function openFlowWithItem(type, id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  flowState = { type, step: 2, item, section: null, shelf: null, qty: 1, location: null, reason: 'Sold/Picked', notes: '', toSection: null, toBay: null };
  openModal('modal-' + type);
  renderFlow(type);
}

function renderFlow(type) {
  if (type === 'addstock') renderAddstock();
  if (type === 'sell')     renderSell();
  if (type === 'move')     renderMove();
}

function stepBar(current, total) {
  let html = '<div class="step-bar">';
  for (let i = 0; i < total; i++) {
    const cls = i < current - 1 ? 'done' : i === current - 1 ? 'active' : '';
    html += `<div class="step-dot ${cls}"></div>`;
  }
  return html + '</div>';
}

function flowHeader(title) {
  return `<div class="modal-head"><div class="modal-title">${title}</div><button class="modal-x" onclick="closeModal('modal-${flowState.type}')">✕</button></div>`;
}

// ── ADD STOCK ──
function renderAddstock() {
  const s = flowState;
  const c = document.getElementById('addstock-content');
  let html = flowHeader('Add Stock') + stepBar(s.step, 4);

  if (s.step === 5) { c.innerHTML = renderSuccess('addstock'); return; }

  if (s.step === 1) {
    html += `<div class="step-label">Step 1 of 4</div><div class="step-title">Find Item</div>
    <div class="scan-zone" id="scan-box-addstock" onclick="startScanner('addstock')">
      <div class="scan-icon-big">▣</div>
      <div class="scan-zone-text">Tap to scan barcode</div>
    </div>
    <div id="addstock-scanner-wrap" style="display:none;margin-bottom:12px">
      <div class="scanner-wrap"><div id="addstock-reader"></div></div>
      <button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner('addstock')">Cancel</button>
    </div>
    <div class="or-row">or type manually</div>
    <div class="form-field"><label>SKU / Barcode</label>
      <div style="display:flex;gap:8px">
        <input id="pa-manual" class="mono" placeholder="e.g. OSB6040Q-20W" onkeydown="if(event.key==='Enter')paLookup()"/>
        <button class="btn-primary" onclick="paLookup()">Find</button>
      </div>
    </div>`;

  } else if (s.step === 2) {
    html += `<div class="step-label">Step 2 of 4</div><div class="step-title">Select Shelf Unit</div>
    <div class="found-box"><div class="found-label">✓ Item Found</div><div class="found-name">${s.item.name}</div><div class="found-sub">${s.item.sku} · ${totalQty(s.item)} ${s.item.unit} in stock</div></div>
    <div class="step-sub">Which shelf unit? e.g. M08A1, M08D4</div>
    <div class="shelf-picker">${buildShelfPicker(s.section, 'paPickShelf')}</div>
    <button class="btn-primary full" style="margin-top:10px" onclick="paGoToBay()" ${!s.section?'disabled':''}>Next →</button>`;

  } else if (s.step === 3) {
    html += `<div class="step-label">Step 3 of 4</div><div class="step-title">Select Bay</div>
    <div class="found-box" style="background:var(--accent-bg);border-color:#BFDBFE"><div class="found-label" style="color:var(--accent)">Selected: ${s.section}</div><div class="found-name">${s.item.name}</div></div>
    <div class="step-sub">Which bay on shelf ${s.section}?</div>
    <div class="bay-picker">${buildBayPicker(s.section, s.shelf, 'paPickBay')}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn-ghost" onclick="flowState.step=2;renderAddstock()">← Back</button>
      <button class="btn-primary" style="flex:1" onclick="paGoToQty()" ${!s.shelf?'disabled':''}>Next →</button>
    </div>`;

  } else if (s.step === 4) {
    const locCode = 'M08' + s.section + s.shelf;
    html += `<div class="step-label">Step 4 of 4</div><div class="step-title">Enter Quantity</div>
    <div class="summary">
      <div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">${s.item.sku}</span></div>
      <div class="summary-row"><span class="sum-label">Shelf</span><span class="sum-val">${s.section}</span></div>
      <div class="summary-row"><span class="sum-label">Bay</span><span class="sum-val">${s.shelf}</span></div>
      <div class="summary-row"><span class="sum-label">Location code</span><span class="sum-val mono">${locCode}</span></div>
    </div>
    <div class="form-field"><label>Quantity to Add</label>
      <div class="qty-row">
        <button class="qty-btn" onclick="adjQty(-1)">−</button>
        <input class="qty-input" id="flow-qty" type="number" value="${s.qty}" min="1" oninput="flowState.qty=parseInt(this.value)||1"/>
        <button class="qty-btn" onclick="adjQty(1)">+</button>
      </div>
    </div>
    <div class="form-field"><label>Notes (optional)</label><textarea id="flow-notes" placeholder="e.g. new stock, batch #…">${s.notes}</textarea></div>
    <div style="display:flex;gap:8px">
      <button class="btn-ghost" onclick="flowState.step=3;renderAddstock()">← Back</button>
      <button class="btn-primary green full" onclick="saveAddstock()">✓ Save Add Stock</button>
    </div>`;
  }

  c.innerHTML = html;
}

function paLookup() {
  const val = document.getElementById('pa-manual').value.trim();
  const item = findItem(val);
  if (!item) { openQuickAdd(val, 'addstock'); return; }
  flowState.item = item; flowState.step = 2; renderAddstock();
}
function paPickShelf(shelf) { flowState.section = shelf; flowState.shelf = null; renderAddstock(); }
function paGoToBay()  { if (!flowState.section) return; flowState.step = 3; renderAddstock(); }
function paPickBay(bay) { flowState.shelf = bay; renderAddstock(); }
function paGoToQty()  { if (!flowState.shelf) return; flowState.step = 4; renderAddstock(); }

async function saveAddstock() {
  const s = flowState;
  s.qty   = parseInt(document.getElementById('flow-qty').value) || 1;
  s.notes = document.getElementById('flow-notes').value;
  const locCode   = s.section + s.shelf;
  const shelfName = s.section + ' ' + s.shelf;
  const ex = (s.item.locations || []).find(l => l.loc === locCode);
  if (ex) ex.qty += s.qty;
  else s.item.locations.push({ loc: locCode, shelf: shelfName, qty: s.qty });
  const entry = { type:'addstock', itemId:s.item.id, itemName:s.item.name, location:locCode, qty:s.qty, notes:s.notes, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  renderAll(); flowState.step = 5; renderAddstock();
}

// ── SELL ──
function renderSell() {
  const s = flowState;
  const c = document.getElementById('sell-content');
  let html = flowHeader('Sell / Remove') + stepBar(s.step, 3);

  if (s.step === 4) { c.innerHTML = renderSuccess('sell'); return; }

  if (s.step === 1) {
    html += `<div class="step-label">Step 1 of 3</div><div class="step-title">Find Item</div>
    <div class="scan-zone" onclick="startScanner('sell')"><div class="scan-icon-big">▣</div><div class="scan-zone-text">Tap to scan barcode</div></div>
    <div id="sell-scanner-wrap" style="display:none;margin-bottom:12px">
      <div class="scanner-wrap"><div id="sell-reader"></div></div>
      <button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner('sell')">Cancel</button>
    </div>
    <div class="or-row">or type manually</div>
    <div class="form-field"><label>SKU / Barcode</label>
      <div style="display:flex;gap:8px">
        <input id="sell-manual" class="mono" placeholder="SKU or barcode…" onkeydown="if(event.key==='Enter')sellLookup()"/>
        <button class="btn-primary" onclick="sellLookup()">Find</button>
      </div>
    </div>`;

  } else if (s.step === 2) {
    const locs = (s.item.locations || []).filter(l => l.qty > 0);
    html += `<div class="step-label">Step 2 of 3</div><div class="step-title">Choose Location</div>
    <div class="found-box"><div class="found-label">✓ Item Found</div><div class="found-name">${s.item.name}</div><div class="found-sub">${s.item.sku} · Total: ${totalQty(s.item)} ${s.item.unit}</div></div>
    ${locs.map(l => `
      <div class="loc-option ${s.location === l.loc ? 'sel' : ''}" onclick="sellSelectLoc('${l.loc}')">
        <div class="loc-radio"><div class="loc-dot"></div></div>
        <div class="loc-name">${l.loc}</div>
        <div class="loc-qty">${l.qty} ${s.item.unit}</div>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No stock in any location</p>'}
    <button class="btn-primary full" style="margin-top:10px" onclick="sellStep3()" ${!s.location?'disabled':''}>Next →</button>`;

  } else if (s.step === 3) {
    const locObj = (s.item.locations || []).find(l => l.loc === s.location);
    html += `<div class="step-label">Step 3 of 3</div><div class="step-title">Quantity &amp; Reason</div>
    <div class="summary">
      <div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">${s.item.sku}</span></div>
      <div class="summary-row"><span class="sum-label">Location</span><span class="sum-val mono">${s.location}</span></div>
      <div class="summary-row"><span class="sum-label">Available</span><span class="sum-val">${locObj ? locObj.qty : 0} ${s.item.unit}</span></div>
    </div>
    <div class="form-field"><label>Quantity to Remove</label>
      <div class="qty-row">
        <button class="qty-btn" onclick="adjQty(-1)">−</button>
        <input class="qty-input" id="flow-qty" type="number" value="${s.qty}" min="1" oninput="flowState.qty=parseInt(this.value)||1"/>
        <button class="qty-btn" onclick="adjQty(1)">+</button>
      </div>
    </div>
    <div class="form-field"><label>Reason</label>
      <div class="reason-list">
        ${['Sold/Picked','Damaged','Return to Vendor','Adjustment'].map(r => `
          <div class="reason-opt ${s.reason === r ? 'sel' : ''}" onclick="sellReason('${r}')">
            <div class="loc-radio"><div class="loc-dot"></div></div>
            ${r}
          </div>`).join('')}
      </div>
    </div>
    <div class="form-field"><label>Notes (optional)</label><textarea id="flow-notes" placeholder="Notes…">${s.notes}</textarea></div>
    <div style="display:flex;gap:8px">
      <button class="btn-ghost" onclick="flowState.step=2;renderSell()">← Back</button>
      <button class="btn-primary red full" onclick="saveSell()">Confirm Remove</button>
    </div>`;
  }

  c.innerHTML = html;
}

function sellLookup() {
  const val = document.getElementById('sell-manual').value.trim();
  const item = findItem(val);
  if (!item) { openQuickAdd(val, 'sell'); return; }
  flowState.item = item; flowState.step = 2; renderSell();
}
function sellSelectLoc(loc) { flowState.location = loc; renderSell(); }
function sellStep3() { if (!flowState.location) return; flowState.step = 3; renderSell(); }
function sellReason(r) { flowState.reason = r; renderSell(); }

async function saveSell() {
  const s = flowState;
  s.qty   = parseInt(document.getElementById('flow-qty').value) || 1;
  s.notes = document.getElementById('flow-notes').value;
  const loc = (s.item.locations || []).find(l => l.loc === s.location);
  if (loc) loc.qty = Math.max(0, loc.qty - s.qty);
  s.item.locations = (s.item.locations || []).filter(l => l.qty > 0);
  const entry = { type:'sell', itemId:s.item.id, itemName:s.item.name, location:s.location, qty:s.qty, reason:s.reason, notes:s.notes, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  renderAll(); flowState.step = 4; renderSell();
}

// ── MOVE ──
function renderMove() {
  const s = flowState;
  const c = document.getElementById('move-content');
  let html = flowHeader('Move Stock') + stepBar(s.step, 3);

  if (s.step === 4) { c.innerHTML = renderSuccess('move'); return; }

  if (s.step === 1) {
    html += `<div class="step-label">Step 1 of 3</div><div class="step-title">Find Item</div>
    <div class="scan-zone" onclick="startScanner('move')"><div class="scan-icon-big">▣</div><div class="scan-zone-text">Tap to scan barcode</div></div>
    <div id="move-scanner-wrap" style="display:none;margin-bottom:12px">
      <div class="scanner-wrap"><div id="move-reader"></div></div>
      <button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner('move')">Cancel</button>
    </div>
    <div class="or-row">or type manually</div>
    <div class="form-field"><label>SKU / Barcode</label>
      <div style="display:flex;gap:8px">
        <input id="move-manual" class="mono" placeholder="SKU…" onkeydown="if(event.key==='Enter')moveLookup()"/>
        <button class="btn-primary" onclick="moveLookup()">Find</button>
      </div>
    </div>`;

  } else if (s.step === 2) {
    const locs = (s.item.locations || []).filter(l => l.qty > 0);
    html += `<div class="step-label">Step 2 of 3</div><div class="step-title">From Location</div>
    <div class="found-box"><div class="found-label">✓ Item Found</div><div class="found-name">${s.item.name}</div><div class="found-sub">${s.item.sku}</div></div>
    ${locs.map(l => `
      <div class="loc-option ${s.location === l.loc ? 'sel' : ''}" onclick="moveFrom('${l.loc}')">
        <div class="loc-radio"><div class="loc-dot"></div></div>
        <div class="loc-name">${l.loc}</div>
        <div class="loc-qty">${l.qty} ${s.item.unit}</div>
      </div>`).join('')}
    <button class="btn-primary full" style="margin-top:10px" onclick="moveStep3()" ${!s.location?'disabled':''}>Next →</button>`;

  } else if (s.step === 3) {
    const from = (s.item.locations || []).find(l => l.loc === s.location);
    html += `<div class="step-label">Step 3 of 3</div><div class="step-title">Move To</div>
    <div class="summary"><div class="summary-row"><span class="sum-label">Moving from</span><span class="sum-val mono">${s.location}</span></div></div>
    <div class="form-field"><label>Destination Shelf</label>
      <div class="shelf-picker">${buildShelfPicker(s.toSection, 'movePickShelf')}</div>
    </div>
    ${s.toSection ? `<div class="form-field"><label>Destination Bay</label><div class="bay-picker">${buildBayPicker(s.toSection, s.toBay, 'movePickBay')}</div></div>` : ''}
    <div class="form-field"><label>Quantity to Move</label>
      <div class="qty-row">
        <button class="qty-btn" onclick="adjQty(-1)">−</button>
        <input class="qty-input" id="flow-qty" type="number" value="${s.qty}" min="1" max="${from ? from.qty : 99}" oninput="flowState.qty=parseInt(this.value)||1"/>
        <button class="qty-btn" onclick="adjQty(1)">+</button>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-ghost" onclick="flowState.step=2;renderMove()">← Back</button>
      <button class="btn-primary full" onclick="saveMove()" ${(!s.toSection||!s.toBay)?'disabled':''}>Confirm Move</button>
    </div>`;
  }

  c.innerHTML = html;
}

function moveLookup() {
  const val = document.getElementById('move-manual').value.trim();
  const item = findItem(val);
  if (!item) { openQuickAdd(val, 'move'); return; }
  flowState.item = item; flowState.step = 2; renderMove();
}
function moveFrom(loc) { flowState.location = loc; renderMove(); }
function moveStep3()    { if (!flowState.location) return; flowState.step = 3; renderMove(); }
function movePickShelf(shelf) { flowState.toSection = shelf; flowState.toBay = null; renderMove(); }
function movePickBay(bay)     { flowState.toBay = bay; renderMove(); }

async function saveMove() {
  const s = flowState;
  s.qty = parseInt(document.getElementById('flow-qty').value) || 1;
  const toCode = s.toSection + s.toBay;
  if (!toCode) { showToast('Select destination', 'err'); return; }
  const from = (s.item.locations || []).find(l => l.loc === s.location);
  if (from) from.qty = Math.max(0, from.qty - s.qty);
  const to = (s.item.locations || []).find(l => l.loc === toCode);
  if (to) to.qty += s.qty;
  else s.item.locations.push({ loc: toCode, shelf: s.toSection + ' ' + s.toBay, qty: s.qty });
  s.item.locations = (s.item.locations || []).filter(l => l.qty > 0);
  const entry = { type:'move', itemId:s.item.id, itemName:s.item.name, location:s.location + ' → ' + toCode, qty:s.qty, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  renderAll(); flowState.step = 4; renderMove();
}

// ── SUCCESS ──
function renderSuccess(type) {
  const s = flowState;
  const map = {
    addstock: { icon:'✅', title:'Stock Added!', btn:'Add More Stock', next:'openFlow(\'addstock\')' },
    sell:     { icon:'✅', title:'Removed!',     btn:'Remove Another', next:'openFlow(\'sell\')' },
    move:     { icon:'✅', title:'Moved!',       btn:'Move Another',   next:'openFlow(\'move\')' }
  };
  const m = map[type];
  return `<div class="success-box">
    <div class="success-mark">${m.icon}</div>
    <div class="success-title">${m.title}</div>
    <div class="success-sub">Inventory updated and synced</div>
    <div class="summary" style="text-align:left">
      ${s.item ? `<div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">${s.item.sku}</span></div>` : ''}
      ${s.location ? `<div class="summary-row"><span class="sum-label">Location</span><span class="sum-val mono">${s.location}</span></div>` : ''}
      ${s.qty ? `<div class="summary-row"><span class="sum-label">Quantity</span><span class="sum-val ${type==='sell'?'red':'green'}">${type==='sell'?'−':'+'}${s.qty}</span></div>` : ''}
      ${s.reason ? `<div class="summary-row"><span class="sum-label">Reason</span><span class="sum-val">${s.reason}</span></div>` : ''}
    </div>
    <div class="success-btns">
      <button class="btn-primary full" onclick="${m.next}">${m.btn}</button>
      <button class="btn-ghost full" onclick="closeModal('modal-${type}')">Done</button>
    </div>
  </div>`;
}

// ── SHARED FLOW HELPERS ──
function adjQty(d) {
  flowState.qty = Math.max(1, (flowState.qty || 1) + d);
  const el = document.getElementById('flow-qty');
  if (el) el.value = flowState.qty;
}

function buildShelfPicker(selected, fn) {
  const shelves = getAllShelves();
  // Group by zone then aisle for display
  let html = '';
  const byZone = {};
  shelves.forEach(s => {
    if (!byZone[s.zone]) byZone[s.zone] = {};
    if (!byZone[s.zone][s.aisle]) byZone[s.zone][s.aisle] = [];
    byZone[s.zone][s.aisle].push(s);
  });
  const aisleColors = { A:'A', B:'B', C:'C', D:'D' };
  for (const [zone, aisles] of Object.entries(byZone)) {
    html += '<div style="margin-bottom:10px">';
    html += '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;color:var(--muted2);text-transform:uppercase;margin-bottom:6px">' + zone + '</div>';
    html += '<div class="shelf-picker">';
    for (const [aisle, shelfList] of Object.entries(aisles)) {
      shelfList.forEach(s => {
        const a = aisleColors[aisle] || '';
        const sel = selected === s.code ? 'sel' : '';
        html += '<button class="shelf-btn ' + a + ' ' + sel + '" onclick="' + fn + '(' + JSON.stringify(s.code) + ')">' + s.code + '</button>';
      });
    }
    html += '</div></div>';
  }
  return html;
}

function buildBayPicker(shelfCode, selected, fn) {
  const bays = getBaysForShelf(shelfCode);
  return bays.map(b => {
    const sel = selected === b ? 'sel' : '';
    return '<button class="bay-btn ' + sel + '" onclick="' + fn + '(' + JSON.stringify(b) + ')">' + b + '</button>';
  }).join('');
}

// ─── SCANNERS ─────────────────────────────────────────
async function startScanner(id) {
  const wrap = document.getElementById(id + '-scanner-wrap');
  const box  = document.getElementById('scan-box-' + id);
  if (!wrap) return;
  wrap.style.display = 'block';
  if (box) box.style.display = 'none';
  try {
    const qr = new Html5Qrcode(id + '-reader');
    scanners[id] = qr;
    await qr.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 120 } },
      code => { stopScanner(id); handleScan(id, code); },
      () => {}
    );
  } catch(e) {
    showToast('Camera not available', 'err');
    if (wrap) wrap.style.display = 'none';
    if (box)  box.style.display = 'block';
  }
}

async function stopScanner(id) {
  const qr = scanners[id];
  if (qr) { try { await qr.stop(); } catch(e){} try { qr.clear(); } catch(e){} delete scanners[id]; }
  const wrap = document.getElementById(id + '-scanner-wrap');
  const box  = document.getElementById('scan-box-' + id);
  if (wrap) wrap.style.display = 'none';
  if (box)  box.style.display = 'block';
}

function handleScan(id, code) {
  showToast('Scanned: ' + code);
  const item = findItem(code);
  if (id === 'addstock') {
    if (item) { flowState.item = item; flowState.step = 2; renderAddstock(); }
    else { closeModal('modal-addstock'); openQuickAdd(code, 'addstock'); }
  } else if (id === 'sell') {
    if (item) { flowState.item = item; flowState.step = 2; renderSell(); }
    else { closeModal('modal-sell'); openQuickAdd(code, 'sell'); }
  } else if (id === 'move') {
    if (item) { flowState.item = item; flowState.step = 2; renderMove(); }
    else { closeModal('modal-move'); openQuickAdd(code, 'move'); }
  } else if (id === 'additem') {
    const isNum = /^\d+$/.test(code);
    if (isNum) document.getElementById('ai-barcode').value = code;
    else       document.getElementById('ai-sku').value = code;
    stopScanner('additem');
    if (item) showToast('Already exists: ' + item.sku, 'err');
    else showToast(isNum ? 'Barcode filled' : 'SKU filled', 'ok');
  }
}

// ─── NAVIGATION ───────────────────────────────────────
function showPage(name) {
  Object.values(scanners).forEach((_, id) => stopScanner(id));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (page) page.classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-page="${name}"]`);
  if (btn) btn.classList.add('active');
  const titles = { dashboard:'Dashboard', inventory:'Inventory', map:'Warehouse Map', activity:'Activity Log' };
  document.getElementById('page-title').textContent = titles[name] || '';
  closeSidebar();
  if (name === 'inventory') renderInvTable();
  if (name === 'activity')  renderActivity();
  if (name === 'map')       renderMap();
  if (name === 'dashboard') renderAll();
}

// Wire nav buttons
document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ─── MODALS ───────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.getElementById(id).style.display = 'flex';
}
function closeModal(id) {
  Object.keys(scanners).forEach(k => stopScanner(k));
  document.getElementById(id).classList.remove('open');
  document.getElementById(id).style.display = '';
}
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); });
});

// ─── TOAST ────────────────────────────────────────────
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2800);
}