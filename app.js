// ══════════════════════════════════════════════════════
// WAREHOUSE IMS — app.js  (clean rewrite)
// ══════════════════════════════════════════════════════

// ─── PIN AUTH ────────────────────────────────────────
const CORRECT_PIN = '%%APP_PIN%%';;
const SESSION_KEY = 'wh_unlocked';

function pinEnter() {
  var input = document.getElementById('pin-input');
  var val   = input ? input.value : '';
  if (val === CORRECT_PIN) {
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('loading-screen').style.display = 'flex';
    initApp();
  } else {
    var err = document.getElementById('pin-error');
    if (err) err.textContent = 'Incorrect password — try again';
    if (input) {
      input.value = '';
      input.classList.add('shake');
      setTimeout(function() { input.classList.remove('shake'); }, 400);
      input.focus();
    }
  }
}

// Auto-unlock if session still active
(function() {
  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('loading-screen').style.display = 'flex';
    setTimeout(function() { initApp(); }, 500);
  }
})();

// ─── STATE ───────────────────────────────────────────
var sbClient     = null;
var items        = [];
var activityLog  = [];
var invFilter    = 'all';
var actFilter    = 'all';
var flowState    = {};
var scanners     = {};
var quickAddReturnFlow = null;

// ─── WAREHOUSE ZONES ─────────────────────────────────
var ZONES = {
  M08: {
    label: 'M08',
    aisles: {
      A: { rows: ['1','2','3','4'], bays: ['#01','#02'] },
      B: { rows: ['1','2','3','4'], bays: ['#01','#02'] },
      C: { rows: ['1','2','3','4'], bays: ['#01','#02','#03','#04'] },
      D: { rows: ['1','2','3','4'], bays: ['#01','#02','#03','#04'] }
    }
  }
  // Add more zones here:
  // M07: { label:'M07', aisles: { A: { rows:['1','2','3','4'], bays:['#01','#02'] } } }
};

function getAllShelves() {
  var shelves = [];
  Object.keys(ZONES).forEach(function(zone) {
    var zdata = ZONES[zone];
    Object.keys(zdata.aisles).forEach(function(aisle) {
      var adata = zdata.aisles[aisle];
      adata.rows.forEach(function(row) {
        shelves.push({ code: zone + aisle + row, zone: zone, aisle: aisle, row: row, bays: adata.bays });
      });
    });
  });
  return shelves;
}

function getBaysForShelf(shelfCode) {
  var zones = Object.keys(ZONES);
  for (var zi = 0; zi < zones.length; zi++) {
    var zone  = zones[zi];
    var zdata = ZONES[zone];
    var aisles = Object.keys(zdata.aisles);
    for (var ai = 0; ai < aisles.length; ai++) {
      var aisle = aisles[ai];
      if (shelfCode.startsWith(zone + aisle)) {
        return zdata.aisles[aisle].bays;
      }
    }
  }
  return ['#01','#02'];
}

// ─── HELPERS ─────────────────────────────────────────
function totalQty(item) {
  return (item.locations || []).reduce(function(s, l) { return s + (l.qty || 0); }, 0);
}

function statusOf(item) {
  if (item.sold) return 'sold';
  return totalQty(item) <= 0 ? 'out' : 'in';
}

function statusLabel(s) {
  return { in:'In Stock', out:'Out of Stock', sold:'Sold' }[s] || s;
}

function actColor(t) {
  return { addstock:'#16A34A', sell:'#DC2626', move:'#1A6BFF', adjust:'#D97706' }[t] || '#8A8A86';
}

function actLabel(t) {
  return { addstock:'Add Stock', sell:'Sell/Remove', move:'Move', adjust:'Adjust' }[t] || t;
}

function timeAgo(ts) {
  var s = Math.floor((Date.now() - ts) / 1000);
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
  var q = val.toLowerCase().trim();
  return items.find(function(i) {
    return i.sku.toLowerCase() === q ||
      (i.barcode && i.barcode === q) ||
      i.sku.toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q) ||
      (i.barcode && i.barcode.includes(q));
  });
}

function e(id) { return document.getElementById(id); }
function val(id) { var el = e(id); return el ? el.value.trim() : ''; }

// ─── DATABASE ─────────────────────────────────────────
async function dbSaveItem(item) {
  if (!sbClient) return;
  var payload = {
    name: item.name, sku: item.sku, barcode: item.barcode || '',
    unit: item.unit, thresh: item.thresh, sold: item.sold,
    locations: item.locations, notes: item.notes || ''
  };
  if (item.id && item.id.length > 8) {
    await sbClient.from('items').update(payload).eq('id', item.id);
  } else {
    var res = await sbClient.from('items').insert(payload).select().single();
    if (res.data) item.id = res.data.id;
  }
}

async function dbLogActivity(entry) {
  if (!sbClient) return;
  await sbClient.from('activity').insert({
    type: entry.type, item_id: entry.itemId, item_name: entry.itemName,
    location: entry.location, qty: entry.qty,
    reason: entry.reason || '', notes: entry.notes || ''
  });
}

async function loadData() {
  var results = await Promise.all([
    sbClient.from('items').select('*').order('created_at', { ascending: false }),
    sbClient.from('activity').select('*').order('ts', { ascending: false }).limit(150)
  ]);
  if (results[0].error) throw results[0].error;
  items = (results[0].data || []).map(function(r) {
    return {
      id: r.id, name: r.name, sku: r.sku,
      barcode: r.barcode || '', unit: r.unit || 'pcs',
      thresh: r.thresh || 5, sold: r.sold || false,
      locations: r.locations || [], notes: r.notes || ''
    };
  });
  activityLog = (results[1].data || []).map(function(r) {
    return {
      id: r.id, type: r.type, itemId: r.item_id,
      itemName: r.item_name, location: r.location,
      qty: r.qty, reason: r.reason, notes: r.notes,
      ts: new Date(r.ts).getTime()
    };
  });
}

// ─── INIT ─────────────────────────────────────────────
async function initApp() {
  // Wait for Supabase CDN library to be ready
  var waited = 0;
  while (!window.supabase && waited < 10000) {
    await new Promise(function(r) { setTimeout(r, 200); });
    waited += 200;
  }
  if (!window.supabase) {
    e('loading-status').textContent = '⚠ Failed to load Supabase library — check internet connection';
    showRetryBtn();
    return;
  }
  var cfg = { url: '%%SUPABASE_URL%%', key: '%%SUPABASE_KEY%%' };
  sbClient = window.supabase.createClient(cfg.url, cfg.key);
  setTimeout(function() { attemptConnect(1); }, 300);
}

async function attemptConnect(attempt) {
  var maxAttempts = 20;
  var dotStates = ['', '.', '..', '...'];

  try {
    if (attempt === 1) {
      e('loading-status').textContent = 'Connecting…';
    } else {
      e('loading-status').textContent = 'Waking up database' + dotStates[attempt % 4] + ' (' + attempt + '/' + maxAttempts + ')';
    }

    var check = await sbClient.from('items').select('id').limit(1);
    if (check.error) throw check.error;

    // Success!
    e('loading-status').textContent = 'Loading inventory…';
    await loadData();
    e('loading-screen').classList.add('fade-out');
    e('app').classList.remove('hidden');
    setTimeout(function() { e('loading-screen').style.display = 'none'; }, 400);
    renderAll();

  } catch(err) {
    var msg = err.message || String(err);

    // Hard credential error — don't retry
    if (msg.includes('apikey') || msg.includes('JWT') || msg.includes('401') || msg.includes('403')) {
      e('loading-status').textContent = '⚠ API key error — check Vercel environment variables';
      showRetryBtn();
      return;
    }

    // Keep retrying — never give up
    var delay = attempt <= 2 ? 2000 : attempt <= 6 ? 3000 : 5000;
    if (attempt < maxAttempts) {
      setTimeout(function() { attemptConnect(attempt + 1); }, delay);
    } else {
      // Auto reload and try again
      e('loading-status').textContent = 'Reloading automatically…';
      setTimeout(function() { location.reload(); }, 3000);
    }
  }
}

