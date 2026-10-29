'use strict';
// Assemblies & Conversions: one pick ticket at a time, on one iPad, offline.
// Shipping picks; here each item is checked off one at a time, then a conversion's steps, and reports print only
// when there are discrepancies (john 2026-10-29).
const P = TicketParser;
const PROBLEMS = ['Damaged', 'Incomplete package', 'Not available'];
const AFTER_PICK = ['Damaged', 'Incomplete package']; // what a conversion can find in parts already checked
const STORE = 'ac-picking-v1';
// The Power Automate flows' web addresses work like passwords, so they stay on this iPad, out of the ticket store and backups.
const FLOW = 'ac-picking-flow', FILEFLOW = 'ac-picking-fileflow', SEEN = 'ac-picking-seen';
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
let view = { screen: 'home', id: null, draft: null, sheet: null, confirmDelete: null, queue: null, note: null, flow: null, pending: [] };
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
const labelsLeft = t => t.labels.filter(c => !c.madeAt).length;
const fmtQty = n => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
const isConversion = t => t.products.some(p => p.kind === 'conversion');
const returnsOf = t => t.products.flatMap(p => p.returns || []);
// Once every item is checked: the reports when something is wrong (that stops a conversion), the rest of the conversion
// once the parts it waits for are in, else a conversion's steps, else the order is done.
const nextStep = t => t.waiting ? 'resume' : hasProblems(t) ? 'reports' : isConversion(t) ? 'convert' : 'save';
// A conversion whose every problem has parts needed can be made whole: only the Taker report prints, and the order
// waits for the parts at the step where it stopped instead of completing (john 2026-10-29).
const canWait = t => isConversion(t) && hasProblems(t) && ticketProblems(t).every(p => (p.needs || []).length);
const partsAwaited = t => ticketProblems(t).flatMap(p => (p.needs || []).map(needText)).join(', ');
const qtyList = xs => xs.map(x => `${fmtQty(x.qty)} × ${x.item}`).join(', ');
const responseText = t => { const r = t.response; return `The Taker responded: pick ticket ${esc(r.ticket)} replaces the first one.${r.added.length ? ` Added: ${esc(qtyList(r.added))}.` : ''}${r.removed.length ? ` Taken off: ${esc(qtyList(r.removed))}.` : ''} Check what came in, then tap Continue conversion.`; };
// What the corrected pick ticket says about a problem waiting on parts: its parts needed were added ('parts'), or the
// item itself was taken off, so another one replaces it ('other'). '' when it can't tell, and the inspector is asked.
function cameFor(t, p) {
  const r = t.response; if (!r) return '';
  const added = new Set(r.added.map(x => x.item)), parts = p.needs.every(n => added.has(n.part.toUpperCase())), off = r.removed.some(x => x.item === p.line.item.toUpperCase());
  return parts && !off ? 'parts' : off && !parts ? 'other' : '';
}

function newTicketFrom(draft) {
  return {
    id: uid(), created: now(), status: 'open', picker: '', completedAt: null, conv: null,
    type: draft.type, orderNumber: draft.orderNumber.trim(), ticket: draft.ticket.trim(), taker: draft.taker.trim(),
    customer: draft.customer.trim(), customerId: (draft.customerId || '').trim(), billTo: draft.billTo.trim(), shipTo: draft.shipTo.trim(), service: (draft.service || '').trim(),
    products: (draft.products || []).map(p => ({ ...p, returns: (p.returns || []).map(r => ({ ...r, bin: (r.bin || '').trim(), binBlank: !(r.bin || '').trim() })) })),
    lines: draft.lines.map(l => ({ id: uid(), item: l.item.trim(), desc: l.desc.trim(), bin: (l.bin || '').trim(), qty: +l.qty, product: l.product || '', picked: 0, problems: [] })),
    labels: (draft.products || []).filter(p => p.kind === 'conversion').flatMap(p => Array.from({ length: Math.max(1, Math.round(p.qty)) }, (_, i) => ({ id: uid(), product: p.item, unit: i + 1, of: Math.max(1, Math.round(p.qty)), ...P.labelDefaults(p) })))
  };
}

// A corrected pick ticket for an order waiting for parts joins that order instead of becoming a second card: to add to a
// BOM the Taker cancels the first ticket in P21 and makes a new one (john 2026-10-29). The order is marked as responded
// to, with what the new ticket added or took off. Returns the ticket the new one ended up as.
function addTicket(t) {
  const w = db.tickets.find(x => x.waiting && x.orderNumber === t.orderNumber && x.ticket !== t.ticket);
  if (!w) { db.tickets.push(t); return t; }
  const count = lines => lines.reduce((m, l) => m.set(l.item.toUpperCase(), (m.get(l.item.toUpperCase()) || 0) + l.qty), new Map());
  const was = count(w.lines), got = count(t.lines);
  const more = (a, b) => [...a].filter(([k, q]) => q > (b.get(k) || 0)).map(([item, q]) => ({ item, qty: q - (b.get(item) || 0) }));
  w.response = { ticket: t.ticket, added: more(got, was), removed: more(was, got) };
  stamp(w, `Pick ticket ${t.ticket} came in for this order, replacing ${w.ticket}`);
  w.ticket = t.ticket;
  return w;
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
  else if (view.screen === 'convert' && t && t.conv) main.innerHTML = convertView(t);
  else if (view.screen === 'reports' && t) main.innerHTML = reportsView(t);
  else if (view.screen === 'settings') main.innerHTML = settingsView();
  else { view.screen = 'home'; main.innerHTML = homeView(); }
  renderSheet();
  $('#backBtn').hidden = view.screen === 'home';
}

function stateLabel(t) {
  if (t.waiting) return t.response ? 'Taker responded' : 'Waiting for parts';
  if (!allDone(t)) return `${pickedCount(t)} of ${t.lines.length} lines`;
  if (nextStep(t) !== 'convert') return nextStep(t) === 'reports' ? 'Ready to print reports' : 'Ready to save';
  return t.conv ? `Conversion step ${t.conv.step + 1} of ${convSteps(t).length}` : 'Ready to convert';
}

