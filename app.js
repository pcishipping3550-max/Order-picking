'use strict';
// Assemblies & Conversions: one pick ticket at a time, on one iPad, offline.
// Pick → inspect (a conversion's own steps start with that check) → print reports only when there are discrepancies.
const P = TicketParser;
const PROBLEMS = ['Damaged', 'Incomplete package', 'Not available'];
const AFTER_PICK = ['Damaged', 'Incomplete package']; // what an inspection or a conversion can find in parts already picked
const STORE = 'ac-picking-v1';
// The Power Automate flow's web address. It works like a password, so it stays on this iPad and out of backups.
const FLOW = 'ac-picking-flow';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();
const fmtDate = iso => iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const embedded = window.self !== window.top;
// The iPad gets files through its share sheet (Print, Save to Files): a plain download is unreliable in a home-screen app.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// LMI reference sheets, copied as printed. Shown side by side at the install step.
const TORQUE = [['B1', '26in-lb + 28in-lb'], ['B7', '26in-lb + 28in-lb'], ['B9', '26in-lb + 28in-lb'], ['C1', '26in-lb + 28in-lb'], ['C7', '26in-lb + 28in-lb'], ['C9', '26in-lb + 28in-lb'],
  ['E7', '36 in-lb'], ['Excel AD', '25 in-lb'], ['PD', '25 in-lb'], ['Excel XR', '25 in-lb'], ['TD', '25 in-lb']];
const MFV = [['Main Body Bolts (4x)', '38 in*lb'], ['Relief Valve Fitting', '54 in*lb'], ['Coupling Knob', '37 in*lb']];
const STROKE = [
  ['All A, B and P Series<br>C10, C11, C12, C70, C71, C72, C76, C90, C91, C92 E70, E71, E72', '90%'],
  ['C78', '50%'],
  ['C13, C14, C73, C74, C77, C93, C94<br>E73,E74', '70%'],
  ['All M Series', '100%.<br>But Liquifram<sup>®</sup> must be bottomed completely.<br>(Turned all the way)<br><strong>Do Not Use Straight Edge.</strong>']
];

let db = { tickets: [], pickers: [] };
let view = { screen: 'home', id: null, draft: null, sheet: null, confirmDelete: null, queue: null, note: null, flow: null };
let toastTimer;