function showRetryBtn() {
  var inner = document.querySelector('.loading-inner');
  if (!inner || inner.querySelector('.retry-btn')) return;

  var btn = document.createElement('button');
  btn.className = 'retry-btn';
  btn.style.cssText = 'margin-top:20px;padding:12px 28px;background:#1A1A18;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:-0.01em;min-width:180px';
  btn.onclick = function() { location.reload(); };
  inner.appendChild(btn);

  // Auto-countdown and reload
  var secs = 8;
  function tick() {
    btn.textContent = '↺ Retrying in ' + secs + 's…';
    if (secs <= 0) {
      btn.textContent = '↺ Retrying…';
      location.reload();
      return;
    }
    secs--;
    setTimeout(tick, 1000);
  }
  tick();
}

// ─── RENDER ALL ───────────────────────────────────────
function renderAll() {
  renderStats();
  renderDashRecentItems();
  renderDashActivity();
  renderInvTable();
  renderActivity();
  renderMap();
  var low = items.filter(function(i) { return statusOf(i) === 'out'; }).length;
  var badge = e('nav-low-badge');
  if (badge) { badge.textContent = low; badge.classList.toggle('hidden', low === 0); }
}

function renderStats() {
  var locs = new Set(items.flatMap(function(i) { return (i.locations || []).map(function(l) { return l.loc; }); })).size;
  e('stat-total').textContent = items.length;
  e('stat-out').textContent   = items.filter(function(i) { return statusOf(i) === 'out'; }).length;
  e('stat-locs').textContent  = locs;
}

function renderDashAlerts() {}