function homeView() {
  const open = db.tickets.filter(t => t.status === 'open').sort((a, b) => b.created.localeCompare(a.created));
  const done = db.tickets.filter(t => t.status === 'done').sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const card = t => {
    const probs = ticketProblems(t).length;
    return `<button class="ticketCard${t.waiting ? (t.response ? ' responded' : ' waiting') : ''}" data-act="open" data-id="${t.id}">
      <span class="tcMain"><span class="tcOrder">Order ${esc(t.orderNumber)}</span><span class="tcSub">Pick ticket ${esc(t.ticket)} · ${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</span></span>
      <span class="tcState">${t.status === 'done'
        ? `<span class="chip ${probs ? 'warn' : 'ok'}">${probs ? probs + ' discrepanc' + (probs === 1 ? 'y' : 'ies') : 'Complete'}</span><small>${esc(fmtDate(t.completedAt))}${t.picker ? ' · ' + esc(t.picker) : ''}</small>`
        : `<span class="chip">${esc(stateLabel(t))}</span><small>${t.picker ? esc(t.picker) : 'Not started'}</small>`}</span>
    </button>`;
  };
  const waiting = view.pending.length, responded = open.filter(t => t.waiting && t.response);
  return `${responded.length ? `<p class="note responded">The Taker responded on order ${responded.map(t => esc(t.orderNumber)).join(', ')}. Open ${responded.length === 1 ? 'it' : 'them'} to continue the conversion.</p>` : ''}${waiting ? `<div class="note strong pending"><span>${waiting === 1 ? '1 new pick ticket from the folder needs' : `${waiting} new pick tickets from the folder need`} checking.</span><button data-act="checkPending">Check ${waiting === 1 ? 'it' : 'them'}</button></div>` : ''}
    <section class="start">
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
    ${d.fromPdf ? `<p class="note">Compare the numbers and quantities with the PDF before saving. Fix anything that's wrong here.${d.unreadable ? ' <strong>No text was found in this PDF, so it may be a scan. Enter the lines by hand.</strong>' : ''}</p>` : ''}
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
    <div class="panel"><h3>Lines <span class="muted">${d.lines.length}</span></h3>
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

// Under the order number at the top of a ticket's screens: one order can have several pick tickets.
const ticketLine = t => `<p class="pageSub">Pick ticket <strong>${esc(t.ticket)}</strong></p>`;

function pickerSelect(t) {
  return `<label class="pickerSel">Inspector<select id="pickerSelect" data-act-change="picker">
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

// Completed tickets can be deleted too, e.g. one read wrong that has to be imported again.
const deleteButton = t => `<button data-act="askDelete" data-id="${t.id}" class="quiet">Delete ticket</button>`;

function ticketView(t) {
  if (t.status === 'done') return reportsView(t);
  const done = pickedCount(t), all = allDone(t), probs = ticketProblems(t).length, left = t.lines.length - done;
  const needPicker = !t.picker, step = nextStep(t);
  const next = !all ? `${left} line${left === 1 ? '' : 's'} left`
    : step === 'reports' ? 'Print reports' : step === 'save' ? 'Save order' : t.conv ? `Continue conversion · step ${t.conv.step + 1}` : step === 'resume' ? 'Continue conversion' : 'Start conversion';
  return `<div class="pageHead"><div><p class="eyebrow">${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</p><h1>Order ${esc(t.orderNumber)}</h1>${ticketLine(t)}</div>${pickerSelect(t)}</div>
    <details class="panel orderDetails"><summary>Order details</summary>${orderBlock(t)}${t.service ? `<p class="muted">Service item: ${esc(t.service)}</p>` : ''}</details>
    ${t.products.length ? `<div class="panel builds">${t.products.map(p => `<p><span class="chip">${p.kind === 'conversion' ? 'Conversion' : 'Assembly'}</span> <strong>${esc(p.item)}</strong> × ${fmtQty(p.qty)}</p>${p.returns.length ? `<p class="muted">Removed and returned to stock: ${p.returns.map(r => esc(r.item) + ' × ' + fmtQty(r.qty)).join(', ')}</p>` : ''}`).join('')}</div>` : ''}
    ${needPicker ? '<p class="note strong">Choose your name above before checking the items.</p>' : ''}
    ${t.waiting ? (t.response ? `<p class="note responded">${responseText(t)}</p>` : `<p class="note strong">Waiting for parts: ${esc(partsAwaited(t))}. Once you receive the parts, tap Continue conversion.</p>`) : ''}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${t.lines.length}" aria-valuenow="${done}"><div style="width:${t.lines.length ? done / t.lines.length * 100 : 0}%"></div></div>
    <p class="progressText">${done} of ${t.lines.length} lines done${probs ? ` · <span class="warnText">${probs} discrepanc${probs === 1 ? 'y' : 'ies'}</span>` : ''}</p>
    <ol class="lines ${needPicker ? 'locked' : ''}">${t.lines.map(l => lineRow(l, needPicker)).join('')}</ol>
    <div class="actionsBar">
      ${deleteButton(t)}${t.waiting ? emailButton(t) + '<button data-act="reprint">Print Taker report again</button>' : ''}
      <button class="primary" data-act="next" ${all && !needPicker ? '' : 'disabled'}>${next}</button>
    </div>`;
}

// A part needed to make a problem good, as it prints: "4 × 12345", or just the part when no quantity was typed.
const needText = n => (n.qty ? fmtQty(n.qty) + ' × ' : '') + n.part;
const probChips = l => l.problems.length ? `<span class="probs">${l.problems.map(p => `<span class="chip warn">${fmtQty(p.qty)} ${esc(p.type.toLowerCase())}</span>${(p.needs || []).map(n => `<span class="probNote">Needs ${esc(needText(n))}</span>`).join('')}${p.note ? `<span class="probNote">${esc(p.note)}</span>` : ''}`).join(' ')}</span>` : '';

function lineRow(l, locked) {
  const rem = remaining(l), done = rem === 0, probs = l.problems;
  const dis = locked ? 'disabled' : '';
  return `<li class="line ${done ? (probs.length ? 'hasProblem' : 'done') : ''}">
    <div class="what"><span class="item">${esc(l.item)}</span><span class="desc">${esc(l.desc)}</span>${probChips(l)}
      ${l.product ? `<span class="muted small">For ${esc(l.product)}</span>` : ''}</div>
    <div class="qty"><span class="lbl">Qty</span><strong>${fmtQty(l.qty)}</strong>${l.picked && !done ? `<small>${fmtQty(l.picked)} checked</small>` : ''}</div>
    <div class="acts">${done
      ? `<span class="doneMark">${probs.length ? (l.picked ? fmtQty(l.picked) + ' OK' : 'None OK') : '✓ Checked'}</span><button class="small quiet" data-act="undo" data-id="${l.id}" ${dis}>Undo</button>`
      : `<button class="pick" data-act="pickAll" data-id="${l.id}" ${dis}>✓ Checked${rem !== l.qty ? ' ' + fmtQty(rem) : ''}</button><button class="problem" data-act="problem" data-id="${l.id}" ${dis}>Problem</button>`}</div>
  </li>`;
}

// ---------- conversion ----------
function convertView(t) {
  const steps = convSteps(t), i = Math.min(t.conv.step, steps.length - 1), s = steps[i], model = convNames(t).model;
  return `<div class="pageHead"><div><p class="eyebrow">Conversion${model ? ' · ' + esc(model) : ''}</p><h1>Order ${esc(t.orderNumber)}</h1>${ticketLine(t)}</div></div>
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
      <button class="quiet" data-act="${i ? 'convPrev' : 'backToTicket'}">${i ? '‹ Previous step' : '‹ Back to the items'}</button>
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
    <tr><th>Taker</th><td>${esc(t.taker || '—')}</td><th>Inspector</th><td>${esc(t.picker || '—')}</td><th>Date</th><td>${esc(fmtDate(t.completedAt || now()))}</td></tr>
    <tr><th>Customer</th><td colspan="3">${esc(t.customer || '—')}</td><th>Customer #</th><td>${esc(t.customerId || '—')}</td></tr></table>
    <div class="rAddr"><div><strong>Bill To</strong><pre>${esc(t.billTo || '—')}</pre></div><div><strong>Ship To</strong><pre>${esc(t.shipTo || '—')}</pre></div></div>
  </header>`;
}
// Each discrepancy is its own row group, so its parts needed and its optional notes line stay with it.
const reportRows = (problems, cells, needs) => problems.map(p => {
  const extra = (needs ? (p.needs || []).map(n => ['Part needed', needText(n)]) : []).concat(p.note ? [['Notes', p.note]] : []);
  return `<tbody class="${extra.length ? 'hasNote' : ''}"><tr>${cells(p)}</tr>${extra.map(([lbl, text]) => `<tr class="rNoteRow"><td colspan="4"><span class="rNoteLbl">${lbl}</span>${esc(text)}</td></tr>`).join('')}</tbody>`;
}).join('');
// A problem with parts needed is made whole by the Taker, so it stays off the inventory report, and the parts needed
// print on the Taker report only (john 2026-10-29).
const adjustProblems = t => ticketProblems(t).filter(p => !(p.needs || []).length);
function takerReport(t) {
  return `<section class="report"><p class="rStamp">INCOMPLETE</p>${reportHeader(t, 'Taker report')}
    <p class="rLead">These items were not delivered on this pick ticket.</p>
    <table class="rTable"><thead><tr><th>Item</th><th>Description</th><th class="num">Missing</th><th>Discrepancy</th></tr></thead>
    ${reportRows(ticketProblems(t), p => `<td><strong>${esc(p.line.item)}</strong></td><td>${esc(p.line.desc)}</td><td class="num">${fmtQty(p.qty)}</td><td>${esc(p.type)}</td>`, true)}
    </table></section>`;
}
// The Taker report as plain text in a new Gmail message, subject filled in (john 2026-10-29). Gmail can't be handed an
// attachment this way, and john prefers the report in the body anyway.
function takerText(t) {
  const lines = ['TAKER REPORT - INCOMPLETE', '', `Order: ${t.orderNumber}`, `Pick ticket: ${t.ticket}`, `Type: ${t.type}`, `Taker: ${t.taker || '-'}`,
    `Inspector: ${t.picker || '-'}`, `Date: ${fmtDate(t.completedAt || now())}`, `Customer: ${t.customer || '-'}`, `Customer #: ${t.customerId || '-'}`,
    `Bill To: ${(t.billTo || '-').split('\n').join(', ')}`, `Ship To: ${(t.shipTo || '-').split('\n').join(', ')}`, '', 'These items were not delivered on this pick ticket.'];
  for (const p of ticketProblems(t)) lines.push('', `${p.line.item}  ${p.line.desc}`, `Missing: ${fmtQty(p.qty)}  ${p.type}`, ...(p.needs || []).map(n => 'Part needed: ' + needText(n)), ...(p.note ? ['Notes: ' + p.note] : []));
  return lines.join('\n');
}
const emailButton = t => `<a class="btn" href="${esc('googlegmail:///co?subject=' + encodeURIComponent(`Order ${t.orderNumber} / Pick ticket ${t.ticket} - Taker report`) + '&body=' + encodeURIComponent(takerText(t)))}">Email Taker report</a>`;
function adjustmentReport(t, problems = adjustProblems(t)) {
  if (!problems.length) return '';
  return `<section class="report">${reportHeader(t, 'Inventory adjustment report')}
    <table class="rTable"><thead><tr><th>Item</th><th class="num">Qty</th><th>Bin</th><th>Discrepancy</th></tr></thead>
    ${reportRows(problems, p => `<td><strong>${esc(p.line.item)}</strong></td><td class="num">${fmtQty(p.qty)}</td><td>${esc(p.line.bin)}</td><td>${esc(p.type)}</td>`, false)}
    </table></section>`;
}
const reportsHtml = t => takerReport(t) + adjustmentReport(t);
// Two copies of each: one stays with the order (or the deficient item), the other goes to the Taker (or the adjuster).
const printHtml = t => takerReport(t).repeat(2) + adjustmentReport(t).repeat(2);

function reportsView(t) {
  const done = t.status === 'done', wait = !done && canWait(t);
  if (!hasProblems(t)) return done ? cleanView(t) : ticketView(t);
  return `<div class="pageHead"><div><p class="eyebrow">${done ? 'Completed ' + esc(fmtDate(t.completedAt)) : 'Print reports'}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <div class="note strong printSteps">
      <p>Printing makes 2 copies of ${adjustProblems(t).length ? 'each report' : 'the Taker report'}${done ? '' : wait ? ' and saves this order as Waiting for parts' : ' and completes this pick ticket'}.</p>
      <p><strong>Taker report:</strong> Place 1 copy of the Taker report with the order and take the other copy to the Taker.</p>
      ${adjustProblems(t).length ? `<p><strong>Inventory adjustment report:</strong> Attach 1 copy of the inventory report to the deficient item and place that item in the designated area. Give the other copy of the inventory report to the inventory adjuster.${adjustProblems(t).every(p => p.type === 'Not available') ? ' If the item is Not available, discard the extra copy.' : ''}</p>` : ''}
    </div>
    ${embedded ? '<p class="note">Printing works in the installed iPad app. It is blocked inside this preview window.</p>' : ''}
    <div class="paper">${reportsHtml(t)}</div>
    <div class="actionsBar">
      ${done ? deleteButton(t) + '<button data-act="home">Back to tickets</button>' : '<button data-act="backToTicket">Back to the items</button>'}${emailButton(t)}
      <button class="primary" data-act="print">${done ? 'Print again' : wait ? 'Print Taker report & wait for parts' : 'Print reports & complete'}</button>
    </div>`;
}

const madeWholeText = t => {
  const parts = t.madeWhole.filter(m => !m.replaced).flatMap(m => m.needs.map(needText)), swapped = t.madeWhole.filter(m => m.replaced).map(m => m.item);
  return (parts.length ? ` Made whole with the parts received: ${esc(parts.join(', '))}.` : '') + (swapped.length ? ` Replaced with a different one off the shelf: ${esc(swapped.join(', '))}.` : '');
};
// A pick ticket finished with no discrepancies: nothing was printed.
function cleanView(t) {
  const back = returnsOf(t).filter(r => r.bin);
  return `<div class="pageHead"><div><p class="eyebrow">Completed ${esc(fmtDate(t.completedAt))}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <p class="note">Completed by ${esc(t.picker || 'the inspector')}${t.madeWhole ? '.' + madeWholeText(t) : ' with no discrepancies, so there are no reports to print.'}</p>
    <div class="panel">${orderBlock(t)}${back.length ? `<p class="returned">Returned to inventory: ${back.map(r => `<strong>${esc(r.item)}</strong> in bin <strong>${esc(r.bin)}</strong>`).join(', ')}</p>` : ''}</div>
    <div class="actionsBar">${deleteButton(t)}<button data-act="home">Back to tickets</button></div>`;
}

function settingsView() {
  return `<div class="pageHead"><div><p class="eyebrow">This iPad</p><h1>Settings & backup</h1></div></div>
    <div class="panel"><h3>Backup</h3><p class="muted">Everything is saved on this iPad only. Save a backup file now and then, for example to Files or OneDrive.</p>
      <div class="row"><button data-act="backup">Save backup file</button><label class="fileBtn">Restore from backup<input id="restoreFile" type="file" accept=".json,application/json" data-act-change="restore"></label></div>
      <p class="muted small">Restore adds pick tickets that aren't already on this iPad. Nothing is overwritten.</p></div>
    <div class="panel"><h3>Inspector names</h3>${db.pickers.length ? `<ul class="names">${db.pickers.map(n => `<li>${esc(n)} <button class="small quiet" data-act="dropPicker" data-name="${esc(n)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted">Names are added the first time an inspector chooses "Add my name".</p>'}</div>
    ${flowPanel()}
    <div class="panel"><h3>About</h3><p class="muted">Assemblies & Conversions · pilot version 2 · ${db.tickets.length} pick tickets saved</p></div>`;
}

// ---------- pick tickets from Power Automate ----------
// Two flows hand the iPad the Pick Tickets folder: one lists the folder, the other sends one PDF by its id.
const stored = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const keep = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* kept for this visit only */ } };
const isAddress = s => /^https:\/\/\S+$/i.test(s);
// Folder files the app has dealt with: brought in, already in the app, unreadable, or skipped on the check screen.
let seen;
try { seen = new Set(JSON.parse(stored(SEEN) || '[]')); } catch (e) { seen = new Set(); }
function markSeen(id) { seen.add(id); keep(SEEN, JSON.stringify([...seen].slice(-3000))); }

function flowPanel() {
  const f = view.flow;
  const box = (id, key, label) => `<label>${label}<input id="${id}" type="url" value="${esc(stored(key))}" placeholder="https://" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>`;
  return `<div class="panel"><h3>Pick tickets from Power Automate</h3><p class="muted">New PDFs in the Pick Tickets folder come in by themselves when the app opens. Paste the address of each flow, then tap Test. The addresses stay on this iPad.</p>
    <div class="flowTest">${box('flowUrl', FLOW, 'Flow that lists the folder')}${box('fileFlowUrl', FILEFLOW, 'Flow that sends one PDF')}
      <button data-act="testFlow" ${f && f.busy ? 'disabled' : ''}>${f && f.busy ? 'Testing…' : 'Test'}</button>
      ${f && !f.busy ? `<p class="note${f.ok ? '' : ' strong'}">${esc(f.text)}</p>` : ''}</div></div>`;
}

// A POST with a plain text body goes out without the browser asking the flow's permission first, so a flow only has to
// add Access-Control-Allow-Origin to its answer. Gives back the answer, or in plain words why there is none.
async function callFlow(url, id) {
  if (!navigator.onLine) return { problem: 'This iPad is offline. Connect to Wi-Fi, then try again.' };
  const target = id ? `${url}${url.includes('?') ? '&' : '?'}id=${encodeURIComponent(id)}` : url;
  const ask = async mode => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60000);
    try { return await fetch(target, { method: 'POST', mode, body: '{}', signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  };
  try {
    const res = await ask('cors');
    if (res.ok) return { res };
    let why = ''; try { why = JSON.parse(await res.text()).error.message || ''; } catch (e) { /* no error message */ }
    return { problem: `The flow answered with error ${res.status}${why ? ': ' + why : '.'}${[401, 403].includes(res.status) ? ' In the flow, set Who can trigger the flow to Anyone.' : ''}` };
  } catch (e) {
    if (e.name === 'AbortError') return { problem: 'The flow took more than a minute to answer. Check that it is turned on, then try again.' };
    // Safari only says "Load failed". Asking again without reading the answer tells "can't reach it" from "not allowed to read it".
    const reached = await ask('no-cors').then(() => true, () => false);
    return { problem: reached
      ? 'The flow answered, but the iPad is not allowed to read the answer. In the flow, check that Who can trigger the flow is set to Anyone and that the Response step has the header Access-Control-Allow-Origin with the value *.'
      : 'The iPad could not reach the flow. Check that the whole address was pasted, then try again.' };
  }
}
const fileName = f => f.Name || f.DisplayName || f.name || '';
const isPdfFile = f => !!f && !f.IsFolder && !!f.Id && /\.pdf$/i.test(fileName(f));
function fileList(text) {
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return Array.isArray(data) ? data : (data && [data.value, data.body].find(Array.isArray)) || null;
}
// One PDF from the folder, read the same way as an imported one.
async function pdfFromFolder(url, f) {
  const r = await callFlow(url, f.Id);
  if (r.problem) return r;
  try { return { draft: { ...(await readPdf(new File([await r.res.blob()], fileName(f), { type: 'application/pdf' }))), fileId: f.Id } }; }
  catch (e) { console.error(e); return { unreadable: true }; }
}

// Settings > Test: both flows, start to finish, without adding anything to the app.
async function checkFlows(list, one) {
  const r = await callFlow(list);
  if (r.problem) return { ok: false, text: r.problem };
  const text = await r.res.text().catch(() => '');
  const files = fileList(text);
  if (!files) return { ok: false, text: `The flow answered, but not with a list of files. Its answer was: ${text.slice(0, 200) || '(empty)'}` };
  const names = files.filter(f => f && !f.IsFolder).map(fileName).filter(Boolean);
  const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? ` and ${names.length - 10} more` : '');
  const listed = names.length ? `It works. The flow sees ${names.length} ${names.length === 1 ? 'file' : 'files'} in the folder: ${shown}.` : 'It works. The flow answered, and there are no files in the folder yet.';
  if (!one) return { ok: true, text: `${listed} Next, add the address of the flow that sends one PDF.` };
  const pdf = files.filter(isPdfFile).sort((a, b) => String(b.LastModified).localeCompare(String(a.LastModified)))[0];
  if (!pdf) return { ok: true, text: `${listed} Put a pick ticket PDF in the folder to test the flow that sends one PDF.` };
  const g = await pdfFromFolder(one, pdf);
  if (g.problem) return { ok: false, text: `${listed} But the flow that sends one PDF didn't work. ${g.problem}` };
  if (g.unreadable) return { ok: false, text: `${listed} But ${fileName(pdf)} didn't come through as a PDF. In the flow that sends one PDF, check that the Response step's Body is File Content.` };
  return { ok: true, text: `${listed} It also opened ${fileName(pdf)}${g.draft.ticket ? ` (pick ticket ${g.draft.ticket})` : ''}, so new pick tickets will come in by themselves.` };
}

// New PDFs in the folder come in by themselves: when the app opens, when it comes back on screen, and on the way back to
// the list, at most every half minute. Same rules as Import: a clean ticket goes straight to In progress and one the app
// already has is left out. One that needs checking waits on the home screen until someone checks or skips it.
let lastPickup = 0, pickingUp = false;
async function pickup(force = false) {
  const list = stored(FLOW), one = stored(FILEFLOW);
  if (embedded || pickingUp || !isAddress(list) || !isAddress(one) || !navigator.onLine || (!force && Date.now() - lastPickup < 30000)) return;
  pickingUp = true; lastPickup = Date.now();
  let added = 0, plain = 0; const unread = [], check = [];
  try {
    const r = await callFlow(list);
    const waiting = new Set(view.pending.map(d => d.fileId));
    const fresh = ((r.res && fileList(await r.res.text().catch(() => ''))) || []).filter(f => isPdfFile(f) && !seen.has(f.Id) && !waiting.has(f.Id))
      .sort((a, b) => String(a.LastModified).localeCompare(String(b.LastModified)));
    for (const f of fresh) {
      const g = await pdfFromFolder(one, f);
      if (g.problem) break; // the rest come next time
      if (g.unreadable) { unread.push(fileName(f)); markSeen(f.Id); continue; }
      const d = g.draft;
      if (d.plain) { plain++; markSeen(f.Id); }
      else if (d.ticket.trim() && db.tickets.some(t => t.ticket === d.ticket.trim())) markSeen(f.Id);
      else if (draftProblem(d) || d.lines.some(l => !String(l.item).trim())) check.push(d);
      else { const t = newTicketFrom(d); stamp(t, 'Picked up from the Pick Tickets folder'); addTicket(t); save(); markSeen(f.Id); added++; }
    }
  } catch (e) { console.error(e); }
  finally { pickingUp = false; }
  view.pending.push(...check);
  const n = (k, single, plural) => `${k} ${k === 1 ? single : plural}`;
  const msg = [
    added && `${n(added, 'new pick ticket', 'new pick tickets')} added to In progress.`,
    check.length && `${n(check.length, 'new pick ticket needs', 'new pick tickets need')} checking.`,
    plain && `${n(plain, 'plain pick ticket', 'plain pick tickets')} left out. ${PLAIN}`,
    unread.length && `Could not read ${unread.join(', ')} from the folder. Use Enter by hand for ${unread.length === 1 ? 'it' : 'those'}.`
  ].filter(Boolean).join(' ');
  if (!msg) return;
  if (view.screen === 'home') render();
  toast(msg, 8000);
}
// A ticket from the folder that was checked: saved or skipped, it isn't offered again.
function settled(d) { if (!d || !d.fileId) return; markSeen(d.fileId); view.pending = view.pending.filter(x => x !== d); }

// ---------- bottom sheet (problem entry, picker name, delete) ----------
// A problem found while checking the items can be any of the three types: Not available is anything shipping didn't
// bring. One found later, in a conversion, is Damaged or Incomplete package, and comes off the checked quantity.
const sheetMax = (l, s) => s.picked ? l.picked : remaining(l);
// Parts needed sit apart from the notes, one part per line, and a new empty line appears once the last one has a
// part number in it (john 2026-10-29).
const needRow = (n, i) => `<div class="needRow"><input id="need-${i}-part" data-need="${i}" data-key="part" value="${esc(n.part)}" placeholder="Part number" aria-label="Part needed ${i + 1}" autocapitalize="characters" autocomplete="off" spellcheck="false"><input id="need-${i}-qty" data-need="${i}" data-key="qty" value="${esc(n.qty)}" placeholder="Qty" aria-label="How many of part ${i + 1}" inputmode="decimal" autocomplete="off"></div>`;

function renderSheet() {
  const s = view.sheet, el = $('#sheet');
  if (!s) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (s.kind === 'problem') {
    const t = ticketById(view.id), l = s.lineId ? t.lines.find(x => x.id === s.lineId) : null, max = l ? sheetMax(l, s) : 0;
    s.needs = s.needs || [{ part: '', qty: '' }];
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      ${s.choose
        ? `<h2 id="sheetTitle">Which part was missing or damaged?</h2>
          <div class="chooser">${s.choose.map(id => t.lines.find(x => x.id === id)).map(x => `<button class="choice ${x.id === s.lineId ? 'on' : ''}" data-act="pLine" data-id="${x.id}" aria-pressed="${x.id === s.lineId}"><span class="item">${esc(x.item)}</span><small>${esc(x.desc)}</small></button>`).join('')}</div>`
        : `<h2 id="sheetTitle">Problem with ${esc(l.item)}</h2><p class="muted">${esc(l.desc)} · bin ${esc(l.bin || '—')}</p>`}
      ${l ? `<div class="choices">${(s.picked ? AFTER_PICK : PROBLEMS).map(p => `<button class="choice ${s.type === p ? 'on' : ''}" data-act="pType" data-type="${p}" aria-pressed="${s.type === p}">${p}</button>`).join('')}</div>
      <div class="stepper"><span>How many?</span><button class="icon" data-act="pDec" aria-label="Fewer">−</button><output id="pQty">${fmtQty(s.qty)}</output><button class="icon" data-act="pInc" aria-label="More">＋</button><span class="muted">of ${fmtQty(max)} ${s.picked ? 'checked' : 'left'}</span></div>
      <div class="noteField">Parts needed<div id="needRows">${s.needs.map(needRow).join('')}</div></div>
      <label class="noteField">Notes<input id="pNote" value="${esc(s.note || '')}" placeholder="Optional. Prints on the reports." maxlength="200" autocomplete="off" enterkeyhint="done"></label>` : ''}
      <div class="actionsBar"><button data-act="closeSheet">Cancel</button><button class="primary" data-act="saveProblem" ${l && s.type ? '' : 'disabled'}>Record problem</button></div></div>`;
  } else if (s.kind === 'more') {
    // john's step after a conversion problem (2026-10-29), so every missing piece is on the reports the first time round.
    const t = ticketById(view.id), l = t.lines.find(x => x.id === s.lineId);
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">Anything else missing or wrong?</h2>
      <p>Verify the rest of the parts are available and correct before submitting the discrepancy reports. For an accurate packing list, refer to the owner's manual in the box. If the owner's manual doesn't have a packing list, enter the assembly part number (<strong>${esc(l.item)}</strong>) in the LMI Parts Tool.</p>
      <div class="noteField">Add the rest of the parts needed<div id="needRows">${s.needs.map(needRow).join('')}</div></div>
      <div class="actionsBar">${t.lines.some(x => x.picked > 0) ? '<button data-act="moreProblems">Another item has a problem</button>' : ''}<button class="primary" data-act="toReports">Go to the reports</button></div></div>`;
  } else if (s.kind === 'came') {
    const t = ticketById(view.id), q = s.todo[0], l = t.lines.find(x => x.id === q.lineId), p = l.problems.find(x => x.type === q.type);
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">What came in for ${esc(l.item)}?</h2>
      <p>Parts needed: <strong>${esc(p.needs.map(needText).join(', '))}</strong></p>
      <p class="muted">A different ${esc(l.item)} off the shelf prints 2 copies of the inventory adjustment report for the original one. Attach 1 copy to it and place it in the designated area. Give the other copy to the inventory adjuster.</p>
      <div class="actionsBar"><button data-act="cameOther">A different ${esc(l.item)}</button><button class="primary" data-act="cameParts">The parts needed</button></div></div>`;
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
      <p class="muted">${t.status === 'done' ? 'The completed order is removed from this iPad.' : 'Its picking progress is removed from this iPad.'} This can't be undone.</p>
      <div class="actionsBar"><button data-act="closeSheet">Keep it</button><button class="danger" data-act="doDelete">Delete</button></div></div>`;
  }
}

// ---------- actions ----------
const current = () => ticketById(view.id);
const lineById = id => current().lines.find(x => x.id === id);
const go = (screen, id = view.id) => { view.screen = screen; view.id = id; view.sheet = view.flow = null; if (screen !== 'review') view.queue = view.note = null; render(); window.scrollTo(0, 0); if (screen === 'home') pickup(); };
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

// The label sheet for one converted pump. The two big labels get barcodes of the model and serial.
async function labelSheet(c) {
  const pdf = await PDFLib.PDFDocument.load(await labelTemplateBytes()), form = pdf.getForm();
  for (const n of ['1', '2', '3']) { form.getTextField('MODEL ' + n).setText(c.model); form.getTextField('SERIAL ' + n).setText(c.serial); }
  for (const k of ['POWER', 'LPH', 'BAR', 'GPH', 'PSI']) form.getTextField(k).setText(String(c[k.toLowerCase()]));
  form.getTextField('ITEM').setText(c.removed);
  for (const name of ['MODEL 2', 'SERIAL 2', 'MODEL 3', 'SERIAL 3']) barcodeBeside(pdf.getPage(0), form, name, 470);
  form.flatten();
  return pdf.save();
}

// Code 39, the kind of barcode on the factory pump labels: each character is 5 bars and 4 spaces, 3 of them wide.
const CODE39 = {
  0: '000110100', 1: '100100001', 2: '001100001', 3: '101100000', 4: '000110001', 5: '100110000', 6: '001110000', 7: '000100101',
  8: '100100100', 9: '001100100', A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000',
  G: '000001101', H: '100001100', I: '001001100', J: '000011100', K: '100000011', L: '001000011', M: '101000010', N: '000010011',
  O: '100010010', P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110', U: '110000001', V: '011000001',
  W: '111000000', X: '010010001', Y: '110010000', Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100',
  '*': '010010100' // $ / + and % are left out: many scanners read them as the start of a different character
};

// Draws a field's barcode to its right, ending at the label's right edge. When the value is too long to leave room
// for bars a scanner can read, its text gets smaller; a value Code 39 can't hold, like one with a comma, gets none.
function barcodeBeside(page, form, name, right) {
  const field = form.getTextField(name), value = (field.getText() || '').trim(), code = '*' + value.toUpperCase() + '*';
  if (!value || [...code].some(ch => !CODE39[ch])) return;
  const widths = [...code].map(ch => [...CODE39[ch]].map(w => w === '1' ? 3 : 1)); // in narrow bars
  const modules = widths.reduce((n, w) => n + w.reduce((a, b) => a + b) + 1, -1) + 20; // with 10 blank on each side
  const box = field.acroField.getWidgets()[0].getRectangle(), font = form.getDefaultFont();
  let size = +(/([\d.]+) Tf/.exec(field.acroField.getDefaultAppearance() || '') || [0, 28])[1], m;
  for (;; size--) {
    m = Math.min(1, (right - box.x - 8 - font.widthOfTextAtSize(value, size)) / modules);
    if (m >= 0.6 || size <= 14) break;
  }
  if (m < 0.45) return;
  field.setFontSize(size);
  const h = Math.min(30, box.height - 8), y = box.y + (box.height - h) / 2;
  let x = right - (modules - 10) * m;
  for (const w of widths) {
    w.forEach((n, i) => { if (i % 2 === 0) page.drawRectangle({ x, y, width: n * m, height: h, color: PDFLib.rgb(0, 0, 0) }); x += n * m; });
    x += m;
  }
}

function completeOrder(t) {
  t.status = 'done'; t.completedAt = now(); stamp(t, t.madeWhole ? 'Conversion finished with the parts received' : 'Saved with no discrepancies'); save();
  go('home', null); toast(`Order ${t.orderNumber} saved. On to the next one.`);
}

// Yes or No on a conversion question. The answer that means a discrepancy records it, then asks for anything else
// missing or wrong, so every missing piece is on the reports the first time round (john 2026-10-29).
function answer(yes) {
  const t = current(), s = convSteps(t)[t.conv.step];
  stamp(t, `${s.text} ${yes ? 'Yes' : 'No'}`);
  if ((s.problemIf === 'yes') !== yes) { t.conv.step++; save(); return go('convert'); }
  save();
  if (s.line && s.line.picked > 0) return openProblem(s.line, true, 'reports');
  chooseProblem(t);
}
// A conversion problem on any checked part: the parts to choose from, or the only one. again: the "Anything else?"
// step to come back to.
function chooseProblem(t, again = null) {
  const picked = t.lines.filter(l => l.picked > 0);
  if (!picked.length) return go('reports');
  view.sheet = { kind: 'problem', lineId: picked.length === 1 ? picked[0].id : null, type: '', qty: picked.length === 1 ? Math.min(1, picked[0].picked) : 0, picked: true, then: 'reports', again, choose: picked.map(l => l.id) };
  renderSheet();
}
const cleanNeeds = needs => (needs || []).filter(n => n.part.trim()).map(n => ({ part: n.part.trim().replace(/\s+/g, ' '), qty: +n.qty > 0 ? +n.qty : '' }));
const moreStep = (l, type) => ({ kind: 'more', lineId: l.id, type, needs: [{ part: '', qty: '' }] });
// The parts added on the "Anything else?" step join the problem just recorded.
function keepMoreNeeds() {
  const s = view.sheet, t = current(), l = lineById(s.lineId), p = l && l.problems.find(x => x.type === s.type), needs = cleanNeeds(s.needs);
  if (!p || !needs.length) return;
  p.needs = (p.needs || []).concat(needs);
  stamp(t, `${l.item}: parts needed ${needs.map(needText).join(', ')}`); save();
}

// The parts are in. For each problem waiting on parts, the Taker sent either the parts needed or a different one of
// that item off the shelf (john 2026-10-29). The corrected pick ticket tells which; otherwise ask, one problem at a time.
function askCame(t) {
  const fixed = ticketProblems(t).filter(p => (p.needs || []).length), key = p => ({ lineId: p.line.id, type: p.type });
  const todo = fixed.filter(p => !cameFor(t, p)).map(key), swap = fixed.filter(p => cameFor(t, p) === 'other').map(key);
  if (!todo.length) return resume(t, swap);
  view.sheet = { kind: 'came', todo, swap }; renderSheet();
}
// The problems come off the order (kept in madeWhole for the record) and the conversion carries on from the step where
// it stopped. An item replaced off the shelf leaves the original deficient, so its inventory report prints.
function resume(t, swap = []) {
  const fixed = ticketProblems(t).filter(p => (p.needs || []).length), swapped = p => swap.some(q => q.lineId === p.line.id && q.type === p.type);
  const out = fixed.filter(swapped);
  if (out.length) { $('#printArea').innerHTML = adjustmentReport(t, out).repeat(2); stamp(t, `Replaced off the shelf: ${out.map(p => p.line.item).join(', ')}. Inventory report printed`); }
  for (const p of fixed) {
    (t.madeWhole = t.madeWhole || []).push({ item: p.line.item, type: p.type, qty: p.qty, needs: p.needs, replaced: swapped(p) });
    p.line.picked += p.qty;
    p.line.problems = p.line.problems.filter(x => x.type !== p.type);
  }
  t.waiting = null;
  if (!t.conv) t.conv = { step: 0 };
  stamp(t, 'Parts received, conversion continued'); save();
  go(hasProblems(t) ? 'reports' : 'convert');
  if (out.length) { if (embedded) toast('Printing works in the installed iPad app.'); else setTimeout(() => window.print(), 100); }
}
function cameAnswer(other) {
  const s = view.sheet, q = s.todo.shift();
  if (other) s.swap.push(q);
  if (s.todo.length) return renderSheet();
  resume(current(), s.swap);
}

const actions = {
  home: () => go('home', null),
  back: () => { const t = current(); if (t && t.status !== 'done' && ['reports', 'convert'].includes(view.screen)) go('ticket'); else go('home', null); },
  settings: () => go('settings', null),
  testFlow: async () => {
    const list = $('#flowUrl').value.trim(), one = $('#fileFlowUrl').value.trim();
    keep(FLOW, list); keep(FILEFLOW, one);
    const problem = !isAddress(list) ? 'Paste the address of the flow that lists the folder. It starts with https://'
      : one && !isAddress(one) ? 'The address of the flow that sends one PDF should start with https://' : '';
    if (problem) { view.flow = { ok: false, text: problem }; return render(); }
    view.flow = { busy: true }; render();
    const result = await checkFlows(list, one);
    if (view.flow && view.flow.busy) { view.flow = result; render(); }
  },
  checkPending: () => { if (!view.pending.length) return go('home', null); view.draft = view.pending[0]; view.queue = view.pending.slice(1); go('review', null); },
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
    const kept = addTicket(t); save();
    settled(d);
    if (view.queue) actions.nextDraft(null, kept === t ? `Pick ticket ${t.ticket} added to In progress.` : `Pick ticket ${t.ticket} joined order ${t.orderNumber}, which was waiting for parts.`);
    else { view.draft = null; go('ticket', kept.id); }
  },
  // After several PDFs came in at once: the next one that needs checking, or home when none are left.
  nextDraft: (b, note = '') => {
    settled(view.draft);
    if (view.queue && view.queue.length) { view.draft = view.queue.shift(); view.note = note; go('review', null); }
    else { view.draft = null; go('home', null); if (note) toast(note); }
  },
  open: b => go('ticket', b.dataset.id),
  pickAll: b => { const t = current(), l = lineById(b.dataset.id); l.picked = l.qty - problemQty(l); stamp(t, `${l.item}: checked ${fmtQty(l.picked)}`); save(); render(); },
  undo: b => { const t = current(), l = lineById(b.dataset.id); l.picked = 0; l.problems = []; stamp(t, `${l.item}: reset`); save(); render(); },
  problem: b => openProblem(lineById(b.dataset.id), false),
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
    const needs = cleanNeeds(s.needs);
    const same = l.problems.find(p => p.type === s.type);
    if (same) { same.qty += qty; if (note) same.note = same.note ? `${same.note}; ${note}` : note; same.needs = (same.needs || []).concat(needs); }
    else l.problems.push({ type: s.type, qty, note, needs });
    stamp(t, `${l.item}: ${fmtQty(qty)} ${s.type.toLowerCase()}${s.picked ? ' (found in the conversion)' : ''}${needs.length ? '. Parts needed: ' + needs.map(needText).join(', ') : ''}${note ? '. Note: ' + note : ''}`);
    // A problem on part of a line leaves the rest to check; a full-line problem finishes the line.
    save(); view.sheet = s.then === 'reports' ? moreStep(l, s.type) : null;
    render();
  },
  // Leaving "Anything else?" goes to the reports, and leaving the next problem goes back to it, so a recorded
  // conversion problem never strands the order mid-step.
  closeSheet: () => {
    const s = view.sheet;
    if (s && s.kind === 'more') return actions.toReports();
    view.sheet = s && s.again ? s.again : null; renderSheet();
  },
  cameParts: () => cameAnswer(false),
  cameOther: () => cameAnswer(true),
  moreProblems: () => { const s = view.sheet; keepMoreNeeds(); chooseProblem(current(), moreStep(lineById(s.lineId), s.type)); },
  toReports: () => { keepMoreNeeds(); go('reports'); },
  saveName: () => {
    const name = ($('#newName').value || '').trim().replace(/\s+/g, ' ');
    if (!name) return toast('Type your name first.');
    if (!db.pickers.some(n => n.toLowerCase() === name.toLowerCase())) db.pickers.push(name);
    db.pickers.sort((a, b) => a.localeCompare(b));
    const t = current(); if (t) { t.picker = db.pickers.find(n => n.toLowerCase() === name.toLowerCase()); stamp(t, 'Inspector: ' + t.picker); }
    save(); view.sheet = null; render();
  },
  dropPicker: b => { db.pickers = db.pickers.filter(n => n !== b.dataset.name); save(); render(); },
  askDelete: b => { view.sheet = { kind: 'delete', id: b.dataset.id }; renderSheet(); },
  doDelete: () => { db.tickets = db.tickets.filter(t => t.id !== view.sheet.id); save(); go('home', null); toast('Pick ticket deleted.'); },
  next: () => {
    const t = current();
    if (!allDone(t)) return toast('Check every line first.');
    if (!t.picker) return toast('Choose your name first.');
    const step = nextStep(t);
    if (step === 'resume') return askCame(t);
    if (step !== 'convert') { stamp(t, 'Items checked'); save(); return step === 'reports' ? go('reports') : completeOrder(t); }
    if (!t.conv) { t.conv = { step: 0 }; stamp(t, 'Conversion started'); save(); }
    go('convert');
  },
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
    const first = t.status !== 'done', wait = first && canWait(t);
    if (wait) { t.waiting = now(); stamp(t, 'Taker report printed, waiting for parts'); save(); }
    else if (first) { t.status = 'done'; t.completedAt = now(); stamp(t, 'Reports printed, pick ticket completed'); save(); }
    $('#printArea').innerHTML = printHtml(t);
    if (wait) go('ticket'); else render();
    if (embedded) toast(wait ? 'Saved as Waiting for parts. Print from the installed iPad app.' : first ? 'Pick ticket completed. Print from the installed iPad app.' : 'Printing works in the installed iPad app.');
    else setTimeout(() => window.print(), 100);
  },
  // Another copy of the Taker report for an order waiting for parts; the order stays as it is.
  reprint: () => {
    const t = current();
    stamp(t, 'Taker report printed again'); save();
    $('#printArea').innerHTML = printHtml(t);
    if (embedded) toast('Printing works in the installed iPad app.'); else setTimeout(() => window.print(), 100);
  },
  makeLabels: async b => {
    const t = current(), c = t.labels.find(x => x.id === b.dataset.id);
    const missing = ['model', 'serial', 'power', 'gph', 'psi', 'lph', 'bar', 'removed'].filter(k => !String(c[k] || '').trim());
    if (missing.length) return toast('Fill in: ' + missing.map(k => k === 'removed' ? 'removed liquid end' : k.toUpperCase()).join(', ') + '.');
    try {
      const blob = new Blob([await labelSheet(c)], { type: 'application/pdf' });
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
    t.picker = el.value; if (t.picker) stamp(t, 'Inspector: ' + t.picker); save(); render();
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
  serviceTicket(d);
  return { fromPdf: true, ...d, lines: d.lines.map(l => ({ ...l })) };
}

// Service orders have no pick ticket number, so the service order number stands in for it. The same service order
// printed again with different parts is another round (11075831-2); an exact copy keeps its number and is left out.
function serviceTicket(d) {
  const base = d.orderNumber.trim();
  if (d.type !== 'Service' || d.ticket.trim() || !base) return;
  const rounds = db.tickets.filter(t => t.ticket === base || t.ticket.startsWith(base + '-'));
  const copy = rounds.find(t => t.lines.length === d.lines.length && t.lines.every((l, i) => l.item === String(d.lines[i].item).trim() && l.qty === +d.lines[i].qty));
  d.ticket = copy ? copy.ticket : rounds.length ? `${base}-${rounds.length + 1}` : base;
}

// Prophet 21 emails a conversion's plain pick ticket together with its BOM, and the app only needs the BOM (john
// 2026-10-29), so plain pick tickets are left out. Service orders and production pick tickets still come in.
const PLAIN = 'The app only needs the BOM.';

async function importPdf(file) {
  if (!file) return;
  toast('Reading ' + file.name + '…');
  try {
    const d = await readPdf(file);
    if (d.plain) return toast(`That's a plain pick ticket, so it was left out. ${PLAIN}`, 8000);
    view.draft = d;
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
  let added = 0, already = 0, plain = 0; const unread = [], check = [];
  try {
    for (const [i, file] of files.entries()) {
      toast(`Reading ${i + 1} of ${files.length}…`, 60000);
      let d;
      try { d = await readPdf(file); } catch (e) { console.error(e); unread.push(file.name); continue; }
      if (d.plain) plain++;
      else if (d.ticket.trim() && db.tickets.some(t => t.ticket === d.ticket.trim())) already++;
      else if (draftProblem(d) || d.lines.some(l => !String(l.item).trim())) check.push(d);
      else { const t = newTicketFrom(d); stamp(t, 'Imported from PDF'); addTicket(t); added++; }
    }
  } finally { importing = false; }
  save();
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const msg = !added && !check.length && !unread.length && !plain ? `All ${already} pick tickets are already in the app.` : [
    added && `${n(added, 'pick ticket', 'pick tickets')} added to In progress.`,
    already && `${n(already, 'was', 'were')} already in the app.`,
    plain && `${n(plain, 'plain pick ticket', 'plain pick tickets')} left out. ${PLAIN}`,
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
  else if (el.dataset.need && view.sheet) {
    const needs = view.sheet.needs, i = +el.dataset.need;
    needs[i][el.dataset.key] = el.value;
    if (i === needs.length - 1 && needs[i].part.trim()) { needs.push({ part: '', qty: '' }); $('#needRows').insertAdjacentHTML('beforeend', needRow(needs[i + 1], i + 1)); }
  }
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') actions.closeSheet(); });
$('#toast').addEventListener('click', e => { e.currentTarget.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && view.sheet) actions.closeSheet(); if (e.key === 'Enter' && view.sheet && view.sheet.kind === 'name') actions.saveName(); if (e.key === 'Enter' && e.target.id === 'pNote') e.target.blur(); });
$('#pdfInput').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; importPdfs(files); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); importPdfs([...e.dataTransfer.files]); });

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
load(); render(); pickup(true);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pickup(); });
if ('serviceWorker' in navigator && !embedded && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