// ---------- storage ----------
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) db = Object.assign({ tickets: [], pickers: [] }, JSON.parse(raw)); }
  catch (e) { toast('Saved tickets could not be read on this device.'); }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(db)); return true; }
  catch (e) { toast('Could not save on this device. Save a backup file now.'); return false; }
}
function toast(msg, ms = 4500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- ticket logic ----------
const ticketById = id => db.tickets.find(t => t.id === id);
const problemQty = l => l.problems.reduce((n, p) => n + p.qty, 0);
const remaining = l => Math.max(0, l.qty - l.picked - problemQty(l));
const lineDone = l => remaining(l) === 0;
const ticketProblems = t => t.lines.flatMap(l => l.problems.map(p => ({ line: l, ...p })));
const hasProblems = t => ticketProblems(t).length > 0;
const allDone = t => t.lines.length > 0 && t.lines.every(lineDone);
const pickedCount = t => t.lines.filter(lineDone).length;
// A bin the order didn't print stays a blank for the picker to fill in, even after they type it.
const blankBin = l => !!l.binBlank || !l.bin;
function sortedLines(t) {
  const key = l => l.bin.split(' / ')[0];
  return [...t.lines].sort((a, b) => blankBin(b) - blankBin(a)
    || (blankBin(a) ? 0 : key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' }))
    || a.item.localeCompare(b.item, undefined, { numeric: true }));
}
const labelsLeft = t => t.labels.filter(c => !c.madeAt).length;
const fmtQty = n => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
const isConversion = t => t.products.some(p => p.kind === 'conversion');
const returnsOf = t => t.products.flatMap(p => p.returns || []);
// A conversion's steps begin with opening the packages, so they replace the inspection. Discrepancies stop the conversion.
const nextStep = t => isConversion(t) && !hasProblems(t) ? 'convert' : 'inspect';

function newTicketFrom(draft) {
  return {
    id: uid(), created: now(), status: 'open', picker: '', completedAt: null, conv: null,
    type: draft.type, orderNumber: draft.orderNumber.trim(), ticket: draft.ticket.trim(), taker: draft.taker.trim(),
    customer: draft.customer.trim(), customerId: (draft.customerId || '').trim(), billTo: draft.billTo.trim(), shipTo: draft.shipTo.trim(), service: (draft.service || '').trim(),
    products: (draft.products || []).map(p => ({ ...p, returns: (p.returns || []).map(r => ({ ...r, bin: (r.bin || '').trim(), binBlank: !(r.bin || '').trim() })) })),
    lines: draft.lines.map(l => ({ id: uid(), item: l.item.trim(), desc: l.desc.trim(), bin: (l.bin || '').trim(), binBlank: !(l.bin || '').trim(), qty: +l.qty, product: l.product || '', picked: 0, problems: [] })),
    labels: (draft.products || []).filter(p => p.kind === 'conversion').flatMap(p => Array.from({ length: Math.max(1, Math.round(p.qty)) }, (_, i) => ({ id: uid(), product: p.item, unit: i + 1, of: Math.max(1, Math.round(p.qty)), ...P.labelDefaults(p) })))
  };
}

// Why a ticket can't be saved yet, or '' when it's ready.
function draftProblem(d) {
  if (!d.orderNumber.trim() || !d.ticket.trim()) return 'Enter the order number and the pick ticket number.';
  if (!d.lines.length) return 'Add at least one line to pick.';
  if (d.lines.some(l => !(+l.qty > 0))) return 'Every line needs a quantity above zero.';
  return '';
}

// Part numbers for the conversion steps, e.g. pump C13120PB, new LE-415SI, removed LE-20PB, model C131-415SI on driver C131.
function convNames(t) {
  const p = t.products.find(x => x.kind === 'conversion') || { item: '', desc: '', returns: [] };
  const mine = t.lines.filter(l => l.product === p.item), pool = mine.length ? mine : t.lines;
  const le = pool.find(l => /^LE-/i.test(l.item)) || pool.find(l => /liquid end/i.test(l.desc));
  const pump = pool.find(l => l !== le && /pump/i.test(l.desc)) || pool.find(l => l !== le);
  const model = P.labelDefaults(p).model;
  return { pump, le, model, newLE: le ? le.item : '', oldLE: (p.returns || []).map(r => r.item).join(', '), driver: model.includes('-') ? model.split('-')[0] : '' };
}

// john's conversion workflow, step by step, in his words. problemIf: the answer that means a discrepancy.
function convSteps(t) {
  const n = convNames(t), oldLE = n.oldLE ? 'liquid end ' + n.oldLE : 'the original liquid end';
  return [
    { key: 'unpack', text: 'Remove contents and verify the individual parts in the packages.' },
    { key: 'pumpBox', problemIf: 'no', line: n.pump, text: 'Are all contents in the pump box correct and in good working order?', sub: n.pump ? 'Pump box: ' + n.pump.item : '' },
    { key: 'lePackage', problemIf: 'no', line: n.le, text: 'Are all contents in the LE package correct and in good working order?', sub: n.le ? 'LE package: ' + n.le.item : '' },
    { key: 'swap', text: `Remove the ${n.oldLE || 'original'} liquid end from the driver and place it with the items from the pump box.` },
    { key: 'size', text: 'Verify liquid end is the correct size.' },
    { key: 'diaphragmOut', text: 'Remove the diaphragm from the driver.', sub: 'See product manual for detailed instructions.' },
    { key: 'keep', text: 'Place the original diaphragm with the original liquid end and screws.' },
    { key: 'guide', text: 'Find the diaphragm installation guide in the product manual.' },
    { key: 'install', text: `Install the new diaphragm and liquid end ${n.newLE ? n.newLE + ' ' : ''}on ${n.driver ? 'driver ' + n.driver : 'the driver'}.` },
    { key: 'labels', text: 'Print the labels.' },
    { key: 'labelsOn', text: 'Install the labels.' },
    { key: 'box', text: 'Place the pump in the box, along with any remaining parts that came with the new liquid end.' },
    { key: 'leBox', text: `Place ${oldLE} in the liquid end box.` },
    { key: 'installCheck', problemIf: 'yes', text: 'Were any parts missing or damaged in the install?' },
    { key: 'ship', text: `Once all items are complete, place ${n.model ? 'pump ' + n.model : 'the pump'} in the appropriate place for shipping.` },
    { key: 'inventory', text: `Place ${oldLE} in inventory.` }
  ];
}

// ---------- rendering ----------
function render() {
  const main = $('#main'), t = ticketById(view.id);
  if (view.screen === 'review') main.innerHTML = reviewView();
  else if (view.screen === 'ticket' && t) main.innerHTML = ticketView(t);
  else if (view.screen === 'inspect' && t) main.innerHTML = inspectView(t);
  else if (view.screen === 'convert' && t && t.conv) main.innerHTML = convertView(t);
  else if (view.screen === 'reports' && t) main.innerHTML = reportsView(t);
  else if (view.screen === 'settings') main.innerHTML = settingsView();
  else { view.screen = 'home'; main.innerHTML = homeView(); }
  renderSheet();
  $('#backBtn').hidden = view.screen === 'home';
}

function stateLabel(t) {
  if (!allDone(t)) return `${pickedCount(t)} of ${t.lines.length} lines`;
  if (nextStep(t) === 'inspect') return 'Ready to inspect';
  return t.conv ? `Conversion step ${t.conv.step + 1} of ${convSteps(t).length}` : 'Ready to convert';
}

function homeView() {
  const open = db.tickets.filter(t => t.status === 'open').sort((a, b) => b.created.localeCompare(a.created));
  const done = db.tickets.filter(t => t.status === 'done').sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const card = t => {
    const probs = ticketProblems(t).length;
    return `<button class="ticketCard" data-act="open" data-id="${t.id}">
      <span class="tcMain"><span class="tcOrder">Order ${esc(t.orderNumber)}</span><span class="tcSub">Pick ticket ${esc(t.ticket)} · ${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</span></span>
      <span class="tcState">${t.status === 'done'
        ? `<span class="chip ${probs ? 'warn' : 'ok'}">${probs ? probs + ' discrepanc' + (probs === 1 ? 'y' : 'ies') : 'Complete'}</span><small>${esc(fmtDate(t.completedAt))}${t.picker ? ' · ' + esc(t.picker) : ''}</small>`
        : `<span class="chip">${esc(stateLabel(t))}</span><small>${t.picker ? esc(t.picker) : 'Not started'}</small>`}</span>
    </button>`;
  };
  return `<section class="start">
      <button class="big primary" data-act="import"><span class="bigIcon" aria-hidden="true">⇪</span>Import pick tickets<small>One PDF or several at once</small></button>
      <button class="big" data-act="manual"><span class="bigIcon" aria-hidden="true">✎</span>Enter by hand<small>When a PDF won't import</small></button>
    </section>
    <h2 class="listHead">In progress <span>${open.length}</span></h2>
    <div class="list">${open.map(card).join('') || '<p class="empty">No pick tickets in progress. Import one to start.</p>'}</div>
    <h2 class="listHead">Completed <span>${done.length}</span></h2>
    <div class="list">${done.slice(0, 50).map(card).join('') || '<p class="empty">Completed pick tickets appear here.</p>'}</div>`;
}

// Review an imported or hand-entered ticket before it is saved.
function reviewView() {
  const d = view.draft;
  const field = (k, label, opts = '') => `<label>${label}<input id="d-${k}" data-draft="${k}" value="${esc(d[k])}" ${opts}></label>`;
  const area = (k, label) => `<label>${label}<textarea id="d-${k}" data-draft="${k}" rows="4">${esc(d[k])}</textarea></label>`;
  const more = view.queue && view.queue.length ? ` · ${view.queue.length} more after this one` : '';
  return `<div class="pageHead"><div><p class="eyebrow">${d.fromPdf ? 'Check the import' : 'Enter by hand'}${more}</p><h1>${d.fromPdf ? 'Does this match the paper ticket?' : 'New pick ticket'}</h1></div></div>
    ${view.note ? `<p class="note strong">${esc(view.note)}</p>` : ''}
    ${d.fromPdf ? `<p class="note">Compare the numbers, bins and quantities with the PDF before saving. Fix anything that's wrong here. A bin left empty becomes a blank for the picker to fill in.${d.unreadable ? ' <strong>No text was found in this PDF, so it may be a scan. Enter the lines by hand.</strong>' : ''}</p>` : ''}
    <div class="panel grid">
      ${field('orderNumber', 'Order number', 'inputmode="numeric" required')}
      ${field('ticket', 'Pick ticket number', 'inputmode="numeric" required')}
      <label>Type<select id="d-type" data-draft="type">${['Sales', 'Service', 'Production', 'BOM'].map(t => `<option ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      ${field('taker', 'Taker')}
      ${field('customer', 'Customer')}
      ${field('customerId', 'Customer number')}
      ${area('billTo', 'Bill To')}${area('shipTo', 'Ship To')}
    </div>
    ${d.products && d.products.length ? `<div class="panel"><h3>Builds</h3>${d.products.map(p => `<p><strong>${esc(p.item)}</strong> × ${fmtQty(p.qty)} · ${p.kind === 'conversion' ? 'Conversion' : 'Assembly'}${p.returns.length ? ` · returns ${p.returns.map(r => esc(r.item) + ' × ' + fmtQty(r.qty)).join(', ')}` : ''}</p>`).join('')}</div>` : ''}
    <div class="panel"><h3>Lines to pick <span class="muted">${d.lines.length}</span></h3>
      <div class="tableWrap"><table class="edit"><thead><tr><th>Item</th><th>Description</th><th>Qty</th><th>Bin</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr>
        <td><input id="l-${i}-item" aria-label="Item ${i + 1}" data-line="${i}" data-key="item" value="${esc(l.item)}"></td>
        <td><input id="l-${i}-desc" aria-label="Description ${i + 1}" data-line="${i}" data-key="desc" value="${esc(l.desc)}"></td>
        <td class="num"><input id="l-${i}-qty" aria-label="Quantity ${i + 1}" data-line="${i}" data-key="qty" type="number" min="0" step="any" inputmode="decimal" value="${esc(l.qty)}"></td>
        <td><input id="l-${i}-bin" aria-label="Bin ${i + 1}" data-line="${i}" data-key="bin" value="${esc(l.bin)}"></td>
        <td><button class="icon" data-act="dropLine" data-i="${i}" aria-label="Remove line ${i + 1}">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <button data-act="addLine">＋ Add line</button>
    </div>
    <div class="actionsBar">${view.queue ? '<button data-act="nextDraft">Skip this PDF</button>' : '<button data-act="home">Cancel</button>'}<button class="primary" data-act="saveDraft">Save pick ticket</button></div>`;
}

function pickerSelect(t) {
  return `<label class="pickerSel">Picker<select id="pickerSelect" data-act-change="picker">
      <option value="">Choose your name</option>
      ${db.pickers.map(n => `<option ${t.picker === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      <option value="__new">＋ Add my name…</option></select></label>`;
}

function orderBlock(t) {
  return `<div class="orderInfo">
    <div><span class="lbl">Order</span><strong>${esc(t.orderNumber)}</strong></div>
    <div><span class="lbl">Pick ticket</span><strong>${esc(t.ticket)}</strong></div>
    <div><span class="lbl">Type</span>${esc(t.type)}</div>
    <div><span class="lbl">Taker</span>${esc(t.taker || '—')}</div>
    <div><span class="lbl">Customer</span>${esc(t.customer || '—')}</div>
    <div><span class="lbl">Customer #</span><strong>${esc(t.customerId || '—')}</strong></div>
    <div class="addr"><span class="lbl">Bill to</span><pre>${esc(t.billTo || '—')}</pre></div>
    <div class="addr"><span class="lbl">Ship to</span><pre>${esc(t.shipTo || '—')}</pre></div>
  </div>`;
}

function ticketView(t) {
  if (t.status === 'done') return reportsView(t);
  const lines = sortedLines(t), done = pickedCount(t), all = allDone(t), probs = ticketProblems(t).length, left = t.lines.length - done;
  const needPicker = !t.picker;
  const next = !all ? `${left} line${left === 1 ? '' : 's'} left`
    : nextStep(t) === 'inspect' ? 'Inspect' : t.conv ? `Continue conversion · step ${t.conv.step + 1}` : 'Start conversion';
  return `<div class="pageHead"><div><p class="eyebrow">${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</p><h1>Order ${esc(t.orderNumber)}</h1></div>${pickerSelect(t)}</div>
    <details class="panel orderDetails"><summary>Order details</summary>${orderBlock(t)}${t.service ? `<p class="muted">Service item: ${esc(t.service)}</p>` : ''}</details>
    ${t.products.length ? `<div class="panel builds">${t.products.map(p => `<p><span class="chip">${p.kind === 'conversion' ? 'Conversion' : 'Assembly'}</span> <strong>${esc(p.item)}</strong> × ${fmtQty(p.qty)}</p>${p.returns.length ? `<p class="muted">Removed and returned to stock: ${p.returns.map(r => esc(r.item) + ' × ' + fmtQty(r.qty)).join(', ')}</p>` : ''}`).join('')}</div>` : ''}
    ${needPicker ? '<p class="note strong">Choose your name above before picking.</p>' : ''}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${t.lines.length}" aria-valuenow="${done}"><div style="width:${t.lines.length ? done / t.lines.length * 100 : 0}%"></div></div>
    <p class="progressText">${done} of ${t.lines.length} lines done${probs ? ` · <span class="warnText">${probs} discrepanc${probs === 1 ? 'y' : 'ies'}</span>` : ''}</p>
    ${t.lines.some(l => blankBin(l) && !l.bin) ? '<p class="note">The order shows no bin for some lines. Look the bin up on the computer and fill it in.</p>' : ''}
    <ol class="lines ${needPicker ? 'locked' : ''}">${lines.map(l => lineRow(l, needPicker)).join('')}</ol>
    <div class="actionsBar">
      <button data-act="askDelete" data-id="${t.id}" class="quiet">Delete ticket</button>
      <button class="primary" data-act="next" ${all && !needPicker ? '' : 'disabled'}>${next}</button>
    </div>`;
}

function binCell(l, locked) {
  if (!blankBin(l)) return `<div class="bin">${l.bin.split(' / ').map(b => `<span>${esc(b)}</span>`).join('')}</div>`;
  return `<div class="bin"><input class="binBlank" id="bin-${l.id}" data-bin="${l.id}" value="${esc(l.bin)}" placeholder="Fill in bin" aria-label="Bin for ${esc(l.item)}" autocapitalize="characters" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}></div>`;
}
const probChips = l => l.problems.length ? `<span class="probs">${l.problems.map(p => `<span class="chip warn">${fmtQty(p.qty)} ${esc(p.type.toLowerCase())}</span>${p.note ? `<span class="probNote">${esc(p.note)}</span>` : ''}`).join(' ')}</span>` : '';

function lineRow(l, locked) {
  const rem = remaining(l), done = rem === 0, probs = l.problems;
  const dis = locked ? 'disabled' : '';
  return `<li class="line ${done ? (probs.length ? 'hasProblem' : 'done') : ''}">
    ${binCell(l, locked)}
    <div class="what"><span class="item">${esc(l.item)}</span><span class="desc">${esc(l.desc)}</span>${probChips(l)}
      ${l.product ? `<span class="muted small">For ${esc(l.product)}</span>` : ''}</div>
    <div class="qty"><span class="lbl">To pick</span><strong>${fmtQty(l.qty)}</strong>${l.picked && !done ? `<small>${fmtQty(l.picked)} picked</small>` : ''}</div>
    <div class="acts">${done
      ? `<span class="doneMark">${probs.length ? (l.picked ? fmtQty(l.picked) + ' picked' : 'None picked') : '✓ Picked'}</span><button class="small quiet" data-act="undo" data-id="${l.id}" ${dis}>Undo</button>`
      : `<button class="pick" data-act="pickAll" data-id="${l.id}" ${dis}>✓ Picked${rem !== l.qty ? ' ' + fmtQty(rem) : ''}</button><button class="problem" data-act="problem" data-id="${l.id}" ${dis}>Problem</button>`}</div>
  </li>`;
}

// ---------- inspect ----------
function inspectView(t) {
  const probs = hasProblems(t);
  return `<div class="pageHead"><div><p class="eyebrow">Inspect · ${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</p><h1>Order ${esc(t.orderNumber)}</h1></div></div>
    <p class="note">Quick visual check of what you picked: the quantities are correct and nothing is damaged. Tap Problem on anything that isn't right.</p>
    <ol class="lines">${sortedLines(t).map(inspectRow).join('')}</ol>
    <div class="actionsBar"><button class="quiet" data-act="backToTicket">‹ Back to picking</button>
      <button class="primary" data-act="inspectDone">${probs ? 'Inspection done, print reports' : 'Inspection done, save order'}</button></div>`;
}
function inspectRow(l) {
  return `<li class="line ${l.problems.length ? 'hasProblem' : ''}">
    ${binCell(l, false)}
    <div class="what"><span class="item">${esc(l.item)}</span><span class="desc">${esc(l.desc)}</span>${probChips(l)}</div>
    <div class="qty"><span class="lbl">Picked</span><strong>${fmtQty(l.picked)}</strong></div>
    <div class="acts">${l.picked > 0 ? `<button class="problem" data-act="problemPicked" data-id="${l.id}">Problem</button>` : ''}</div>
  </li>`;
}

// ---------- conversion ----------
function convertView(t) {
  const steps = convSteps(t), i = Math.min(t.conv.step, steps.length - 1), s = steps[i], model = convNames(t).model;
  return `<div class="pageHead"><div><p class="eyebrow">Conversion${model ? ' · ' + esc(model) : ''}</p><h1>Order ${esc(t.orderNumber)}</h1></div></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${i}"><div style="width:${i / steps.length * 100}%"></div></div>
    <p class="stepCount">Step ${i + 1} of ${steps.length}</p>
    <section class="panel stepCard">
      <p class="stepText">${esc(s.text)}</p>
      ${s.sub ? `<p class="stepSub">${esc(s.sub)}</p>` : ''}
      ${s.key === 'inventory' ? returnBins(t) : ''}
    </section>
    ${s.key === 'install' ? chartsHtml() : ''}
    ${s.key === 'labels' ? labelCards(t) : ''}
    <div class="actionsBar">
      <button class="quiet" data-act="${i ? 'convPrev' : 'backToTicket'}">${i ? '‹ Previous step' : '‹ Back to picking'}</button>
      ${s.problemIf
        ? '<button class="answer" data-act="convNo">No</button><button class="answer" data-act="convYes">Yes</button>'
        : `<button class="primary" data-act="convDone">${s.key === 'inventory' ? 'Save the order and move on' : 'Done'}</button>`}
    </div>`;
}

function chartsHtml() {
  const rows = list => list.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  return `<div class="charts">
    <section class="chart" aria-labelledby="torqueHead"><h3 id="torqueHead">LMI Torque Specifications</h3>
      <table><thead><tr><th>LMI Pump Series</th><th>Pump Head / Liquid-End Screws</th></tr></thead><tbody>${rows(TORQUE)}</tbody></table>
      <table><thead><tr><th colspan="2" class="center">MFV Torque Specs</th></tr></thead><tbody>${rows(MFV)}</tbody></table></section>
    <section class="chart" aria-labelledby="strokeHead"><h3 id="strokeHead">Liquifram<sup>®</sup> Stroke Setting Chart</h3>
      <table><thead><tr><th>Pump</th><th>Stroke Knob Setting</th></tr></thead><tbody>${rows(STROKE)}</tbody></table></section>
  </div>`;
}

function labelCards(t) {
  if (!t.labels.length) return '';
  return `<section class="panel labels"><p class="muted">Enter the original pump's serial number and power, check the ratings, then make the label sheet.</p>
    ${t.labels.map(c => `<div class="labelCard">
      <h3>${esc(c.model)}${c.of > 1 ? ` <span class="muted">pump ${c.unit} of ${c.of}</span>` : ''}</h3>
      <div class="grid six">
        ${[['model', 'Model'], ['serial', 'Serial number'], ['power', 'Power'], ['gph', 'GPH'], ['psi', 'PSI'], ['lph', 'LPH'], ['bar', 'BAR'], ['removed', 'Removed liquid end (ITEM #)']].map(([k, label]) =>
          `<label>${label}<input id="lab-${c.id}-${k}" data-label="${c.id}" data-key="${k}" value="${esc(c[k])}" ${['gph', 'psi', 'lph', 'bar', 'power'].includes(k) ? 'inputmode="decimal"' : ''}></label>`).join('')}
      </div>
      <button data-act="makeLabels" data-id="${c.id}">Make label sheet</button>${c.madeAt ? ` <span class="muted small">Made ${esc(fmtDate(c.madeAt))}</span>` : ''}
    </div>`).join('')}</section>`;
}

// Where the removed liquid end goes back on the shelf. A bin the order didn't print is a blank to fill in.
function returnBins(t) {
  return t.products.map((p, pi) => (p.returns || []).map((r, ri) => {
    const blank = r.binBlank || !r.bin;
    return `<div class="binField"><span class="lbl">Bin for ${esc(r.item)}${r.qty !== 1 ? ' × ' + fmtQty(r.qty) : ''}</span>${blank
      ? `<input class="binBlank" id="ret-${pi}-${ri}" data-retbin="${pi}:${ri}" value="${esc(r.bin)}" placeholder="Fill in bin" aria-label="Bin for ${esc(r.item)}" autocapitalize="characters" autocomplete="off" spellcheck="false">
        <small class="muted">The order doesn't show a bin for ${esc(r.item)}. Look it up on the computer.</small>`
      : `<div class="bin"><span>${esc(r.bin)}</span></div>`}</div>`;
  }).join('')).join('');
}

// ---------- reports (printed only when there are discrepancies) ----------
function reportHeader(t, title) {
  return `<header class="rHead"><h1>${title}</h1>
    <table class="rMeta"><tr><th>Order</th><td>${esc(t.orderNumber)}</td><th>Pick ticket</th><td>${esc(t.ticket)}</td><th>Type</th><td>${esc(t.type)}</td></tr>
    <tr><th>Taker</th><td>${esc(t.taker || '—')}</td><th>Picker</th><td>${esc(t.picker || '—')}</td><th>Date</th><td>${esc(fmtDate(t.completedAt || now()))}</td></tr>
    <tr><th>Customer</th><td colspan="3">${esc(t.customer || '—')}</td><th>Customer #</th><td>${esc(t.customerId || '—')}</td></tr></table>
    <div class="rAddr"><div><strong>Bill To</strong><pre>${esc(t.billTo || '—')}</pre></div><div><strong>Ship To</strong><pre>${esc(t.shipTo || '—')}</pre></div></div>
  </header>`;
}
// Each discrepancy is its own row group, so its optional notes line stays with it.
const reportRows = (t, cells) => ticketProblems(t).map(p => `<tbody class="${p.note ? 'hasNote' : ''}"><tr>${cells(p)}</tr>${p.note ? `<tr class="rNoteRow"><td colspan="4"><span class="rNoteLbl">Notes</span>${esc(p.note)}</td></tr>` : ''}</tbody>`).join('');
function takerReport(t) {
  return `<section class="report"><p class="rStamp">INCOMPLETE</p>${reportHeader(t, 'Taker report')}
    <p class="rLead">These items were not delivered on this pick ticket.</p>
    <table class="rTable"><thead><tr><th>Item</th><th>Description</th><th class="num">Missing</th><th>Discrepancy</th></tr></thead>
    ${reportRows(t, p => `<td><strong>${esc(p.line.item)}</strong></td><td>${esc(p.line.desc)}</td><td class="num">${fmtQty(p.qty)}</td><td>${esc(p.type)}</td>`)}
    </table></section>`;
}
function adjustmentReport(t) {
  return `<section class="report">${reportHeader(t, 'Inventory adjustment report')}
    <table class="rTable"><thead><tr><th>Item</th><th class="num">Qty</th><th>Bin</th><th>Discrepancy</th></tr></thead>
    ${reportRows(t, p => `<td><strong>${esc(p.line.item)}</strong></td><td class="num">${fmtQty(p.qty)}</td><td>${esc(p.line.bin)}</td><td>${esc(p.type)}</td>`)}
    </table></section>`;
}
const reportsHtml = t => takerReport(t) + adjustmentReport(t);
// Two copies of each: one stays with the order (or the deficient item), the other goes to the Taker (or the adjuster).
const printHtml = t => takerReport(t).repeat(2) + adjustmentReport(t).repeat(2);

function reportsView(t) {
  const done = t.status === 'done';
  if (!hasProblems(t)) return done ? cleanView(t) : ticketView(t);
  return `<div class="pageHead"><div><p class="eyebrow">${done ? 'Completed ' + esc(fmtDate(t.completedAt)) : 'Print reports'}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <div class="note strong printSteps">
      <p>Printing makes 2 copies of each report${done ? '' : ' and completes this pick ticket'}.</p>
      <p><strong>Taker report:</strong> Place 1 copy of the Taker report with the order and take the other copy to the Taker.</p>
      <p><strong>Inventory adjustment report:</strong> Attach 1 copy of the inventory report to the deficient item and place that item in the designated area. Give the other copy of the inventory report to the inventory adjuster.${ticketProblems(t).every(p => p.type === 'Not available') ? ' If the item is Not available, discard the extra copy.' : ''}</p>
    </div>
    ${embedded ? '<p class="note">Printing works in the installed iPad app. It is blocked inside this preview window.</p>' : ''}
    <div class="paper">${reportsHtml(t)}</div>
    <div class="actionsBar">
      ${done ? '<button data-act="home">Back to tickets</button>' : '<button data-act="backToTicket">Back to picking</button>'}
      <button class="primary" data-act="print">${done ? 'Print again' : 'Print reports & complete'}</button>
    </div>`;
}

// A pick ticket finished with no discrepancies: nothing was printed.
function cleanView(t) {
  const back = returnsOf(t).filter(r => r.bin);
  return `<div class="pageHead"><div><p class="eyebrow">Completed ${esc(fmtDate(t.completedAt))}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <p class="note">Completed by ${esc(t.picker || 'the picker')} with no discrepancies, so there are no reports to print.</p>
    <div class="panel">${orderBlock(t)}${back.length ? `<p class="returned">Returned to inventory: ${back.map(r => `<strong>${esc(r.item)}</strong> in bin <strong>${esc(r.bin)}</strong>`).join(', ')}</p>` : ''}</div>
    <div class="actionsBar"><button data-act="home">Back to tickets</button></div>`;
}

function settingsView() {
  return `<div class="pageHead"><div><p class="eyebrow">This iPad</p><h1>Settings & backup</h1></div></div>
    <div class="panel"><h3>Backup</h3><p class="muted">Everything is saved on this iPad only. Save a backup file now and then, for example to Files or OneDrive.</p>
      <div class="row"><button data-act="backup">Save backup file</button><label class="fileBtn">Restore from backup<input id="restoreFile" type="file" accept=".json,application/json" data-act-change="restore"></label></div>
      <p class="muted small">Restore adds pick tickets that aren't already on this iPad. Nothing is overwritten.</p></div>
    <div class="panel"><h3>Picker names</h3>${db.pickers.length ? `<ul class="names">${db.pickers.map(n => `<li>${esc(n)} <button class="small quiet" data-act="dropPicker" data-name="${esc(n)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted">Names are added the first time a picker chooses "Add my name".</p>'}</div>
    ${flowPanel()}
    <div class="panel"><h3>About</h3><p class="muted">Assemblies & Conversions · pilot version 2 · ${db.tickets.length} pick tickets saved</p></div>`;
}

const flowUrl = () => { try { return localStorage.getItem(FLOW) || ''; } catch (e) { return ''; } };
function flowPanel() {
  const f = view.flow;
  return `<div class="panel"><h3>Pick tickets from Power Automate</h3><p class="muted">Test only for now. Paste the flow's web address, then tap Test. The address stays on this iPad.</p>
    <div class="flowTest"><label>Flow address<input id="flowUrl" type="url" value="${esc(flowUrl())}" placeholder="https://" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <button data-act="testFlow" ${f && f.busy ? 'disabled' : ''}>${f && f.busy ? 'Testing…' : 'Test'}</button>
      ${f && !f.busy ? `<p class="note${f.ok ? '' : ' strong'}">${esc(f.text)}</p>` : ''}</div></div>`;
}

// Settings > Test: can this iPad call the flow and read its answer? A POST with a plain text body goes out without
// the browser asking the flow's permission first, so the flow only has to add Access-Control-Allow-Origin to its answer.
async function askFlow(url) {
  if (!navigator.onLine) return { ok: false, text: 'This iPad is offline. Connect to Wi-Fi, then test again.' };
  const ask = async mode => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60000);
    try { return await fetch(url, { method: 'POST', mode, body: '{"test":true}', signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  };
  let res;
  try { res = await ask('cors'); }
  catch (e) {
    if (e.name === 'AbortError') return { ok: false, text: 'The flow took more than a minute to answer. Check that it is turned on, then test again.' };
    // Safari only says "Load failed". Asking again without reading the answer tells "can't reach it" from "not allowed to read it".
    const reached = await ask('no-cors').then(() => true, () => false);
    return { ok: false, text: reached
      ? 'The flow answered, but the iPad is not allowed to read the answer. In the flow, check that Who can trigger the flow is set to Anyone and that the Response step has the header Access-Control-Allow-Origin with the value *.'
      : 'The iPad could not reach the flow. Check that the whole address was pasted, then test again.' };
  }
  const text = await res.text().catch(() => '');
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const why = data && data.error && data.error.message;
    return { ok: false, text: `The flow answered with error ${res.status}${why ? ': ' + why : '.'}${[401, 403].includes(res.status) ? ' In the flow, set Who can trigger the flow to Anyone.' : ''}` };
  }
  const files = Array.isArray(data) ? data : data && [data.value, data.body].find(Array.isArray);
  if (!files) return { ok: false, text: `The flow answered, but not with a list of files. Its answer was: ${text.slice(0, 200) || '(empty)'}` };
  const names = files.filter(f => f && !f.IsFolder).map(f => f.Name || f.DisplayName || f.name).filter(Boolean);
  if (!names.length) return { ok: true, text: 'It works. The flow answered, and there are no files in the folder yet.' };
  const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? ` and ${names.length - 10} more` : '');
  return { ok: true, text: `It works. The flow sees ${names.length} ${names.length === 1 ? 'file' : 'files'} in the folder: ${shown}.` };
}

// ---------- bottom sheet (problem entry, picker name, delete) ----------
// A problem found while picking can be any of the three types. One found after picking (inspection or conversion)
// is Damaged or Incomplete package, and comes off the picked quantity.
const sheetMax = (l, s) => s.picked ? l.picked : remaining(l);

function renderSheet() {
  const s = view.sheet, el = $('#sheet');
  if (!s) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (s.kind === 'problem') {
    const t = ticketById(view.id), l = s.lineId ? t.lines.find(x => x.id === s.lineId) : null, max = l ? sheetMax(l, s) : 0;
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      ${s.choose
        ? `<h2 id="sheetTitle">Which part was missing or damaged?</h2>
          <div class="chooser">${s.choose.map(id => t.lines.find(x => x.id === id)).map(x => `<button class="choice ${x.id === s.lineId ? 'on' : ''}" data-act="pLine" data-id="${x.id}" aria-pressed="${x.id === s.lineId}"><span class="item">${esc(x.item)}</span><small>${esc(x.desc)}</small></button>`).join('')}</div>`
        : `<h2 id="sheetTitle">Problem with ${esc(l.item)}</h2><p class="muted">${esc(l.desc)} · bin ${esc(l.bin || '—')}</p>`}
      ${l ? `<div class="choices">${(s.picked ? AFTER_PICK : PROBLEMS).map(p => `<button class="choice ${s.type === p ? 'on' : ''}" data-act="pType" data-type="${p}" aria-pressed="${s.type === p}">${p}</button>`).join('')}</div>
      <div class="stepper"><span>How many?</span><button class="icon" data-act="pDec" aria-label="Fewer">−</button><output id="pQty">${fmtQty(s.qty)}</output><button class="icon" data-act="pInc" aria-label="More">＋</button><span class="muted">of ${fmtQty(max)} ${s.picked ? 'picked' : 'left'}</span></div>
      <label class="noteField">Notes<input id="pNote" value="${esc(s.note || '')}" placeholder="Optional. Prints on the reports." maxlength="200" autocomplete="off" enterkeyhint="done"></label>` : ''}
      <div class="actionsBar"><button data-act="closeSheet">Cancel</button><button class="primary" data-act="saveProblem" ${l && s.type ? '' : 'disabled'}>Record problem</button></div></div>`;
  } else if (s.kind === 'name') {
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">Add your name</h2>
      <p class="muted">It's saved on this iPad so you can pick it from the list next time.</p>
      <label>Name<input id="newName" autocomplete="name" autocapitalize="words"></label>
      <div class="actionsBar"><button data-act="closeSheet">Cancel</button><button class="primary" data-act="saveName">Save name</button></div></div>`;
    setTimeout(() => $('#newName') && $('#newName').focus(), 50);
  } else if (s.kind === 'file') {
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">${esc(s.title)}</h2>
      <p class="muted">${esc(s.file.name)}</p>
      <div class="actionsBar"><button data-act="closeSheet">Close</button><button class="primary" data-act="shareFile">Print or save</button></div></div>`;
  } else if (s.kind === 'delete') {
    const t = ticketById(s.id);
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">Delete pick ticket ${esc(t.ticket)}?</h2>
      <p class="muted">Its picking progress is removed from this iPad. This can't be undone.</p>
      <div class="actionsBar"><button data-act="closeSheet">Keep it</button><button class="danger" data-act="doDelete">Delete</button></div></div>`;
  }
}

// ---------- actions ----------
const current = () => ticketById(view.id);
const lineById = id => current().lines.find(x => x.id === id);
const go = (screen, id = view.id) => { view.screen = screen; view.id = id; view.sheet = view.flow = null; if (screen !== 'review') view.queue = view.note = null; render(); window.scrollTo(0, 0); };
const stamp = (t, text) => { (t.log = t.log || []).push({ at: now(), text }); };

function openProblem(l, picked, then = null) {
  view.sheet = { kind: 'problem', lineId: l.id, type: '', qty: picked ? Math.min(1, l.picked) : remaining(l), picked, then, choose: null };
  renderSheet();
}

// Share sheet on the iPad, a download elsewhere. Sharing needs a fresh tap, so a file that took a while to make gets a button.
async function deliverFile(blob, name, title, tip) {
  const file = new File([blob], name, { type: blob.type });
  if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); if (tip) toast(tip); }
    catch (e) { if (e.name === 'NotAllowedError') { $('#toast').hidden = true; view.sheet = { kind: 'file', file, title, tip }; renderSheet(); } }
    return;
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (tip) toast(tip);
}

// The one-file offline copy carries the label sheet inside it, since a page opened from a file can't fetch another file.
async function labelTemplateBytes() {
  if (window.LABEL_TEMPLATE) return Uint8Array.from(atob(window.LABEL_TEMPLATE), c => c.charCodeAt(0));
  const r = await fetch('label-template.pdf'); if (!r.ok) throw Error(); return r.arrayBuffer();
}

function completeOrder(t) {
  t.status = 'done'; t.completedAt = now(); stamp(t, 'Saved with no discrepancies'); save();
  go('home', null); toast(`Order ${t.orderNumber} saved. On to the next one.`);
}

// Yes or No on a conversion question. The answer that means a discrepancy records it, then the reports print.
function answer(yes) {
  const t = current(), s = convSteps(t)[t.conv.step];
  stamp(t, `${s.text} ${yes ? 'Yes' : 'No'}`);
  if ((s.problemIf === 'yes') !== yes) { t.conv.step++; save(); return go('convert'); }
  save();
  const picked = t.lines.filter(l => l.picked > 0);
  if (s.line && s.line.picked > 0) return openProblem(s.line, true, 'reports');
  if (!picked.length) return go('reports');
  view.sheet = { kind: 'problem', lineId: picked.length === 1 ? picked[0].id : null, type: '', qty: picked.length === 1 ? Math.min(1, picked[0].picked) : 0, picked: true, then: 'reports', choose: picked.map(l => l.id) };
  renderSheet();
}

const actions = {
  home: () => go('home', null),
  back: () => { const t = current(); if (t && t.status !== 'done' && ['reports', 'inspect', 'convert'].includes(view.screen)) go('ticket'); else go('home', null); },
  settings: () => go('settings', null),
  testFlow: async () => {
    const url = $('#flowUrl').value.trim();
    try { if (url) localStorage.setItem(FLOW, url); else localStorage.removeItem(FLOW); } catch (e) { /* kept for this visit only */ }
    if (!/^https:\/\/\S+$/i.test(url)) { view.flow = { ok: false, text: 'Paste the whole flow address first. It starts with https://' }; return render(); }
    view.flow = { busy: true }; render();
    const result = await askFlow(url);
    if (view.flow && view.flow.busy) { view.flow = result; render(); }
  },
  import: () => $('#pdfInput').click(),
  manual: () => { view.draft = { fromPdf: false, type: 'Sales', orderNumber: '', ticket: '', taker: '', customer: '', customerId: '', billTo: '', shipTo: '', service: '', products: [], lines: [{ item: '', desc: '', qty: 1, bin: '' }] }; go('review', null); },
  addLine: () => { view.draft.lines.push({ item: '', desc: '', qty: 1, bin: '' }); render(); },
  dropLine: b => { view.draft.lines.splice(+b.dataset.i, 1); render(); },
  saveDraft: () => {
    const d = view.draft;
    d.lines = d.lines.filter(l => String(l.item).trim());
    const problem = draftProblem(d); if (problem) return toast(problem);
    const dup = db.tickets.find(t => t.ticket === d.ticket.trim());
    if (dup) return toast(`Pick ticket ${d.ticket} is already saved${dup.status === 'done' ? ' and completed' : ''}.`);
    const t = newTicketFrom(d); stamp(t, d.fromPdf ? 'Imported from PDF' : 'Entered by hand');
    db.tickets.push(t); save();
    if (view.queue) actions.nextDraft(null, `Pick ticket ${t.ticket} added to In progress.`);
    else { view.draft = null; go('ticket', t.id); }
  },
  // After several PDFs came in at once: the next one that needs checking, or home when none are left.
  nextDraft: (b, note = '') => {
    if (view.queue && view.queue.length) { view.draft = view.queue.shift(); view.note = note; go('review', null); }
    else { view.draft = null; go('home', null); if (note) toast(note); }
  },
  open: b => go('ticket', b.dataset.id),
  pickAll: b => { const t = current(), l = lineById(b.dataset.id); l.picked = l.qty - problemQty(l); stamp(t, `${l.item}: picked ${fmtQty(l.picked)}`); save(); render(); },
  undo: b => { const t = current(), l = lineById(b.dataset.id); l.picked = 0; l.problems = []; stamp(t, `${l.item}: reset`); save(); render(); },
  problem: b => openProblem(lineById(b.dataset.id), false),
  problemPicked: b => openProblem(lineById(b.dataset.id), true),
  pLine: b => { const l = lineById(b.dataset.id); Object.assign(view.sheet, { lineId: l.id, qty: Math.min(1, l.picked) }); renderSheet(); },
  pType: b => { view.sheet.type = b.dataset.type; renderSheet(); },
  pDec: () => { const s = view.sheet, max = sheetMax(lineById(s.lineId), s); s.qty = Math.max(Math.min(1, max), s.qty - 1); renderSheet(); },
  pInc: () => { const s = view.sheet, max = sheetMax(lineById(s.lineId), s); s.qty = Math.min(max, s.qty + 1); renderSheet(); },
  saveProblem: () => {
    const t = current(), s = view.sheet, l = s.lineId && lineById(s.lineId);
    if (!l) return;
    const qty = Math.min(s.qty, sheetMax(l, s));
    if (!s.type || !(qty > 0)) return;
    if (s.picked) l.picked -= qty;
    const note = (s.note || '').trim().replace(/\s+/g, ' ');
    const same = l.problems.find(p => p.type === s.type);
    if (same) { same.qty += qty; if (note) same.note = same.note ? `${same.note}; ${note}` : note; }
    else l.problems.push({ type: s.type, qty, note });
    stamp(t, `${l.item}: ${fmtQty(qty)} ${s.type.toLowerCase()}${s.picked ? ' (found after picking)' : ''}${note ? '. Note: ' + note : ''}`);
    // A problem on part of a line leaves the rest to pick; a full-line problem finishes the line.
    save(); view.sheet = null;
    if (s.then === 'reports') go('reports'); else render();
  },
  closeSheet: () => { view.sheet = null; renderSheet(); },
  saveName: () => {
    const name = ($('#newName').value || '').trim().replace(/\s+/g, ' ');
    if (!name) return toast('Type your name first.');
    if (!db.pickers.some(n => n.toLowerCase() === name.toLowerCase())) db.pickers.push(name);
    db.pickers.sort((a, b) => a.localeCompare(b));
    const t = current(); if (t) { t.picker = db.pickers.find(n => n.toLowerCase() === name.toLowerCase()); stamp(t, 'Picker: ' + t.picker); }
    save(); view.sheet = null; render();
  },
  dropPicker: b => { db.pickers = db.pickers.filter(n => n !== b.dataset.name); save(); render(); },
  askDelete: b => { view.sheet = { kind: 'delete', id: b.dataset.id }; renderSheet(); },
  doDelete: () => { db.tickets = db.tickets.filter(t => t.id !== view.sheet.id); save(); go('home', null); toast('Pick ticket deleted.'); },
  next: () => {
    const t = current();
    if (!allDone(t)) return toast('Finish every line first.');
    if (!t.picker) return toast('Choose your name first.');
    if (nextStep(t) === 'inspect') return go('inspect');
    if (!t.conv) { t.conv = { step: 0 }; stamp(t, 'Conversion started'); save(); }
    go('convert');
  },
  inspectDone: () => { const t = current(); stamp(t, 'Inspection done'); if (hasProblems(t)) { save(); go('reports'); } else completeOrder(t); },
  convDone: () => {
    const t = current(), s = convSteps(t)[t.conv.step];
    if (s.key === 'labels' && labelsLeft(t)) return toast('Make the label sheet first.');
    if (s.key === 'inventory') {
      const open = returnsOf(t).filter(r => !r.bin);
      if (open.length) return toast(`Fill in the bin for ${open.map(r => r.item).join(', ')}. Look it up on the computer.`);
      if (returnsOf(t).length) stamp(t, 'Returned to inventory: ' + returnsOf(t).map(r => `${r.item} bin ${r.bin}`).join(', '));
      return completeOrder(t);
    }
    t.conv.step++; save(); go('convert');
  },
  convPrev: () => { const t = current(); t.conv.step = Math.max(0, t.conv.step - 1); save(); go('convert'); },
  convYes: () => answer(true),
  convNo: () => answer(false),
  backToTicket: () => go('ticket'),
  print: () => {
    const t = current();
    const first = t.status !== 'done';
    if (first) { t.status = 'done'; t.completedAt = now(); stamp(t, 'Reports printed, pick ticket completed'); save(); }
    $('#printArea').innerHTML = printHtml(t);
    render();
    if (embedded) toast(first ? 'Pick ticket completed. Print from the installed iPad app.' : 'Printing works in the installed iPad app.');
    else setTimeout(() => window.print(), 100);
  },
  makeLabels: async b => {
    const t = current(), c = t.labels.find(x => x.id === b.dataset.id);
    const missing = ['model', 'serial', 'power', 'gph', 'psi', 'lph', 'bar', 'removed'].filter(k => !String(c[k] || '').trim());
    if (missing.length) return toast('Fill in: ' + missing.map(k => k === 'removed' ? 'removed liquid end' : k.toUpperCase()).join(', ') + '.');
    try {
      const bytes = await labelTemplateBytes();
      const pdf = await PDFLib.PDFDocument.load(bytes), form = pdf.getForm();
      for (const n of ['1', '2', '3']) { form.getTextField('MODEL ' + n).setText(c.model); form.getTextField('SERIAL ' + n).setText(c.serial); }
      for (const k of ['POWER', 'LPH', 'BAR', 'GPH', 'PSI']) form.getTextField(k).setText(String(c[k.toLowerCase()]));
      form.getTextField('ITEM').setText(c.removed);
      form.flatten();
      const blob = new Blob([await pdf.save()], { type: 'application/pdf' });
      c.madeAt = now(); stamp(t, `Label sheet made: ${c.model} serial ${c.serial}`); save(); render();
      if (embedded) return toast('Label sheet made. Opening it works in the installed iPad app.');
      await deliverFile(blob, `${t.orderNumber} - ${c.model} - ${c.serial} - labels.pdf`.replace(/[\\/:*?"<>|]/g, '_'), 'Label sheet ready', 'Print the label sheet at actual size on label paper.');
    } catch (e) { console.error(e); toast('The label sheet could not be made.'); }
  },
  shareFile: async () => {
    const s = view.sheet; view.sheet = null; renderSheet();
    try { await navigator.share({ files: [s.file] }); if (s.tip) toast(s.tip); } catch (e) { if (e.name !== 'AbortError') toast('The share sheet could not open.'); }
  },
  backup: () => {
    if (embedded) return toast('Saving files works in the installed iPad app.');
    const blob = new Blob([JSON.stringify({ format: 'ac-picking-backup-1', savedAt: now(), ...db })], { type: 'application/json' });
    return deliverFile(blob, `Picking backup ${new Date().toISOString().slice(0, 10)}.json`, 'Backup ready', 'Backup file saved.');
  }
};

const changeActions = {
  picker: async el => {
    const t = current();
    if (el.value === '__new') { el.value = t.picker || ''; view.sheet = { kind: 'name' }; renderSheet(); return; }
    t.picker = el.value; if (t.picker) stamp(t, 'Picker: ' + t.picker); save(); render();
  },
  restore: async el => {
    const file = el.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'ac-picking-backup-1' || !Array.isArray(data.tickets)) throw Error();
      const ok = data.tickets.filter(t => t && typeof t.id === 'string' && Array.isArray(t.lines) && !db.tickets.some(x => x.id === t.id || x.ticket === t.ticket));
      db.tickets.push(...ok);
      for (const n of data.pickers || []) if (typeof n === 'string' && !db.pickers.includes(n)) db.pickers.push(n);
      save(); render(); toast(`${ok.length} pick ticket${ok.length === 1 ? '' : 's'} restored.`);
    } catch (e) { toast('That file is not a backup from this app.'); }
    el.value = '';
  }
};

async function readPdf(file) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n), vp = page.getViewport({ scale: 1 }), content = await page.getTextContent();
    pages.push(content.items.filter(i => i.str && i.str.trim()).map(i => ({ text: i.str, x: i.transform[4], y: vp.height - i.transform[5] })));
  }
  await doc.destroy();
  const d = P.parsePages(pages);
  return { fromPdf: true, ...d, lines: d.lines.map(l => ({ ...l })) };
}

async function importPdf(file) {
  if (!file) return;
  toast('Reading ' + file.name + '…');
  try {
    view.draft = await readPdf(file);
    $('#toast').hidden = true;
    go('review', null);
  } catch (e) { console.error(e); toast('This PDF could not be read. Use Enter by hand instead.'); }
}

// Several PDFs at once, such as the new tickets in the shared pick ticket folder. A ticket that reads cleanly goes
// straight onto the In progress list, one the app already has is skipped, and the rest wait on the check screen.
let importing = false;
async function importPdfs(files) {
  files = files.filter(f => /pdf/i.test(f.type + f.name));
  if (files.length < 2) return importPdf(files[0]);
  if (importing) return toast('Still reading the last PDFs.');
  importing = true;
  let added = 0, already = 0; const unread = [], check = [];
  try {
    for (const [i, file] of files.entries()) {
      toast(`Reading ${i + 1} of ${files.length}…`, 60000);
      let d;
      try { d = await readPdf(file); } catch (e) { console.error(e); unread.push(file.name); continue; }
      if (d.ticket.trim() && db.tickets.some(t => t.ticket === d.ticket.trim())) already++;
      else if (draftProblem(d) || d.lines.some(l => !String(l.item).trim())) check.push(d);
      else { const t = newTicketFrom(d); stamp(t, 'Imported from PDF'); db.tickets.push(t); added++; }
    }
  } finally { importing = false; }
  save();
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const msg = !added && !check.length && !unread.length ? `All ${already} pick tickets are already in the app.` : [
    added && `${n(added, 'pick ticket', 'pick tickets')} added to In progress.`,
    already && `${n(already, 'was', 'were')} already in the app.`,
    check.length && `${n(check.length, 'needs', 'need')} checking.`,
    unread.length && `Could not read ${unread.join(', ')}. Use Enter by hand for ${unread.length === 1 ? 'it' : 'those'}.`
  ].filter(Boolean).join(' ');
  // On the check screen the summary sits above the form, where a toast would cover its buttons.
  if (check.length) { $('#toast').hidden = true; view.draft = check.shift(); view.queue = check; view.note = msg; go('review', null); }
  else { go('home', null); toast(msg, 10000); }
}

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
  const fn = actions[b.dataset.act]; if (!fn) return;
  e.preventDefault(); Promise.resolve(fn(b)).catch(err => { console.error(err); toast('Something went wrong. Try again.'); });
});
document.addEventListener('change', e => { const fn = changeActions[e.target.dataset.actChange]; if (fn) fn(e.target); });
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.draft) view.draft[el.dataset.draft] = el.value;
  else if (el.dataset.line) view.draft.lines[+el.dataset.line][el.dataset.key] = el.value;
  else if (el.dataset.bin) { const l = lineById(el.dataset.bin); l.bin = el.value.trim().toUpperCase(); l.binBlank = true; save(); }
  else if (el.dataset.retbin) {
    const [pi, ri] = el.dataset.retbin.split(':').map(Number), r = current().products[pi].returns[ri];
    r.bin = el.value.trim().toUpperCase(); r.binBlank = true; save();
  }
  else if (el.dataset.label) {
    const t = current(), c = t.labels.find(x => x.id === el.dataset.label);
    c[el.dataset.key] = el.value.trim();
    if (el.dataset.key === 'gph') { c.lph = P.toLph(c.gph); const o = $(`#lab-${c.id}-lph`); if (o) o.value = c.lph; }
    if (el.dataset.key === 'psi') { c.bar = P.toBar(c.psi); const o = $(`#lab-${c.id}-bar`); if (o) o.value = c.bar; }
    save();
  }
  else if (el.id === 'pNote' && view.sheet) view.sheet.note = el.value;
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') actions.closeSheet(); });
$('#toast').addEventListener('click', e => { e.currentTarget.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && view.sheet) actions.closeSheet(); if (e.key === 'Enter' && view.sheet && view.sheet.kind === 'name') actions.saveName(); if (e.key === 'Enter' && e.target.id === 'pNote') e.target.blur(); });
$('#pdfInput').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; importPdfs(files); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); importPdfs([...e.dataTransfer.files]); });

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
load(); render();
if ('serviceWorker' in navigator && !embedded && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