function renderDashRecentItems() {
  var el = e('dash-recent-items');
  if (!el) return;
  var recent = items.slice(0, 8);
  if (!recent.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📦</div>No items yet</div>';
    return;
  }
  el.innerHTML = recent.map(function(i) {
    var s = statusOf(i);
    return '<div class="dash-item-row" onclick="openDetailModal(\'' + i.id + '\')">' +
      '<div class="dash-item-info">' +
        '<div class="dash-item-name">' + i.name + '</div>' +
        '<div class="dash-item-meta">' + i.sku + (i.barcode ? ' · ' + i.barcode : '') + '</div>' +
        (i.notes ? '<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:2px">' + i.notes + '</div>' : '') +
      '</div>' +
      '<div class="dash-item-right">' +
        '<div class="dash-item-qty">' + totalQty(i) + ' <span>' + i.unit + '</span></div>' +
        '<span class="tag ' + s + '">' + statusLabel(s) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderDashActivity() {
  var el = e('dash-activity');
  if (!el) return;
  if (!activityLog.length) { el.innerHTML = '<div class="empty">No activity yet</div>'; return; }
  el.innerHTML = activityLog.slice(0, 8).map(function(a) {
    var item = items.find(function(i) { return i.id === a.itemId; });
    var sku = item ? item.sku : '';
    var meta = [sku, a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ');
    return '<div class="act-row">' +
      '<div class="act-dot" style="background:' + actColor(a.type) + '"></div>' +
      '<div class="act-body">' +
      '<div class="act-title">' + actLabel(a.type) + ' · ' + sku + '</div>' +
      '<div class="act-meta">' + (a.itemName || '') + ' · ' + [a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ') + '</div>' +
        (a.notes ? '<div class="act-notes">' + a.notes + '</div>' : '') +
      '</div>' +
      '<div class="act-time">' + timeAgo(a.ts) + '</div>' +
    '</div>';
  }).join('');
}

// ─── INVENTORY ────────────────────────────────────────
function renderInvTable(subset) {
  var src = subset || (invFilter === 'all' ? items : items.filter(function(i) { return statusOf(i) === invFilter; }));
  var tbody = e('inv-tbody');
  var cardEl = e('inv-cards');

  if (!src.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-icon">📦</div>No items found</div></td></tr>';
    if (cardEl) cardEl.innerHTML = '<div class="empty"><div class="empty-icon">📦</div>No items found</div>';
    return;
  }

  // Mobile cards
  if (cardEl) {
    cardEl.innerHTML = src.map(function(item) {
      var s = statusOf(item);
      var locs = (item.locations || []).map(function(l) { return '<span class="loc-chip">' + l.loc + ' (' + l.qty + ')</span>'; }).join('');
      return '<div class="inv-card" onclick="openDetailModal(\'' + item.id + '\')">' +
        '<div class="inv-card-top">' +
          '<div class="inv-card-info">' +
            '<div class="inv-card-name">' + item.name + '</div>' +
            '<div class="inv-card-sku">' + item.sku + (item.barcode ? ' · ' + item.barcode : '') + '</div>' +
          '</div>' +
          '<span class="tag ' + s + '">' + statusLabel(s) + '</span>' +
        '</div>' +
        '<div class="inv-card-mid">' +
          '<div class="inv-card-qty"><strong>' + totalQty(item) + '</strong> ' + item.unit + '</div>' +
          '<div class="loc-chips">' + (locs || '<span style="color:var(--muted2)">No location</span>') + '</div>' +
        '</div>' +
        '<div class="inv-card-actions">' +
          '<button class="inv-act-btn green" onclick="event.stopPropagation();openFlowWithItem(\'addstock\',\'' + item.id + '\')">+ Add</button>' +
          '<button class="inv-act-btn red"   onclick="event.stopPropagation();openFlowWithItem(\'sell\',\'' + item.id + '\')">− Sell</button>' +
          '<button class="inv-act-btn"       onclick="event.stopPropagation();openEditModal(\'' + item.id + '\')">Edit</button>' +
          '<button class="inv-act-btn gray"  onclick="event.stopPropagation();toggleSold(\'' + item.id + '\')">' + (item.sold ? 'Unmark' : 'Sold') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Desktop table
  if (tbody) {
    tbody.innerHTML = src.map(function(item) {
      var s = statusOf(item);
      var locs = (item.locations || []).map(function(l) { return '<span class="loc-chip">' + l.loc + ' (' + l.qty + ')</span>'; }).join('') || '<span style="color:var(--muted2)">—</span>';
      return '<tr>' +
        '<td><div class="td-name">' + item.name + '</div><div class="td-sub">' + item.unit + ' · alert at ' + item.thresh + '</div></td>' +
        '<td><span class="mono">' + item.sku + '</span></td>' +
        '<td><span class="mono">' + (item.barcode || '—') + '</span></td>' +
        '<td><span class="tag ' + s + '">' + statusLabel(s) + '</span></td>' +
        '<td><strong>' + totalQty(item) + '</strong> <span style="color:var(--muted)">' + item.unit + '</span></td>' +
        '<td><div class="loc-chips">' + locs + '</div></td>' +
        '<td><div class="td-actions">' +
          '<button class="tbl-btn g" onclick="openFlowWithItem(\'addstock\',\'' + item.id + '\')">+</button>' +
          '<button class="tbl-btn r" onclick="openFlowWithItem(\'sell\',\'' + item.id + '\')">−</button>' +
          '<button class="tbl-btn"   onclick="openDetailModal(\'' + item.id + '\')">Detail</button>' +
          '<button class="tbl-btn"   onclick="openEditModal(\'' + item.id + '\')">Edit</button>' +
          '<button class="tbl-btn"   onclick="toggleSold(\'' + item.id + '\')">' + (item.sold ? 'Unmark' : 'Sold') + '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }
}

function setInvFilter(f, btn) {
  invFilter = f;
  document.querySelectorAll('#page-inventory .pill').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderInvTable();
}

function globalSearch(v) {
  if (!v.trim()) { renderInvTable(); return; }
  var terms = v.toLowerCase().trim().split(/\s+/);
  var results = items.filter(function(item) {
    var hay = [item.name, item.sku, item.barcode || '',
      (item.locations || []).map(function(l) { return l.loc; }).join(' '),
      statusLabel(statusOf(item)), item.unit
    ].join(' ').toLowerCase();
    return terms.every(function(t) { return hay.includes(t); });
  });
  showPage('inventory');
  renderInvTable(results);
}

// ─── ACTIVITY ─────────────────────────────────────────
function renderActivity() {
  var src = actFilter === 'all' ? activityLog : activityLog.filter(function(a) { return a.type === actFilter; });
  var el = e('activity-list');
  if (!el) return;
  if (!src.length) { el.innerHTML = '<div class="empty">No activity yet</div>'; return; }
  el.innerHTML = src.slice(0, 100).map(function(a) {
    var item = items.find(function(i) { return i.id === a.itemId; });
    var sku = item ? item.sku : '';
    var meta = [sku, a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ');
    var date = new Date(a.ts).toLocaleString();
    return '<div class="act-row">' +
      '<div class="act-dot" style="background:' + actColor(a.type) + '"></div>' +
      '<div class="act-body">' +
      '<div class="act-title">' + actLabel(a.type) + ' · ' + sku + '</div>' +
      '<div class="act-meta">' + (a.itemName || '') + ' · ' + [a.location, a.qty ? a.qty + ' pcs' : '', a.reason].filter(Boolean).join(' · ') + '</div>' +
        (a.notes ? '<div class="act-notes">' + a.notes + '</div>' : '') +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div class="act-time">' + timeAgo(a.ts) + '</div>' +
        '<div style="font-size:10px;color:var(--muted2);margin-top:2px">' + date + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function setActFilter(f, btn) {
  actFilter = f;
  document.querySelectorAll('#page-activity .pill').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderActivity();
}

// ─── MAP ──────────────────────────────────────────────
function renderMap() {
  var el = e('map-grid');
  if (!el) return;

  var CELL_W_AB = 200, CELL_W_C = 44, CELL_W_D = 170, CELL_H = 44, CELL_H_C = 80;

  function cellClass(loc) {
    var qty = items.flatMap(function(i) {
      return (i.locations || []).filter(function(l) { return l.loc === loc; });
    }).reduce(function(s, l) { return s + l.qty; }, 0);
    return { qty: qty, cls: qty > 0 ? 'has' : '' };
  }

  function makeCell(loc, w, h) {
    var info = cellClass(loc);
    return '<div class="map-cell ' + info.cls + '" style="width:' + w + 'px;height:' + h + 'px" onclick="mapCellClick(\'' + loc + '\')" title="' + loc + '">' +
      '<div class="map-cell-loc">' + loc + '</div>' +
      '<div class="map-cell-qty">' + (info.qty || '·') + '</div>' +
    '</div>';
  }

  function bayLabels(bays, cellW) {
    return '<div class="map-bay-labels">' + bays.map(function(b) {
      return '<div class="map-bay-label" style="width:' + cellW + 'px">' + b + '</div>';
    }).join('') + '</div>';
  }

  var html = '<div style="display:flex;gap:28px;flex-wrap:nowrap;margin-bottom:20px">';

  // A
  html += '<div><div class="map-section-label" style="margin-bottom:8px">A</div>';
  html += bayLabels(['#01','#02'], CELL_W_AB);
  ['4','3','2','1'].forEach(function(row) {
    html += '<div class="map-row"><div class="map-row-label">A' + row + '</div>';
    ['#01','#02'].forEach(function(bay) { html += makeCell('M08A' + row + bay, CELL_W_AB, CELL_H); });
    html += '</div>';
  });
  html += '</div>';

  // B
  html += '<div><div class="map-section-label" style="margin-bottom:8px">B</div>';
  html += bayLabels(['#01','#02'], CELL_W_AB);
  ['4','3','2','1'].forEach(function(row) {
    html += '<div class="map-row"><div class="map-row-label">B' + row + '</div>';
    ['#01','#02'].forEach(function(bay) { html += makeCell('M08B' + row + bay, CELL_W_AB, CELL_H); });
    html += '</div>';
  });
  html += '</div>';

  // C (side access)
  html += '<div style="margin-left:60px"><div class="map-section-label" style="margin-bottom:8px">C <span style="font-size:11px;font-weight:400;color:var(--muted)">(side)</span></div>';
  html += bayLabels(['C1','C2','C3','C4'], CELL_W_C);
  ['#01','#02','#03','#04'].forEach(function(row) {
    html += '<div class="map-row"><div class="map-row-label">' + row + '</div>';
    ['C1','C2','C3','C4'].forEach(function(col) { html += makeCell('M08' + col + row, CELL_W_C, CELL_H_C); });
    html += '</div>';
  });
  html += '</div>';
  html += '</div>';

  // Walking aisle
  html += '<div class="map-aisle-gap"><div class="map-aisle-gap-line"></div><div class="map-aisle-gap-text">— walking aisle —</div><div class="map-aisle-gap-line"></div></div>';

  // D
  html += '<div><div class="map-section-label" style="margin-bottom:8px">D</div>';
  html += bayLabels(['#01','#02','#03','#04'], CELL_W_D);
  ['4','3','2','1'].forEach(function(row) {
    html += '<div class="map-row"><div class="map-row-label">D' + row + '</div>';
    ['#01','#02','#03','#04'].forEach(function(bay) { html += makeCell('M08D' + row + bay, CELL_W_D, CELL_H); });
    html += '</div>';
  });
  html += '<div style="text-align:center;font-size:11px;color:var(--muted2);margin-top:10px;letter-spacing:0.06em">▼ ENTRANCE</div>';
  html += '</div>';

  el.innerHTML = html;
}

function mapCellClick(loc) {
  var here = items.filter(function(i) {
    return (i.locations || []).some(function(l) { return l.loc === loc; });
  });

  // Build the entire modal using DOM — no innerHTML string issues
  var container = e('detail-content');
  container.innerHTML = '';

  // Header
  var head = document.createElement('div');
  head.className = 'modal-head';
  var titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = loc;
  var closeBtn = document.createElement('button');
  closeBtn.className = 'modal-x';
  closeBtn.textContent = '✕';
  closeBtn.onclick = function() { closeModal('modal-detail'); };
  head.appendChild(titleEl);
  head.appendChild(closeBtn);
  container.appendChild(head);

  if (!here.length) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.padding = '24px 0';
    empty.innerHTML = '<div class="empty-icon">📭</div>This shelf is empty';
    container.appendChild(empty);
  } else {
    var countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:12px';
    countEl.textContent = here.length + ' product' + (here.length > 1 ? 's' : '') + ' stored here';
    container.appendChild(countEl);

    here.forEach(function(item) {
      var locData = (item.locations || []).find(function(l) { return l.loc === loc; });
      var qty = locData ? locData.qty : 0;
      var s = statusOf(item);

      // Item info row
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)';

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      var nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:2px';
      nameEl.textContent = item.name;
      var skuEl = document.createElement('div');
      skuEl.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--muted)';
      skuEl.textContent = item.sku + (item.barcode ? ' · ' + item.barcode : '');
      info.appendChild(nameEl);
      info.appendChild(skuEl);

      var qtyBox = document.createElement('div');
      qtyBox.style.cssText = 'text-align:right;flex-shrink:0';
      var qtyNum = document.createElement('div');
      qtyNum.style.cssText = 'font-size:22px;font-weight:800;line-height:1';
      qtyNum.textContent = qty;
      var qtyUnit = document.createElement('div');
      qtyUnit.style.cssText = 'font-size:11px;color:var(--muted)';
      qtyUnit.textContent = item.unit;
      qtyBox.appendChild(qtyNum);
      qtyBox.appendChild(qtyUnit);

      var tag = document.createElement('span');
      tag.className = 'tag ' + s;
      tag.textContent = statusLabel(s);

      row.appendChild(info);
      row.appendChild(qtyBox);
      row.appendChild(tag);
      container.appendChild(row);

      // Action buttons for THIS item
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;padding:8px 0 4px;border-bottom:1px solid var(--border)';

      var addBtn = document.createElement('button');
      addBtn.className = 'tbl-btn g';
      addBtn.textContent = '+ Add';
      (function(id) {
        addBtn.onclick = function() { closeModal('modal-detail'); openFlowWithItem('addstock', id); };
      })(item.id);

      var sellBtn = document.createElement('button');
      sellBtn.className = 'tbl-btn r';
      sellBtn.textContent = '- Sell';
      (function(id) {
        sellBtn.onclick = function() { closeModal('modal-detail'); openFlowWithItem('sell', id); };
      })(item.id);

      var detailBtn = document.createElement('button');
      detailBtn.className = 'tbl-btn';
      detailBtn.textContent = 'Detail';
      (function(id) {
        detailBtn.onclick = function() { closeModal('modal-detail'); openDetailModal(id); };
      })(item.id);

      btns.appendChild(addBtn);
      btns.appendChild(sellBtn);
      btns.appendChild(detailBtn);
      container.appendChild(btns);
    });
  }

  openModal('modal-detail');
}


// ─── ADD ITEM ─────────────────────────────────────────
var _saving = false;
async function saveNewItem() {
  if (_saving) return;
  var name    = val('ai-name');
  var sku     = val('ai-sku');
  var barcode = val('ai-barcode');
  var unit    = val('ai-unit') || 'pcs';
  var thresh  = parseInt(val('ai-thresh')) || 5;
  if (!name || !sku) { showToast('Name and SKU required', 'err'); return; }
  if (items.find(function(i) { return i.sku.toLowerCase() === sku.toLowerCase(); })) {
    showToast('SKU already exists', 'err'); return;
  }
  _saving = true;
  var btn = document.querySelector('#modal-additem .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var item = { id: uid(), name: name, sku: sku, barcode: barcode, unit: unit, thresh: thresh, sold: false, locations: [] };
  items.unshift(item);
  await dbSaveItem(item);
  ['ai-name','ai-sku','ai-barcode','ai-unit','ai-thresh'].forEach(function(id) {
    var el = e(id); if (el) el.value = '';
  });
  closeModal('modal-additem');
  renderAll();
  showToast('"' + name + '" added', 'ok');
  _saving = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Save Item'; }
}

function toggleSold(id) {
  var item = items.find(function(i) { return i.id === id; });
  if (!item) return;
  item.sold = !item.sold;
  dbSaveItem(item);
  renderAll();
  showToast(item.sold ? 'Marked as Sold' : 'Marked as Available', 'ok');
}

// ─── EDIT ITEM ────────────────────────────────────────
function openEditModal(id) {
  var item = items.find(function(i) { return i.id === id; });
  if (!item) return;
  e('detail-content').innerHTML =
    '<div class="modal-head">' +
      '<div class="modal-title">Edit Item</div>' +
      '<button class="modal-x" onclick="closeModal(\'modal-detail\')">✕</button>' +
    '</div>' +
    '<div class="form-field"><label>Product Name *</label><input id="edit-name" value="' + item.name + '"/></div>' +
    '<div class="form-field"><label>Product Code / SKU *</label><input id="edit-sku" class="mono" value="' + item.sku + '"/></div>' +
    '<div class="form-field"><label>Barcode</label><input id="edit-barcode" class="mono" value="' + (item.barcode || '') + '"/></div>' +
    '<div class="form-2col">' +
      '<div class="form-field"><label>Unit</label><input id="edit-unit" value="' + item.unit + '"/></div>' +
      '<div class="form-field"><label>Low Stock Alert</label><input id="edit-thresh" type="number" value="' + item.thresh + '"/></div>' +
    '</div>' +
    '<div class="form-field"><label>Notes / Memo</label>' +
      '<textarea id="edit-notes" placeholder="e.g. supplier info, special handling…" style="min-height:72px">' + (item.notes || '') + '</textarea></div>' +
    '<div class="modal-foot">' +
      '<button class="btn-ghost" onclick="closeModal(\'modal-detail\')">Cancel</button>' +
      '<button class="btn-primary red" onclick="deleteItem(\'' + id + '\')">Delete</button>' +
      '<button class="btn-primary" id="edit-save-btn" onclick="saveEditItem(\'' + id + '\')">Save Changes</button>' +
    '</div>';
  openModal('modal-detail');
}

var _savingEdit = false;
async function saveEditItem(id) {
  if (_savingEdit) return;
  var item = items.find(function(i) { return i.id === id; });
  if (!item) return;
  var name    = val('edit-name');
  var sku     = val('edit-sku');
  var barcode = val('edit-barcode');
  var unit    = val('edit-unit') || 'pcs';
  var thresh  = parseInt(val('edit-thresh')) || 5;
  if (!name || !sku) { showToast('Name and SKU required', 'err'); return; }
  var conflict = items.find(function(i) { return i.id !== id && i.sku.toLowerCase() === sku.toLowerCase(); });
  if (conflict) { showToast('SKU already used by another item', 'err'); return; }
  _savingEdit = true;
  var btn = e('edit-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var notes = e('edit-notes') ? e('edit-notes').value.trim() : (item.notes || '');
  item.name = name; item.sku = sku; item.barcode = barcode; item.unit = unit; item.thresh = thresh; item.notes = notes;
  await dbSaveItem(item);
  _savingEdit = false;
  closeModal('modal-detail');
  renderAll();
  showToast('Item updated', 'ok');
}

async function deleteItem(id) {
  if (!confirm('Delete this item? This cannot be undone.')) return;
  var idx = items.findIndex(function(i) { return i.id === id; });
  if (idx === -1) return;
  items.splice(idx, 1);
  if (sbClient) await sbClient.from('items').delete().eq('id', id);
  closeModal('modal-detail');
  renderAll();
  showToast('Item deleted', 'ok');
}

// ─── QUICK ADD ────────────────────────────────────────
function openQuickAdd(scanned, returnFlow) {
  quickAddReturnFlow = returnFlow;
  e('qa-scanned-val').textContent = scanned;
  var isNum = /^\d+$/.test(scanned);
  e('qa-sku').value  = isNum ? '' : scanned;
  e('qa-name').value = '';
  e('qa-unit').value = 'pcs';
  e('qa-thresh').value = '5';
  openModal('modal-quickadd');
  setTimeout(function() { var n = e('qa-name'); if (n) n.focus(); }, 100);
}

var _savingQuick = false;
async function saveQuickAdd() {
  if (_savingQuick) return;
  var scanned = e('qa-scanned-val').textContent.trim();
  var name    = val('qa-name');
  var sku     = val('qa-sku');
  var unit    = val('qa-unit') || 'pcs';
  var thresh  = parseInt(val('qa-thresh')) || 5;
  if (!name) { showToast('Name required', 'err'); return; }
  if (!sku)  { showToast('SKU required', 'err'); return; }
  if (items.find(function(i) { return i.sku.toLowerCase() === sku.toLowerCase(); })) {
    showToast('SKU already exists', 'err'); return;
  }
  _savingQuick = true;
  var btn = document.querySelector('#modal-quickadd .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var barcode = scanned !== sku ? scanned : '';
  var item = { id: uid(), name: name, sku: sku, barcode: barcode, unit: unit, thresh: thresh, sold: false, locations: [] };
  items.unshift(item);
  await dbSaveItem(item);
  renderAll();
  closeModal('modal-quickadd');
  showToast('"' + name + '" added!', 'ok');
  _savingQuick = false;
  _savingFlow  = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Add & Continue'; }
  var returnFlow = quickAddReturnFlow;
  quickAddReturnFlow = null;
  if (returnFlow) {
    flowState.item = item;
    flowState.step = 2;
    openModal('modal-' + returnFlow);
    renderFlow(returnFlow);
  }
}

// ─── DETAIL MODAL ─────────────────────────────────────
function openDetailModal(id) {
  var item = items.find(function(i) { return i.id === id; });
  if (!item) return;
  var s = statusOf(item);
  e('detail-content').innerHTML =
    '<div class="modal-head">' +
      '<div class="modal-title">' + item.name + '</div>' +
      '<button class="modal-x" onclick="closeModal(\'modal-detail\')">✕</button>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
      '<span class="mono" style="color:var(--muted)">' + item.sku + (item.barcode ? ' · ' + item.barcode : '') + '</span>' +
      '<span class="tag ' + s + '">' + statusLabel(s) + '</span>' +
    '</div>' +
    '<div style="font-size:40px;font-weight:800;line-height:1;margin-bottom:4px">' + totalQty(item) + '</div>' +
    '<div style="font-size:13px;color:var(--muted);margin-bottom:16px">' + item.unit + ' total</div>' +
    (item.notes ? '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--text2);margin-bottom:16px;font-style:italic">📝 ' + item.notes + '</div>' : '') +
    '<div class="divider"></div>' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:10px">Locations</div>' +
    (item.locations || []).map(function(l) {
      return '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">' +
        '<div><div class="mono" style="font-size:13px">' + l.loc + '</div></div>' +
        '<div style="font-weight:700">' + l.qty + ' ' + item.unit + '</div>' +
      '</div>';
    }).join('') +
    (!(item.locations || []).length ? '<div style="color:var(--muted);font-size:13px">No locations yet</div>' : '') +
    '<div class="divider"></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn-primary green" onclick="closeModal(\'modal-detail\');openFlowWithItem(\'addstock\',\'' + id + '\')">+ Add Stock</button>' +
      '<button class="btn-primary red"   onclick="closeModal(\'modal-detail\');openFlowWithItem(\'sell\',\'' + id + '\')">Sell</button>' +
      '<button class="btn-ghost"         onclick="closeModal(\'modal-detail\');openFlowWithItem(\'move\',\'' + id + '\')">Move</button>' +
      '<button class="btn-ghost"         onclick="closeModal(\'modal-detail\');openEditModal(\'' + id + '\')">✏️ Edit</button>' +
      '<button class="btn-ghost"         onclick="toggleSold(\'' + id + '\');closeModal(\'modal-detail\')">' + (item.sold ? 'Mark Available' : 'Mark Sold') + '</button>' +
    '</div>';
  openModal('modal-detail');
}

// ─── FLOWS ────────────────────────────────────────────
function openFlow(type) {
  _savingFlow = false;
  flowState = { type:type, step:1, item:null, section:null, shelf:null, qty:1, location:null, reason:'Sold/Picked', notes:'', toSection:null, toBay:null };
  openModal('modal-' + type);
  renderFlow(type);
}

function openFlowWithItem(type, id) {
  var item = items.find(function(i) { return i.id === id; });
  if (!item) return;
  _savingFlow = false;
  flowState = { type:type, step:2, item:item, section:null, shelf:null, qty:1, location:null, reason:'Sold/Picked', notes:'', toSection:null, toBay:null };
  openModal('modal-' + type);
  renderFlow(type);
}

function renderFlow(type) {
  if (type === 'addstock') renderAddstock();
  if (type === 'sell')     renderSell();
  if (type === 'move')     renderMove();
}

function stepBar(current, total) {
  var html = '<div class="step-bar">';
  for (var i = 0; i < total; i++) {
    var cls = i < current - 1 ? 'done' : i === current - 1 ? 'active' : '';
    html += '<div class="step-dot ' + cls + '"></div>';
  }
  return html + '</div>';
}

function flowHeader(title) {
  return '<div class="modal-head"><div class="modal-title">' + title + '</div>' +
    '<button class="modal-x" onclick="closeModal(\'modal-' + flowState.type + '\')">✕</button></div>';
}

function buildShelfPicker(selected, fn) {
  var shelves = getAllShelves();
  var html = '';
  var byZone = {};
  shelves.forEach(function(s) {
    if (!byZone[s.zone]) byZone[s.zone] = {};
    if (!byZone[s.zone][s.aisle]) byZone[s.zone][s.aisle] = [];
    byZone[s.zone][s.aisle].push(s);
  });
  Object.keys(byZone).forEach(function(zone) {
    html += '<div style="margin-bottom:10px">';
    html += '<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;color:var(--muted2);text-transform:uppercase;margin-bottom:6px">' + zone + '</div>';
    html += '<div class="shelf-picker">';
    Object.keys(byZone[zone]).forEach(function(aisle) {
      byZone[zone][aisle].forEach(function(s) {
        var sel = selected === s.code ? 'sel' : '';
        html += '<button class="shelf-btn ' + aisle + ' ' + sel + '" onclick="' + fn + '(\'' + s.code + '\')">' + s.code + '</button>';
      });
    });
    html += '</div></div>';
  });
  return html;
}

function buildBayPicker(shelfCode, selected, fn) {
  var bays = getBaysForShelf(shelfCode);
  return bays.map(function(b) {
    var sel = selected === b ? 'sel' : '';
    return '<button class="bay-btn ' + sel + '" onclick="' + fn + '(\'' + b + '\')">' + b + '</button>';
  }).join('');
}

// ── ADD STOCK ──
function renderAddstock() {
  var s = flowState;
  var c = e('addstock-content');
  var html = flowHeader('Add Stock') + stepBar(s.step, 4);
  if (s.step === 5) { c.innerHTML = renderSuccess('addstock'); return; }
  if (s.step === 1) {
    html += '<div class="step-label">Step 1 of 4</div><div class="step-title">Find Item</div>' +
      '<div class="scan-zone" id="scan-box-addstock" onclick="startScanner(\'addstock\')">' +
        '<div class="scan-icon-big">▣</div><div class="scan-zone-text">Tap to scan barcode</div>' +
      '</div>' +
      '<div id="addstock-scanner-wrap" style="display:none;margin-bottom:12px">' +
        '<div class="scanner-wrap"><div id="addstock-reader"></div></div>' +
        '<button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner(\'addstock\')">Cancel</button>' +
      '</div>' +
      '<div class="or-row">or type manually</div>' +
      '<div class="form-field"><label>SKU / Barcode</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="pa-manual" class="mono" placeholder="e.g. OSB6040Q-20W" onkeydown="if(event.key===\'Enter\')paLookup()"/>' +
          '<button class="btn-primary" onclick="paLookup()">Find</button>' +
        '</div>' +
      '</div>';
  } else if (s.step === 2) {
    html += '<div class="step-label">Step 2 of 4</div><div class="step-title">Select Shelf Unit</div>' +
      '<div class="found-box"><div class="found-label">✓ Item Found</div>' +
        '<div class="found-name">' + s.item.name + '</div>' +
        '<div class="found-sub">' + s.item.sku + ' · ' + totalQty(s.item) + ' ' + s.item.unit + ' in stock</div>' +
      '</div>' +
      '<div class="step-sub">Which shelf? (e.g. M08A1, M08D4)</div>' +
      buildShelfPicker(s.section, 'paPickShelf') +
      '<button class="btn-primary full" style="margin-top:10px" onclick="paGoToBay()" ' + (!s.section ? 'disabled' : '') + '>Next →</button>';
  } else if (s.step === 3) {
    html += '<div class="step-label">Step 3 of 4</div><div class="step-title">Select Bay</div>' +
      '<div class="found-box" style="background:var(--accent-bg);border-color:#BFDBFE">' +
        '<div class="found-label" style="color:var(--accent)">Shelf: ' + s.section + '</div>' +
        '<div class="found-name">' + s.item.name + '</div>' +
      '</div>' +
      '<div class="step-sub">Which bay on shelf ' + s.section + '?</div>' +
      '<div class="bay-picker">' + buildBayPicker(s.section, s.shelf, 'paPickBay') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="btn-ghost" onclick="flowState.step=2;renderAddstock()">← Back</button>' +
        '<button class="btn-primary" style="flex:1" onclick="paGoToQty()" ' + (!s.shelf ? 'disabled' : '') + '>Next →</button>' +
      '</div>';
  } else if (s.step === 4) {
    var locCode = s.section + s.shelf;
    html += '<div class="step-label">Step 4 of 4</div><div class="step-title">Enter Quantity</div>' +
      '<div class="summary">' +
        '<div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">' + s.item.sku + '</span></div>' +
        '<div class="summary-row"><span class="sum-label">Shelf</span><span class="sum-val">' + s.section + '</span></div>' +
        '<div class="summary-row"><span class="sum-label">Bay</span><span class="sum-val">' + s.shelf + '</span></div>' +
        '<div class="summary-row"><span class="sum-label">Location</span><span class="sum-val mono">' + locCode + '</span></div>' +
      '</div>' +
      '<div class="form-field"><label>Quantity</label>' +
        '<div class="qty-row">' +
          '<button class="qty-btn" onclick="adjQty(-1)">−</button>' +
          '<input class="qty-input" id="flow-qty" type="number" value="' + s.qty + '" min="1" oninput="flowState.qty=parseInt(this.value)||1"/>' +
          '<button class="qty-btn" onclick="adjQty(1)">+</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-field"><label>Notes (optional)</label>' +
        '<textarea id="flow-notes" placeholder="e.g. new stock, batch #…">' + s.notes + '</textarea>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn-ghost" onclick="flowState.step=3;renderAddstock()">← Back</button>' +
        '<button class="btn-primary green full" id="save-addstock-btn" onclick="saveAddstock()">✓ Save Add Stock</button>' +
      '</div>';
  }
  c.innerHTML = html;
}

function paLookup() {
  var v = val('pa-manual');
  var item = findItem(v);
  if (!item) { openQuickAdd(v, 'addstock'); return; }
  flowState.item = item; flowState.step = 2; renderAddstock();
}
function paPickShelf(shelf) { flowState.section = shelf; flowState.shelf = null; renderAddstock(); }
function paGoToBay()  { if (!flowState.section) return; flowState.step = 3; renderAddstock(); }
function paPickBay(bay) { flowState.shelf = bay; renderAddstock(); }
function paGoToQty()  { if (!flowState.shelf) return; flowState.step = 4; renderAddstock(); }

var _savingFlow = false;
async function saveAddstock() {
  if (_savingFlow) return;
  _savingFlow = true;
  var btn = e('save-addstock-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var s = flowState;
  s.qty   = parseInt(val('flow-qty')) || 1;
  s.notes = e('flow-notes') ? e('flow-notes').value : '';
  var locCode = s.section + s.shelf;
  var ex = (s.item.locations || []).find(function(l) { return l.loc === locCode; });
  if (ex) ex.qty += s.qty;
  else s.item.locations.push({ loc: locCode, shelf: s.section + ' ' + s.shelf, qty: s.qty });
  var entry = { type:'addstock', itemId:s.item.id, itemName:s.item.name, location:locCode, qty:s.qty, notes:s.notes, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  _savingFlow = false;
  renderAll();
  flowState.step = 5;
  renderAddstock();
}

// ── SELL ──
function renderSell() {
  var s = flowState;
  var c = e('sell-content');
  var html = flowHeader('Sell / Remove') + stepBar(s.step, 3);
  if (s.step === 4) { c.innerHTML = renderSuccess('sell'); return; }
  if (s.step === 1) {
    html += '<div class="step-label">Step 1 of 3</div><div class="step-title">Find Item</div>' +
      '<div class="scan-zone" onclick="startScanner(\'sell\')">' +
        '<div class="scan-icon-big">▣</div><div class="scan-zone-text">Tap to scan barcode</div>' +
      '</div>' +
      '<div id="sell-scanner-wrap" style="display:none;margin-bottom:12px">' +
        '<div class="scanner-wrap"><div id="sell-reader"></div></div>' +
        '<button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner(\'sell\')">Cancel</button>' +
      '</div>' +
      '<div class="or-row">or type manually</div>' +
      '<div class="form-field"><label>SKU / Barcode</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="sell-manual" class="mono" placeholder="SKU or barcode…" onkeydown="if(event.key===\'Enter\')sellLookup()"/>' +
          '<button class="btn-primary" onclick="sellLookup()">Find</button>' +
        '</div>' +
      '</div>';
  } else if (s.step === 2) {
    var locs = (s.item.locations || []).filter(function(l) { return l.qty > 0; });
    html += '<div class="step-label">Step 2 of 3</div><div class="step-title">Choose Location</div>' +
      '<div class="found-box"><div class="found-label">✓ Item Found</div>' +
        '<div class="found-name">' + s.item.name + '</div>' +
        '<div class="found-sub">' + s.item.sku + ' · ' + totalQty(s.item) + ' ' + s.item.unit + '</div>' +
      '</div>' +
      locs.map(function(l) {
        return '<div class="loc-option ' + (s.location === l.loc ? 'sel' : '') + '" onclick="sellSelectLoc(\'' + l.loc + '\')">' +
          '<div class="loc-radio"><div class="loc-dot"></div></div>' +
          '<div class="loc-name">' + l.loc + '</div>' +
          '<div class="loc-qty">' + l.qty + ' ' + s.item.unit + '</div>' +
        '</div>';
      }).join('') +
      '<button class="btn-primary full" style="margin-top:10px" onclick="sellStep3()" ' + (!s.location ? 'disabled' : '') + '>Next →</button>';
  } else if (s.step === 3) {
    var locObj = (s.item.locations || []).find(function(l) { return l.loc === s.location; });
    html += '<div class="step-label">Step 3 of 3</div><div class="step-title">Quantity &amp; Reason</div>' +
      '<div class="summary">' +
        '<div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">' + s.item.sku + '</span></div>' +
        '<div class="summary-row"><span class="sum-label">Location</span><span class="sum-val mono">' + s.location + '</span></div>' +
        '<div class="summary-row"><span class="sum-label">Available</span><span class="sum-val">' + (locObj ? locObj.qty : 0) + ' ' + s.item.unit + '</span></div>' +
      '</div>' +
      '<div class="form-field"><label>Quantity to Remove</label>' +
        '<div class="qty-row">' +
          '<button class="qty-btn" onclick="adjQty(-1)">−</button>' +
          '<input class="qty-input" id="flow-qty" type="number" value="' + s.qty + '" min="1" oninput="flowState.qty=parseInt(this.value)||1"/>' +
          '<button class="qty-btn" onclick="adjQty(1)">+</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-field"><label>Reason</label>' +
        '<div class="reason-list">' +
          ['Sold/Picked','Damaged','Return to Vendor','Adjustment'].map(function(r) {
            return '<div class="reason-opt ' + (s.reason === r ? 'sel' : '') + '" onclick="sellReason(\'' + r + '\')">' +
              '<div class="loc-radio"><div class="loc-dot"></div></div>' + r +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="form-field"><label>Notes (optional)</label><textarea id="flow-notes" placeholder="Notes…">' + s.notes + '</textarea></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn-ghost" onclick="flowState.step=2;renderSell()">← Back</button>' +
        '<button class="btn-primary red full" id="save-sell-btn" onclick="saveSell()">Confirm Remove</button>' +
      '</div>';
  }
  c.innerHTML = html;
}

function sellLookup() {
  var v = val('sell-manual');
  var item = findItem(v);
  if (!item) { openQuickAdd(v, 'sell'); return; }
  flowState.item = item; flowState.step = 2; renderSell();
}
function sellSelectLoc(loc) { flowState.location = loc; renderSell(); }
function sellStep3() { if (!flowState.location) return; flowState.step = 3; renderSell(); }
function sellReason(r) { flowState.reason = r; renderSell(); }

async function saveSell() {
  if (_savingFlow) return;
  _savingFlow = true;
  var btn = e('save-sell-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var s = flowState;
  s.qty   = parseInt(val('flow-qty')) || 1;
  s.notes = e('flow-notes') ? e('flow-notes').value : '';
  var loc = (s.item.locations || []).find(function(l) { return l.loc === s.location; });
  if (loc) loc.qty = Math.max(0, loc.qty - s.qty);
  s.item.locations = (s.item.locations || []).filter(function(l) { return l.qty > 0; });
  var entry = { type:'sell', itemId:s.item.id, itemName:s.item.name, location:s.location, qty:s.qty, reason:s.reason, notes:s.notes, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  _savingFlow = false;
  renderAll();
  flowState.step = 4;
  renderSell();
}

// ── MOVE ──
function renderMove() {
  var s = flowState;
  var c = e('move-content');
  var html = flowHeader('Move Stock') + stepBar(s.step, 3);
  if (s.step === 4) { c.innerHTML = renderSuccess('move'); return; }
  if (s.step === 1) {
    html += '<div class="step-label">Step 1 of 3</div><div class="step-title">Find Item</div>' +
      '<div class="scan-zone" onclick="startScanner(\'move\')">' +
        '<div class="scan-icon-big">▣</div><div class="scan-zone-text">Tap to scan barcode</div>' +
      '</div>' +
      '<div id="move-scanner-wrap" style="display:none;margin-bottom:12px">' +
        '<div class="scanner-wrap"><div id="move-reader"></div></div>' +
        '<button class="btn-ghost sm" style="margin-top:8px" onclick="stopScanner(\'move\')">Cancel</button>' +
      '</div>' +
      '<div class="or-row">or type manually</div>' +
      '<div class="form-field"><label>SKU / Barcode</label>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="move-manual" class="mono" placeholder="SKU…" onkeydown="if(event.key===\'Enter\')moveLookup()"/>' +
          '<button class="btn-primary" onclick="moveLookup()">Find</button>' +
        '</div>' +
      '</div>';
  } else if (s.step === 2) {
    var locs2 = (s.item.locations || []).filter(function(l) { return l.qty > 0; });
    html += '<div class="step-label">Step 2 of 3</div><div class="step-title">From Location</div>' +
      '<div class="found-box"><div class="found-label">✓ Item Found</div><div class="found-name">' + s.item.name + '</div></div>' +
      locs2.map(function(l) {
        return '<div class="loc-option ' + (s.location === l.loc ? 'sel' : '') + '" onclick="moveFrom(\'' + l.loc + '\')">' +
          '<div class="loc-radio"><div class="loc-dot"></div></div>' +
          '<div class="loc-name">' + l.loc + '</div>' +
          '<div class="loc-qty">' + l.qty + ' ' + s.item.unit + '</div>' +
        '</div>';
      }).join('') +
      '<button class="btn-primary full" style="margin-top:10px" onclick="moveStep3()" ' + (!s.location ? 'disabled' : '') + '>Next →</button>';
  } else if (s.step === 3) {
    var from = (s.item.locations || []).find(function(l) { return l.loc === s.location; });
    html += '<div class="step-label">Step 3 of 3</div><div class="step-title">Move To</div>' +
      '<div class="summary"><div class="summary-row"><span class="sum-label">From</span><span class="sum-val mono">' + s.location + '</span></div></div>' +
      '<div class="form-field"><label>Destination Shelf</label>' + buildShelfPicker(s.toSection, 'movePickShelf') + '</div>' +
      (s.toSection ? '<div class="form-field"><label>Destination Bay</label><div class="bay-picker">' + buildBayPicker(s.toSection, s.toBay, 'movePickBay') + '</div></div>' : '') +
      '<div class="form-field"><label>Quantity</label>' +
        '<div class="qty-row">' +
          '<button class="qty-btn" onclick="adjQty(-1)">−</button>' +
          '<input class="qty-input" id="flow-qty" type="number" value="' + s.qty + '" min="1" max="' + (from ? from.qty : 99) + '" oninput="flowState.qty=parseInt(this.value)||1"/>' +
          '<button class="qty-btn" onclick="adjQty(1)">+</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn-ghost" onclick="flowState.step=2;renderMove()">← Back</button>' +
        '<button class="btn-primary full" id="save-move-btn" onclick="saveMove()" ' + (!s.toSection || !s.toBay ? 'disabled' : '') + '>Confirm Move</button>' +
      '</div>';
  }
  c.innerHTML = html;
}

function moveLookup() {
  var v = val('move-manual');
  var item = findItem(v);
  if (!item) { openQuickAdd(v, 'move'); return; }
  flowState.item = item; flowState.step = 2; renderMove();
}
function moveFrom(loc)  { flowState.location = loc; renderMove(); }
function moveStep3()    { if (!flowState.location) return; flowState.step = 3; renderMove(); }
function movePickShelf(shelf) { flowState.toSection = shelf; flowState.toBay = null; renderMove(); }
function movePickBay(bay)     { flowState.toBay = bay; renderMove(); }

async function saveMove() {
  if (_savingFlow) return;
  _savingFlow = true;
  var btn = e('save-move-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  var s = flowState;
  s.qty = parseInt(val('flow-qty')) || 1;
  var toCode = s.toSection + s.toBay;
  var from = (s.item.locations || []).find(function(l) { return l.loc === s.location; });
  if (from) from.qty = Math.max(0, from.qty - s.qty);
  var to = (s.item.locations || []).find(function(l) { return l.loc === toCode; });
  if (to) to.qty += s.qty;
  else s.item.locations.push({ loc: toCode, shelf: s.toSection + ' ' + s.toBay, qty: s.qty });
  s.item.locations = (s.item.locations || []).filter(function(l) { return l.qty > 0; });
  var entry = { type:'move', itemId:s.item.id, itemName:s.item.name, location:s.location + ' → ' + toCode, qty:s.qty, ts:Date.now() };
  activityLog.unshift(entry);
  await Promise.all([dbSaveItem(s.item), dbLogActivity(entry)]);
  _savingFlow = false;
  renderAll();
  flowState.step = 4;
  renderMove();
}

// ── SUCCESS ──
function renderSuccess(type) {
  var s = flowState;
  var map = {
    addstock: { icon:'✅', title:'Stock Added!',  btn:'Add More', next:'openFlow(\'addstock\')' },
    sell:     { icon:'✅', title:'Removed!',      btn:'Remove Another', next:'openFlow(\'sell\')' },
    move:     { icon:'✅', title:'Moved!',        btn:'Move Another', next:'openFlow(\'move\')' }
  };
  var m = map[type];
  return '<div class="success-box">' +
    '<div class="success-mark">' + m.icon + '</div>' +
    '<div class="success-title">' + m.title + '</div>' +
    '<div class="success-sub">Inventory updated and synced</div>' +
    '<div class="summary" style="text-align:left">' +
      (s.item ? '<div class="summary-row"><span class="sum-label">Item</span><span class="sum-val blue">' + s.item.sku + '</span></div>' : '') +
      (s.qty  ? '<div class="summary-row"><span class="sum-label">Qty</span><span class="sum-val ' + (type==='sell'?'red':'green') + '">' + (type==='sell'?'−':'+') + s.qty + '</span></div>' : '') +
    '</div>' +
    '<div class="success-btns">' +
      '<button class="btn-primary full" onclick="' + m.next + '">' + m.btn + '</button>' +
      '<button class="btn-ghost full" onclick="closeModal(\'modal-' + type + '\')">Done</button>' +
    '</div>' +
  '</div>';
}

// ── SHARED ──
function adjQty(d) {
  flowState.qty = Math.max(1, (flowState.qty || 1) + d);
  var el = e('flow-qty');
  if (el) el.value = flowState.qty;
}

// ─── SCANNERS ─────────────────────────────────────────
async function startScanner(id) {
  var wrap = e(id + '-scanner-wrap');
  var box  = e('scan-box-' + id);
  if (!wrap) return;
  wrap.style.display = 'block';
  if (box) box.style.display = 'none';
  try {
    var qr = new Html5Qrcode(id + '-reader');
    scanners[id] = qr;
    await qr.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 120 } },
      function(code) { stopScanner(id); handleScan(id, code); },
      function() {}
    );
  } catch(err) {
    showToast('Camera not available', 'err');
    if (wrap) wrap.style.display = 'none';
    if (box)  box.style.display  = 'block';
  }
}

async function stopScanner(id) {
  var qr = scanners[id];
  if (qr) { try { await qr.stop(); } catch(ex){} try { qr.clear(); } catch(ex){} delete scanners[id]; }
  var wrap = e(id + '-scanner-wrap');
  var box  = e('scan-box-' + id);
  if (wrap) wrap.style.display = 'none';
  if (box)  box.style.display  = 'block';
}

function handleScan(id, code) {
  showToast('Scanned: ' + code);
  var item = findItem(code);
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
    var isNum = /^\d+$/.test(code);
    var target = isNum ? e('ai-barcode') : e('ai-sku');
    if (target) target.value = code;
    stopScanner('additem');
    showToast(isNum ? 'Barcode filled' : 'SKU filled', 'ok');
  }
}

// ─── NAVIGATION ───────────────────────────────────────
function showPage(name) {
  Object.keys(scanners).forEach(function(id) { stopScanner(id); });
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.bnav-btn').forEach(function(b) { b.classList.remove('active'); });
  var page = e('page-' + name);
  if (page) page.classList.add('active');
  var btn = document.querySelector('.nav-btn[data-page="' + name + '"]');
  if (btn) btn.classList.add('active');
  var bnavBtn = document.querySelector('.bnav-btn[data-page="' + name + '"]');
  if (bnavBtn) bnavBtn.classList.add('active');
  var titles = { dashboard:'Dashboard', inventory:'Inventory', map:'Warehouse Map', activity:'Activity Log' };
  var titleEl = e('page-title');
  if (titleEl) titleEl.textContent = titles[name] || '';
  closeSidebar();
  if (name === 'inventory') renderInvTable();
  if (name === 'activity')  renderActivity();
  if (name === 'map')       renderMap();
  if (name === 'dashboard') renderAll();
}

document.querySelectorAll('.nav-btn[data-page]').forEach(function(btn) {
  btn.addEventListener('click', function() { showPage(btn.dataset.page); });
});

function toggleSidebar() {
  e('sidebar').classList.toggle('open');
  e('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  e('sidebar').classList.remove('open');
  e('sidebar-overlay').classList.remove('open');
}

// ─── MODALS ───────────────────────────────────────────
function openModal(id) {
  var el = e(id);
  if (!el) return;
  el.classList.add('open');
  el.style.display = 'flex';
}
function closeModal(id) {
  Object.keys(scanners).forEach(function(k) { stopScanner(k); });
  // Always reset ALL saving flags on close so next open starts fresh
  _savingFlow  = false;
  _saving      = false;
  _savingQuick = false;
  _savingEdit  = false;
  var el = e(id);
  if (!el) return;
  el.classList.remove('open');
  el.style.display = '';
}
document.querySelectorAll('.modal-overlay').forEach(function(o) {
  o.addEventListener('click', function(ev) { if (ev.target === o) closeModal(o.id); });
});

// ─── TOAST ────────────────────────────────────────────
function showToast(msg, type) {
  var t = e('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(t._tid);
  t._tid = setTimeout(function() { t.classList.remove('show'); }, 2800);
}