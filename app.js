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
  for (const t of db.tickets) if (t.conv && !t.conv.v) t.conv = null; // started before the stacks (2026-11-25): they start over
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
    id: uid(), created: now(), status: 'open', picker: '', completedAt: null, conv: null, fromPlain: !!draft.plain,
    type: draft.type, orderNumber: draft.orderNumber.trim(), ticket: draft.ticket.trim(), taker: draft.taker.trim(),
    customer: draft.customer.trim(), customerId: (draft.customerId || '').trim(), billTo: draft.billTo.trim(), shipTo: draft.shipTo.trim(), service: (draft.service || '').trim(),
    products: (draft.products || []).map(p => ({ ...p, returns: (p.returns || []).map(r => ({ ...r, bin: (r.bin || '').trim(), binBlank: !(r.bin || '').trim() })) })),
    lines: draft.lines.map(l => ({ id: uid(), item: l.item.trim(), desc: l.desc.trim(), bin: (l.bin || '').trim(), qty: +l.qty, product: l.product || '', ...(l.pi != null ? { pi: l.pi } : {}), ...(l.serials ? { serials: l.serials.slice() } : {}), picked: 0, problems: [] }))
  };
}

// A corrected pick ticket for an order waiting for parts joins that order instead of becoming a second card: to add to a
// BOM the Taker cancels the first ticket in P21 and makes a new one (john 2026-10-29). The order is marked as responded
// to, with what the new ticket added or took off. Returns the ticket the new one ended up as.
function addTicket(t) {
  const plain = plainFor(t);
  if (plain) { // the BOM keeps the plain one's place on the list, and its id, in case it's open on screen
    Object.assign(t, { id: plain.id, created: plain.created });
    db.tickets[db.tickets.indexOf(plain)] = t;
    stamp(t, `The BOM for pick ticket ${t.ticket} replaced the plain pick ticket`);
    return t;
  }
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

// ---------- conversion plan (john 2026-11-25) ----------
// Before anything is opened, the parts are stacked (one stack per finished pump), each serial number is checked
// against its box, and the label pages are printed and taped on. Then each stack runs the steps of its type.
const POWER = { 1: '115V', 2: '230V US', 3: '230V DIN', 5: 'UK 240V', 6: 'Australia 250V', 7: 'Swiss 230V' }; // by the drive's last digit
const lead = s => (String(s || '').trim().toUpperCase().match(/^[A-Z]{1,3}\d{3}/) || [''])[0]; // the drive of a model: AD851 of AD851-832SI
const powerOf = model => POWER[lead(model).slice(-1)] || '';
// LMI part numbers tell the kind of part: LE-832SI a liquid end, AD851 a driver, 57706 a valve or check valve, and
// anything else a pump (AD851938SI, PD751832SI, C13120PB).
function kindOf(item) {
  const s = String(item || '').trim().toUpperCase();
  return /^LE[-\s]?\w/.test(s) ? 'le' : /^\d{4,6}(-\w+)?$/.test(s) ? 'part' : /^[A-Z]{1,3}\d{3}$/.test(s) ? 'driver' : 'pump';
}
const KIND = { le: 'liquid end', part: 'part', driver: 'driver', pump: 'pump' };
const leOf = pump => { const rest = String(pump || '').trim().toUpperCase().slice(lead(pump).length).replace(/^-/, ''); return rest ? 'LE-' + rest : ''; };
// john's short form of a serial number: the last 3 digits before the dash and what follows (26105217240-2 is 240-2).
const shortSerial = s => { const m = /(\d{3})(-\w+)?$/.exec(String(s || '').trim()); return m ? m[1] + (m[2] || '') : String(s || '').trim(); };
const serialsOf = l => l.serials || ((/Serial numbers? ([^·]+)$/.exec(l.desc || '') || [])[1] || '').split(',').map(x => x.trim()).filter(Boolean);
const sameSerial = (a, b) => String(a).replace(/\s+/g, '').toUpperCase() === String(b).replace(/\s+/g, '').toUpperCase();
const valveName = x => /\b4FV\b|four.?function|4.?function/i.test(x.desc || '') ? 'four function valve' : /\bMFV\b|multi.?function/i.test(x.desc || '') ? 'multifunction valve' : 'valve';
const andList = xs => xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

// The lines that go into product number pi. Tickets read before 2026-11-25 don't number them: lines are matched by
// name, and products with the same name take their lines in ticket order, a new product starting when a part repeats
// or its quantity doesn't match.
function linesOf(t, pi) {
  const p = t.products[pi];
  if (t.lines.some(l => l.pi != null)) return t.lines.filter(l => l.pi === pi);
  const same = t.products.map((x, i) => i).filter(i => t.products[i].item === p.item), mine = t.lines.filter(l => l.product === p.item);
  if (same.length < 2) return mine;
  const groups = same.map(() => []); let k = 0;
  for (const l of mine) {
    while (k < same.length - 1 && groups[k].length && (groups[k].some(x => x.item === l.item) || l.qty !== t.products[same[k]].qty)) k++;
    groups[k].push(l);
  }
  return groups[same.indexOf(pi)];
}

// One stack per finished pump. A product made twice is two stacks, its serial numbers paired in ticket order.
function planStacks(t) {
  const stacks = [];
  t.products.forEach((p, pi) => {
    if (p.kind !== 'conversion') return;
    const units = Math.max(1, Math.round(p.qty)), lines = linesOf(t, pi), model = P.labelDefaults(p).model;
    for (let u = 0; u < units; u++) {
      const items = lines.map(l => ({ lineId: l.id, item: l.item, desc: l.desc, qty: l.qty / units, serial: serialsOf(l)[u] || '', box: '', ok: false }));
      const returns = (p.returns || []).map(r => ({ item: r.item, desc: r.desc || '', qty: r.qty / units }));
      stacks.push({ pi, model, items, returns, ...classify(items, returns, model) });
    }
  });
  return stacks;
}
const newConv = t => ({ v: 2, step: 0, stacks: planStacks(t), edits: {}, printed: {} });

// The type of conversion, from what goes in and what comes off: A pump + liquid end, B driver + liquid end, C driver +
// pump, D pump + pump, E pump + check valves, F pump + valve (or nothing but labels), X anything else. keeper is the
// item whose driver the finished pump keeps, donor the pump that gives its liquid end.
function classify(items, returns, model) {
  const idx = k => items.map((x, i) => kindOf(x.item) === k ? i : -1).filter(i => i >= 0);
  const back = k => returns.filter(r => kindOf(r.item) === k).map(r => r.item);
  const drivers = idx('driver'), pumps = idx('pump'), les = idx('le'), parts = idx('part');
  const first = [pumps[0], drivers[0], 0].find(i => i != null);
  const c = { type: 'X', keeper: first, donor: -1, le: les.length ? les[0] : -1, valves: [], cvNew: [], cvOld: [], oldLE: back('le')[0] || '', retDriver: back('driver')[0] || '' };
  if (drivers.length === 1 && les.length === 1 && !pumps.length) Object.assign(c, { type: 'B', keeper: drivers[0] });
  else if (drivers.length === 1 && pumps.length === 1 && !les.length) Object.assign(c, { type: 'C', keeper: drivers[0], donor: pumps[0] });
  else if (pumps.length === 2 && !drivers.length && !les.length) {
    const named = pumps.filter(i => back('driver').includes(lead(items[i].item))), other = pumps.filter(i => lead(items[i].item) !== lead(model));
    const donor = named.length === 1 ? named[0] : other.length === 1 ? other[0] : pumps[1];
    Object.assign(c, { type: 'D', keeper: pumps.find(i => i !== donor), donor });
  }
  else if (pumps.length === 1 && les.length === 1 && !drivers.length) Object.assign(c, { type: 'A', keeper: pumps[0] });
  else if (pumps.length === 1 && !drivers.length && !les.length && parts.length && back('part').length) Object.assign(c, { type: 'E', keeper: pumps[0], cvNew: parts, cvOld: returns.filter(r => kindOf(r.item) === 'part') });
  else if (pumps.length === 1 && !drivers.length && !les.length && !returns.length) Object.assign(c, { type: 'F', keeper: pumps[0] });
  if (c.type !== 'E') c.valves = parts;
  if (c.donor >= 0 && !c.retDriver) c.retDriver = lead(items[c.donor].item);
  if ((c.type === 'A' || c.type === 'D') && !c.oldLE) c.oldLE = leOf(items[c.keeper].item);
  return c;
}
const typeName = s => ({ A: 'Pump + liquid end', B: 'Driver + liquid end', C: 'Driver + pump', D: 'Pump + pump', E: 'Pump + check valves', F: s.valves.length ? 'Pump + valve' : 'Labels only', X: 'Conversion' })[s.type];
const stackText = (s, i) => `Stack ${i + 1}: ${s.items.map(x => x.item + (x.box || x.serial ? ' ' + shortSerial(x.box || x.serial) : '')).join(' + ')}`;

// "discharge check valve 48667 and suction check valve 48679", or "check valves 48667 and 48679" when the BOM doesn't say which.
function cvPhrase(list) {
  const side = x => /disch/i.test(x.desc || '') ? 'discharge' : /suct/i.test(x.desc || '') ? 'suction' : '';
  if (list.length && list.every(side)) return andList(list.map(x => `${side(x)} check valve ${x.item}`));
  return (list.length === 1 ? 'check valve ' : 'check valves ') + andList(list.map(x => x.item));
}
function returnPhrase(s) {
  const of = k => s.returns.filter(r => kindOf(r.item) === k).map(r => r.item);
  return andList([...of('driver').map(x => 'driver ' + x), ...of('le').map(x => 'liquid end ' + x),
    ...(of('part').length ? [s.type === 'E' ? cvPhrase(s.returns.filter(r => kindOf(r.item) === 'part')) : (of('part').length === 1 ? 'part ' : 'parts ') + andList(of('part'))] : []),
    ...of('pump').map(x => 'pump ' + x)]);
}

// john's steps for one stack, in his words, with the item numbers in every step. problemIf: the answer that means a
// discrepancy, on the lines named. charts: the torque and stroke charts go with an install of a liquid end.
function stackSteps(t, i) {
  const s = t.conv.stacks[i], last = i === t.conv.stacks.length - 1, model = s.model, it = k => s.items[k] || { item: '', desc: '', lineId: '' };
  const keep = it(s.keeper), donor = it(s.donor), le = it(s.le), out = [];
  const add = (key, text, art, extra) => out.push({ key, text, art, ...(extra || {}) });
  const ask = (k, what) => add('check', `Are all contents in the ${what} correct and in good working order? (${it(k).item})`, ART.check(it(k)), { problemIf: 'no', lines: [it(k).lineId] });
  const removeLE = (l, d) => add('removeLE', `Remove the screws and liquid end ${l} from driver ${d}. Keep the screws and hose kit with the liquid end. The control cable stays with the driver.`, ART.removeLE);
  const guide = () => add('guide', 'Find the diaphragm installation guide in the product manual.', ART.guide);
  const labels = () => s.retDriver
    ? add('labelsOn', `Install the labels from each label page: ${model} on the pump and its box, ${s.retDriver} on the driver and its box.`, ART.labels2)
    : add('labelsOn', `Install the ${model} labels from the label page on the pump and its box.`, ART.labels1);
  const bagLE = l => {
    add('bag', `Place liquid end ${l} in a parts bag.`, ART.bagLE);
    add('leBox', `Place the bag with liquid end ${l} in an empty liquid end box, with its diaphragm, screws, hose kit and the parts that came with it. Put the ${l} ITEM sticker on the box.`, ART.leBox);
  };
  const driverBox = () => add('driverBox', `Place driver ${s.retDriver} and its control cable, if it has one, in the ${donor.item} box.`, ART.boxDriver);
  const unpack = () => add('unpack', 'Remove contents and verify the individual parts in the packages.', ART.unpack(s.items));
  const moving = s.donor >= 0 ? leOf(donor.item) : '';
  unpack();
  if (s.type === 'A') {
    const d = lead(keep.item);
    ask(s.keeper, 'pump box'); ask(s.le, 'LE package');
    removeLE(s.oldLE, d);
    add('diaphragmOut', `Remove the diaphragm from driver ${d}.`, ART.removeDia);
    add('keep', `Place the original diaphragm with liquid end ${s.oldLE} and its screws.`, ART.keepDia);
    guide();
    add('install', `Install the new diaphragm and liquid end ${le.item} on driver ${d}.`, ART.install, { charts: true });
    labels();
    add('box', `Place pump ${model} in the ${keep.item} box, along with any remaining parts that came with liquid end ${le.item}.`, ART.boxPump);
    bagLE(s.oldLE);
  } else if (s.type === 'B') {
    ask(s.keeper, 'driver box'); ask(s.le, 'LE package');
    guide();
    add('install', `Install the diaphragm and liquid end ${le.item} on driver ${keep.item}.`, ART.install, { charts: true });
    labels();
    add('box', `Place pump ${model} in the ${keep.item} box, along with any remaining parts that came with liquid end ${le.item}.`, ART.boxPump);
  } else if (s.type === 'C') {
    ask(s.keeper, 'driver box'); ask(s.donor, 'pump box');
    removeLE(moving, s.retDriver);
    add('diaphragmOut', `Remove the diaphragm from driver ${s.retDriver} and keep it with liquid end ${moving}.`, ART.removeDia);
    guide();
    add('install', `Install liquid end ${moving} and its diaphragm on driver ${keep.item}.`, ART.install, { charts: true });
    labels();
    add('box', `Place pump ${model} in the ${keep.item} box, with the hose kit and any remaining parts that came with liquid end ${moving}.`, ART.boxPump);
    driverBox();
  } else if (s.type === 'D') {
    const d = lead(keep.item);
    ask(s.keeper, 'pump box'); ask(s.donor, 'pump box');
    removeLE(s.oldLE, d);
    add('diaphragmOut', `Remove the diaphragm from driver ${d} and keep it with liquid end ${s.oldLE}.`, ART.removeDia);
    removeLE(moving, s.retDriver);
    add('diaphragmOut2', `Remove the diaphragm from driver ${s.retDriver} and keep it with liquid end ${moving}.`, ART.removeDia);
    guide();
    add('install', `Install liquid end ${moving} and its diaphragm on driver ${d}.`, ART.install, { charts: true });
    labels();
    add('box', `Place pump ${model} in the ${keep.item} box, with the hose kit and any remaining parts that came with liquid end ${moving}.`, ART.boxPump);
    driverBox();
    bagLE(s.oldLE);
  } else if (s.type === 'E') {
    const fresh = s.cvNew.map(it);
    ask(s.keeper, 'pump box');
    add('check', `Are the new check valves correct and in good working order? (${fresh.map(x => x.item).join(', ')})`, ART.cvCheck, { problemIf: 'no', lines: fresh.map(x => x.lineId) });
    add('cvOut', `Remove ${cvPhrase(s.cvOld)} from the pump head. Keep the pieces in the order they were removed.`, ART.removeCV);
    add('cvIn', `Install ${cvPhrase(fresh)} in the pump head.`, ART.installCV);
    add('arrows', 'Make sure all the arrows are pointing in the correct direction when assembling. The arrow on the pump head indicates which way the arrows on the individual pieces will point.', ART.arrows);
    labels();
    add('box', `Place pump ${model} back in its box, with the rest of its parts.`, ART.boxBack);
    add('bag', s.cvOld.length === 1 ? `Place check valve ${s.cvOld[0].item} in a parts bag with its ITEM sticker.` : `Place check valves ${andList(s.cvOld.map(x => x.item))} in separate parts bags, each with its ITEM sticker.`, ART.bagCV);
  } else if (s.type === 'F') {
    ask(s.keeper, 'pump box');
    for (const v of s.valves.map(it)) add('check', `Is ${valveName(v)} ${v.item} correct and in good working order?`, ART.check(v), { problemIf: 'no', lines: [v.lineId] });
    labels();
    add('box', `Place pump ${model} back in its box, with the rest of its parts.`, ART.boxBack);
  } else {
    s.items.forEach((x, k) => kindOf(x.item) === 'part' ? add('check', `Is part ${x.item} correct and in good working order?`, ART.check(x), { problemIf: 'no', lines: [x.lineId] })
      : ask(k, kindOf(x.item) === 'le' ? 'LE package' : KIND[kindOf(x.item)] + ' box'));
    add('build', `Convert the parts into pump ${model} as the BOM shows.`, ART.install, { charts: s.items.some(x => kindOf(x.item) === 'le') });
    labels();
    add('box', `Place pump ${model} in its box, with the rest of its parts.`, ART.boxBack);
  }
  // A valve on the BOM with nothing taken off for it goes in the box, whatever the type (john: "sounds good").
  for (const v of s.valves.map(it)) add('valveBox', `Place ${valveName(v)} ${v.item} in the box with pump ${model}.`, ART.valveBox);
  add('installCheck', s.type === 'F' ? 'Were any parts missing or damaged?' : 'Were any parts missing or damaged in the install?', ART.missing, { problemIf: 'yes', lines: s.items.map(x => x.lineId) });
  add('ship', `Place pump ${model} in the appropriate place for shipping.${last ? ' Put the pick ticket/BOM paperwork with the order.' : ''}`, ART.ship(last));
  if (s.returns.length) add('receiving', `Place ${returnPhrase(s)} in the designated place for receiving to return to inventory.`, ART.receive(s.returns));
  return out;
}

// The whole conversion as one list: each stack with its serial numbers, the label pages, taping them on, then each
// stack's steps. t.conv.step is the place in it.
function convFlow(t) {
  const n = t.conv.stacks.length;
  return [...t.conv.stacks.map((s, i) => ({ phase: 'stack', s: i })), { phase: 'labels' }, { phase: 'tape' },
    ...t.conv.stacks.flatMap((s, i) => stackSteps(t, i).map((st, k, all) => ({ phase: 'work', s: i, k, n: all.length, of: n, ...st })))];
}
const convAt = t => { const f = convFlow(t); return f[Math.min(t.conv.step, f.length - 1)]; };
const convLabel = t => { const s = convAt(t); return s.phase === 'work' ? `Stack ${s.s + 1} of ${s.of} · step ${s.k + 1} of ${s.n}` : 'Before you start'; };
// A serial number typed in because the box shows a different one prints on the label page, and both go on the Taker
// report under MISMATCHED SERIAL NUMBERS, which doesn't hold the order up (john 2026-11-25).
const mismatches = t => t.conv && t.conv.v ? t.conv.stacks.flatMap(s => s.items.filter(x => x.box && x.serial && !sameSerial(x.box, x.serial)).map(x => ({ item: x.item, serial: x.serial, box: x.box }))) : [];

// The label pages: one for each finished pump (its ITEM sticker is a part that came off, blank when none), one for
// each driver that goes back, with the serial of the pump it came from, and one more ITEM sticker page for each other
// part that came off. Changes made with Change are kept by the page's key.
const LABEL_KEYS = ['model', 'serial', 'power', 'gph', 'psi', 'lph', 'bar', 'item'];
const itemText = r => r ? r.item + (r.qty > 1 ? ' QTY ' + fmtQty(r.qty) : '') : '';
function labelPages(t) {
  const pages = [], edits = t.conv.edits || {};
  t.conv.stacks.forEach((s, i) => {
    const d = P.labelDefaults(t.products[s.pi] || { item: s.model }), keep = s.items[s.keeper], donor = s.items[s.donor];
    const serialOf = x => x ? x.box || x.serial : '', on = x => x ? `${KIND[kindOf(x.item)]} ${x.item}${serialOf(x) ? ' ' + shortSerial(serialOf(x)) : ''}` : 'the pump';
    const stickers = s.returns.filter(r => kindOf(r.item) !== 'driver' && kindOf(r.item) !== 'pump');
    pages.push({ key: `${i}:pump`, stack: i, model: s.model, serial: serialOf(keep), power: powerOf(s.model), gph: d.gph, psi: d.psi, lph: d.lph, bar: d.bar, item: itemText(stickers[0]), to: on(keep) });
    stickers.slice(1).forEach((r, k) => pages.push({ key: `${i}:item${k + 1}`, stack: i, model: '', serial: '', power: '', gph: '', psi: '', lph: '', bar: '', item: itemText(r), to: on(keep) }));
    // a returned driver's flow rate and pressure: its own line when it gives them, else the pump it came off
    const rated = x => x ? P.labelDefaults({ item: x.item || '', desc: x.desc || '' }) : {};
    s.returns.filter(r => kindOf(r.item) === 'driver').forEach((r, k) => {
      const f = [r, donor].map(rated).find(x => x.gph || x.psi) || {};
      pages.push({ key: `${i}:driver${k}`, stack: i, model: r.item, serial: serialOf(donor), power: powerOf(r.item), gph: f.gph || '', psi: f.psi || '', lph: f.lph || '', bar: f.bar || '', item: '', to: on(donor || keep) });
    });
  });
  return pages.map(pg => ({ ...pg, ...(edits[pg.key] || {}) }));
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
  return t.conv ? convLabel(t) : 'Ready to convert';
}

function homeView() {
  const open = db.tickets.filter(t => t.status === 'open').sort((a, b) => b.created.localeCompare(a.created));
  const done = db.tickets.filter(t => t.status === 'done').sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const card = t => {
    const probs = ticketProblems(t).length;
    return `<button class="ticketCard${t.waiting ? (t.response ? ' responded' : ' waiting') : ''}" data-act="open" data-id="${t.id}">
      <span class="tcMain"><span class="tcOrder">Order ${esc(t.orderNumber)}</span><span class="tcSub">Pick ticket ${esc(t.ticket)} · ${esc(t.type)}${t.customer ? ' · ' + esc(t.customer) : ''}</span></span>
      <span class="tcState">${t.status === 'done'
        ? `<span class="chip ${probs || mismatches(t).length ? 'warn' : 'ok'}">${probs ? probs + ' discrepanc' + (probs === 1 ? 'y' : 'ies') : mismatches(t).length ? 'Serial mismatch' : 'Complete'}</span><small>${esc(fmtDate(t.completedAt))}${t.picker ? ' · ' + esc(t.picker) : ''}</small>`
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
    : step === 'reports' ? 'Print reports' : step === 'save' ? 'Save order' : t.conv || step === 'resume' ? 'Continue conversion' : 'Start conversion';
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
  const flow = convFlow(t), i = Math.min(t.conv.step, flow.length - 1), s = flow[i], n = t.conv.stacks.length;
  const head = eyebrow => `<div class="pageHead"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>Order ${esc(t.orderNumber)}</h1>${ticketLine(t)}</div></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${flow.length}" aria-valuenow="${i}"><div style="width:${i / flow.length * 100}%"></div></div>`;
  const card = (art, text, sub) => `<section class="panel stepCard${art ? ' hasArt' : ''}">${art ? `<div class="stepArt">${artSvg(art)}</div>` : ''}<div><p class="stepText">${esc(text)}</p>${sub || ''}</div></section>`;
  const back = `<button class="quiet" data-act="${i ? 'convPrev' : 'backToTicket'}">${i ? '‹ Previous step' : '‹ Back to the items'}</button>`;
  const done = label => `<button class="primary" data-act="convDone">${label}</button>`;
  if (s.phase === 'stack') {
    const st = t.conv.stacks[s.s];
    return `${head(`Before you start · Stack ${s.s + 1} of ${n}`)}<p class="stepCount">${esc(typeName(st))}</p>
      ${card(ART.stack, `Stack these items together for pump ${st.model}.`, `<p class="stepSub">Find the serial number on each box and tap the matching number below. If the box shows a different number, tap Different number and type the one on the box.</p>`)}
      <ul class="stackItems">${st.items.map((x, k) => stackItem(t, s.s, st, x, k)).join('')}</ul>
      <div class="actionsBar">${back}${done(s.s < n - 1 ? 'Next stack' : 'Next: label pages')}</div>`;
  }
  if (s.phase === 'labels') {
    const pages = labelPages(t), printed = t.conv.printed || {};
    return `${head('Before you start')}
      ${card(ART.pages, 'Print the label pages.', '<p class="stepSub">Put label paper in the printer. Each page goes with the item that has the same serial number.</p>')}
      <div class="row"><button class="primary" data-act="printAllLabels">Print all label pages</button><button data-act="handLabel">Make a label by hand</button></div>
      <section class="panel labels">${pages.map(pg => `<div class="labelCard">
        <h3>${esc(pg.model || 'ITEM sticker')}${pg.serial ? ` <span class="muted">serial ${esc(shortSerial(pg.serial))}</span>` : ''}${printed[pg.key] ? ' <span class="chip ok">Printed</span>' : ''}</h3>
        <p class="muted small">Stack ${pg.stack + 1} · for ${esc(pg.to)}</p>
        <p>${esc([pg.power && 'Power ' + pg.power, pg.gph && pg.gph + ' GPH', pg.psi && pg.psi + ' PSI', pg.item && 'ITEM ' + pg.item].filter(Boolean).join(' · ') || 'Model and serial number only')}</p>
        <div class="row"><button data-act="printLabel" data-key="${pg.key}">Print</button><button class="quiet" data-act="editLabel" data-key="${pg.key}">Change</button></div>
      </div>`).join('')}</section>
      <div class="actionsBar">${back}${done('Done')}</div>`;
  }
  if (s.phase === 'tape') {
    return `${head('Before you start')}
      ${card(ART.tape, 'Tape each label page to the item with the matching serial number, before opening anything.', `<ul class="tapeList">${labelPages(t).map(pg => `<li>The <strong>${esc(pg.model || 'ITEM ' + pg.item)}</strong> page goes on ${esc(pg.to)} (stack ${pg.stack + 1})</li>`).join('')}</ul>`)}
      <div class="actionsBar">${back}${done('Done')}</div>`;
  }
  const end = i === flow.length - 1, report = mismatches(t).length && !t.mismatchPrinted;
  return `${head(`Stack ${s.s + 1} of ${s.of} · ${typeName(t.conv.stacks[s.s])}`)}<p class="stepCount">Step ${s.k + 1} of ${s.n}</p>
    ${card(s.art, s.text, `<p class="stackLine">${esc(stackText(t.conv.stacks[s.s], s.s))}</p>`)}
    ${s.charts ? chartsHtml() : ''}
    <div class="actionsBar">${back}${s.problemIf
      ? '<button class="answer" data-act="convNo">No</button><button class="answer" data-act="convYes">Yes</button>'
      : done(!end ? 'Done' : report ? 'Done, go to the Taker report' : 'Save the order and move on')}</div>`;
}

// One item of a stack. A driver or pump shows its serial number in john's short form; tapping it says the box shows
// that number. Different number opens a box to type the one on the box.
function stackItem(t, si, st, x, k) {
  const typing = view.typing === `${si}:${k}` || !!x.box || !x.serial, off = x.box && x.serial && !sameSerial(x.box, x.serial);
  const where = st.type === 'B' && kindOf(x.item) === 'le' ? ' · put it on the driver box' : '';
  return `<li><div class="what"><span class="item">${x.qty !== 1 ? fmtQty(x.qty) + ' × ' : ''}${esc(x.item)}</span><span class="desc">${esc(KIND[kindOf(x.item)][0].toUpperCase() + KIND[kindOf(x.item)].slice(1) + where)}</span></div>
    ${x.serial ? `<button class="serialBtn${x.ok && !x.box ? ' on' : ''}" data-act="serialOk" data-s="${si}" data-k="${k}" aria-pressed="${x.ok && !x.box}">${x.ok && !x.box ? '✓ ' : ''}${esc(shortSerial(x.serial))}</button>
      ${typing ? '' : `<button class="small quiet" data-act="serialOther" data-s="${si}" data-k="${k}">Different number</button>`}` : ''}
    ${typing && (x.serial || ['driver', 'pump'].includes(kindOf(x.item))) ? `<label class="serialBox">${x.serial ? 'Serial number on the box' : 'Serial number on the box (not on the ticket)'}<input id="sbox-${si}-${k}" data-serialbox="${si}:${k}" value="${esc(x.box)}" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false"></label>
      <p class="warnText small" id="soff-${si}-${k}"${off ? '' : ' hidden'}>Different from the ticket. It prints on the label page and goes on the Taker report.</p>` : ''}
  </li>`;
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

// ---------- step drawings ----------
// Plain line drawings, one per step, from the pictures john okayed (2026-11-25). The parts are drawn once, in a hidden
// set of shapes, and each step places them.
const ART_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<marker id="a-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker>
<g id="a-drv"><g class="a-gray"><rect x="0" y="20" width="100" height="58" rx="8"/><rect x="12" y="6" width="56" height="16" rx="5"/><circle cx="26" cy="14" r="4"/><circle cx="52" cy="14" r="4"/><rect x="6" y="78" width="18" height="6" rx="2"/><rect x="76" y="78" width="18" height="6" rx="2"/><rect x="100" y="34" width="8" height="30" rx="2"/></g></g>
<g id="a-hd"><g class="a-blue"><rect x="50" y="56" width="12" height="12" rx="2"/><rect x="10" y="30" width="40" height="66" rx="8"/></g><line class="a-arr" x1="30" y1="84" x2="30" y2="44" marker-end="url(#a-arrow)"/></g>
<g id="a-le"><g class="a-blue"><rect x="18" y="0" width="24" height="16" rx="3"/><rect x="19" y="14" width="22" height="17" rx="2"/><rect x="19" y="95" width="22" height="17" rx="2"/><rect x="18" y="110" width="24" height="16" rx="3"/></g><use href="#a-hd"/></g>
<g id="a-cv"><g class="a-blue"><rect x="0" y="0" width="24" height="16" rx="3"/><rect x="1" y="14" width="22" height="17" rx="2"/></g><line class="a-arr" x1="12" y1="28" x2="12" y2="6" marker-end="url(#a-arrow)"/></g>
<g id="a-pump"><use href="#a-drv" y="14"/><use href="#a-le" x="98"/></g>
<g id="a-pumpx"><use href="#a-drv" y="14"/><use href="#a-hd" x="98"/></g>
<g id="a-dia"><g class="a-red"><circle cx="28" cy="28" r="26"/><circle cx="28" cy="28" r="7"/></g></g>
<g id="a-scr"><g class="a-gray"><circle cx="6" cy="6" r="5"/><rect x="10" y="4" width="50" height="4" rx="1"/><circle cx="6" cy="22" r="5"/><rect x="10" y="20" width="50" height="4" rx="1"/><circle cx="6" cy="38" r="5"/><rect x="10" y="36" width="50" height="4" rx="1"/><circle cx="6" cy="54" r="5"/><rect x="10" y="52" width="50" height="4" rx="1"/></g></g>
<g id="a-hk"><g class="a-teal"><ellipse cx="16" cy="5" rx="12" ry="4"/><polygon points="6,13 26,13 22,25 10,25"/><rect x="8" y="29" width="16" height="8" rx="2"/><rect x="2" y="41" width="28" height="30" rx="4"/><rect x="8" y="41" width="2" height="30"/><rect x="15" y="41" width="2" height="30"/><rect x="22" y="41" width="2" height="30"/></g></g>
<g id="a-cab"><path class="a-arr" d="M0,10 q5,-10 10,0 t10,0 t10,0 t10,0 t10,0"/><g class="a-gray"><rect x="50" y="3" width="14" height="14" rx="3"/><rect x="64" y="6" width="7" height="2"/><rect x="64" y="12" width="7" height="2"/></g></g>
<g id="a-pbox"><g class="a-amber"><polygon points="0,16 16,0 96,0 80,16"/><polygon points="80,16 96,0 96,62 80,78"/><rect x="0" y="16" width="80" height="62"/></g></g>
<g id="a-lebox"><g class="a-coral"><polygon points="0,12 12,0 62,0 50,12"/><polygon points="50,12 62,0 62,44 50,56"/><rect x="0" y="12" width="50" height="44"/></g></g>
<g id="a-lpage"><g class="a-gray"><rect x="0" y="0" width="56" height="76" rx="3"/></g><g class="a-green"><rect x="5" y="5" width="46" height="20" rx="2"/><rect x="5" y="29" width="46" height="20" rx="2"/><rect x="5" y="53" width="21" height="18" rx="2"/><rect x="30" y="53" width="21" height="18" rx="2"/></g></g>
<g id="a-man"><g class="a-pink"><rect x="0" y="0" width="50" height="70" rx="3"/><rect x="0" y="0" width="8" height="70" rx="2"/><rect x="15" y="16" width="28" height="3"/><rect x="15" y="25" width="28" height="3"/><rect x="15" y="34" width="20" height="3"/></g></g>
<g id="a-ship"><g class="a-amber"><rect x="14" y="0" width="64" height="38"/></g><g class="a-gray"><rect x="0" y="38" width="92" height="6" rx="1"/><rect x="4" y="44" width="12" height="9"/><rect x="40" y="44" width="12" height="9"/><rect x="76" y="44" width="12" height="9"/></g></g>
<g id="a-recv"><g class="a-purple"><rect x="4" y="14" width="40" height="30"/><rect x="48" y="22" width="34" height="22"/><rect x="14" y="0" width="26" height="14"/></g><g class="a-gray"><rect x="0" y="44" width="86" height="6" rx="1"/><rect x="4" y="50" width="12" height="9"/><rect x="37" y="50" width="12" height="9"/><rect x="70" y="50" width="12" height="9"/></g></g>
<g id="a-tkt"><g class="a-gray"><rect x="0" y="0" width="38" height="50" rx="2"/><rect x="6" y="8" width="26" height="3"/><rect x="6" y="16" width="26" height="3"/><rect x="6" y="24" width="20" height="3"/><rect x="6" y="38" width="26" height="6"/></g></g>
<g id="a-bag"><g class="a-gray"><rect x="0" y="0" width="56" height="66" rx="5"/><rect x="0" y="9" width="56" height="3"/></g></g>
<g id="a-item"><g class="a-green"><rect x="0" y="0" width="64" height="34" rx="4"/><text class="a-ts" x="10" y="22">ITEM</text></g></g>
<g id="a-q"><g class="a-gray"><circle cx="22" cy="22" r="20"/><text class="a-th" x="22" y="27" text-anchor="middle">?</text></g></g>
<g id="a-mfv"><g class="a-purple"><rect x="65" y="0" width="4" height="14"/><rect x="57" y="12" width="20" height="28" rx="2"/><rect x="55" y="18" width="24" height="2"/><rect x="55" y="25" width="24" height="2"/><rect x="55" y="32" width="24" height="2"/><rect x="53" y="76" width="28" height="32" rx="4"/><rect x="58" y="76" width="2" height="32"/><rect x="64" y="76" width="2" height="32"/><rect x="70" y="76" width="2" height="32"/><rect x="76" y="76" width="2" height="32"/><rect x="102" y="44" width="14" height="28" rx="4"/><rect x="32" y="38" width="70" height="40" rx="12"/><rect x="0" y="30" width="32" height="56" rx="6"/><rect x="0" y="37" width="32" height="2"/><rect x="0" y="45" width="32" height="2"/><rect x="0" y="53" width="32" height="2"/><rect x="0" y="61" width="32" height="2"/><rect x="0" y="69" width="32" height="2"/><rect x="0" y="77" width="32" height="2"/></g><g class="a-gray"><polygon points="116,52 133,52 145,64 145,106 133,106 133,68 129,64 116,64"/></g></g>
</defs></svg>`;
const u = (id, x, y, s) => `<use href="#a-${id}" transform="translate(${x},${y})${s ? ` scale(${s})` : ''}"/>`;
const ar = (x1, y1, x2, y2) => `<line class="a-arr" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#a-arrow)"/>`;
const artSvg = inner => `<svg class="art" viewBox="0 0 226 100" role="img" aria-hidden="true">${inner}</svg>`;
const isValve = x => /\bMFV\b|\b4FV\b|function/i.test(x.desc || '');
const ART = {
  // the packages side by side: a box for a pump or driver, a liquid end's box, a bag or the valve for a part
  unpack: items => {
    const shapes = items.map(x => { const k = kindOf(x.item); return k === 'le' ? ['lebox', .9, 62, 56] : k === 'part' ? (isValve(x) ? ['mfv', .42, 145, 108] : ['bag', .62, 56, 66]) : ['pbox', .66, 96, 78]; }).slice(0, 3);
    if (!shapes.length) shapes.push(['pbox', .66, 96, 78]);
    const gap = 226 / shapes.length, f = shapes.length > 2 ? .72 : 1;
    return shapes.map(([id, s, w, h], i) => u(id, Math.round(gap * i + (gap - w * s * f) / 2), Math.round(52 - h * s * f / 2), +(s * f).toFixed(3))).join('');
  },
  check: x => ({ pump: u('pump', 30, 12, .58), driver: u('drv', 30, 22, .72), le: u('le', 70, 8, .66), part: isValve(x) ? u('mfv', 40, 24, .5) : u('bag', 70, 18, .9) })[kindOf(x.item)] + u('q', 150, 28, .9),
  cvCheck: u('cv', 62, 18, .9) + u('cv', 100, 18, .9) + u('q', 150, 30, .8),
  removeLE: u('drv', 6, 22, .5) + u('cab', 8, 70, .6) + ar(64, 46, 90, 46) + u('le', 94, 10, .55) + u('scr', 134, 20, .45) + u('hk', 170, 18, .6),
  removeDia: u('drv', 8, 26, .5) + ar(66, 46, 92, 46) + u('dia', 98, 28, .6) + u('le', 140, 10, .55),
  keepDia: u('dia', 14, 30, .6) + ar(56, 48, 84, 48) + u('le', 92, 10, .55) + u('scr', 134, 20, .45),
  guide: u('man', 88, 14),
  install: u('drv', 16, 22, .6) + u('dia', 92, 30, .5) + u('le', 128, 12, .58) + ar(204, 50, 172, 50),
  labels1: u('lpage', 40, 14, .7) + ar(84, 48, 108, 48) + u('pump', 114, 20, .45),
  labels2: u('lpage', 8, 18, .55) + ar(42, 38, 60, 38) + u('pump', 64, 18, .36) + u('lpage', 128, 18, .55) + ar(162, 38, 180, 38) + u('drv', 184, 26, .38),
  boxPump: u('pump', 8, 16, .46) + u('hk', 86, 28, .5) + ar(108, 48, 130, 48) + u('pbox', 136, 20, .65),
  boxBack: u('pump', 14, 16, .5) + ar(100, 48, 128, 48) + u('pbox', 134, 20, .65),
  boxDriver: u('drv', 10, 24, .5) + u('cab', 12, 70, .6) + ar(74, 46, 102, 46) + u('pbox', 110, 20, .65),
  bagLE: u('le', 40, 10, .6) + ar(90, 50, 118, 50) + u('bag', 126, 18, .95),
  leBox: u('bag', 4, 30, .55) + u('dia', 40, 40, .4) + u('hk', 68, 34, .5) + ar(92, 52, 118, 52) + u('lebox', 126, 20, 1.1) + u('item', 134, 48, .55),
  valveBox: u('mfv', 14, 26, .45) + ar(90, 48, 124, 48) + u('pbox', 134, 20, .65),
  removeCV: u('pumpx', 10, 16, .5) + ar(100, 46, 128, 46) + u('cv', 136, 8, .8) + '<text class="a-ts" x="162" y="24">Discharge</text>' + u('cv', 136, 50, .8) + '<text class="a-ts" x="162" y="66">Suction</text>',
  installCV: u('cv', 14, 8, .8) + u('cv', 14, 50, .8) + ar(48, 46, 76, 46) + u('pump', 86, 16, .44),
  arrows: u('le', 60, 6, .62) + u('cv', 150, 10, .8) + u('cv', 150, 50, .8),
  bagCV: u('cv', 8, 26, .7) + u('cv', 30, 26, .7) + ar(54, 48, 74, 48) + u('bag', 80, 14, .8) + u('item', 84, 38, .5) + u('bag', 142, 14, .8) + u('item', 146, 38, .5),
  missing: u('q', 91, 24),
  ship: paper => u('ship', 40, 26) + (paper ? u('tkt', 146, 28, .9) : ''),
  receive: rets => {
    let x = 6, out = '';
    for (const r of rets.slice(0, 2)) { const k = kindOf(r.item), [id, s, w] = k === 'driver' || k === 'pump' ? ['pbox', .5, 48] : k === 'le' ? ['lebox', .7, 43] : ['bag', .55, 31]; out += u(id, x, 28, s); x += w + 6; }
    return out + ar(x + 2, 50, x + 24, 50) + u('recv', x + 30, 22, .9);
  },
  stack: u('pbox', 66, 46, .55) + u('pbox', 72, 8, .45) + ar(150, 20, 150, 78) + ar(150, 78, 150, 20),
  pages: u('lpage', 64, 14, .9) + u('lpage', 92, 18, .9) + u('lpage', 120, 22, .9),
  tape: u('lpage', 30, 14, .7) + ar(76, 48, 102, 48) + u('pbox', 110, 20, .7)
};

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
  const probs = hasProblems(t), mism = mismatches(t), big = '<p class="rStamp rMismatch">MISMATCHED SERIAL NUMBERS</p>';
  return `<section class="report">${probs ? '<p class="rStamp">INCOMPLETE</p>' : big}${reportHeader(t, 'Taker report')}
    ${probs ? `<p class="rLead">These items were not delivered on this pick ticket.</p>
    <table class="rTable"><thead><tr><th>Item</th><th>Description</th><th class="num">Missing</th><th>Discrepancy</th></tr></thead>
    ${reportRows(ticketProblems(t), p => `<td><strong>${esc(p.line.item)}</strong></td><td>${esc(p.line.desc)}</td><td class="num">${fmtQty(p.qty)}</td><td>${esc(p.type)}</td>`, true)}
    </table>` : ''}
    ${mism.length ? `${probs ? big : ''}<table class="rTable"><thead><tr><th>Item</th><th>Serial number on the ticket</th><th>Serial number on the box</th></tr></thead><tbody>${mism.map(m => `<tr><td><strong>${esc(m.item)}</strong></td><td>${esc(m.serial)}</td><td>${esc(m.box)}</td></tr>`).join('')}</tbody></table>` : ''}
    </section>`;
}
// The Taker report as plain text in a new Gmail message, subject filled in (john 2026-10-29). Gmail can't be handed an
// attachment this way, and john prefers the report in the body anyway.
function takerText(t) {
  const mism = mismatches(t), lines = [hasProblems(t) ? 'TAKER REPORT - INCOMPLETE' : 'TAKER REPORT', '', `Order: ${t.orderNumber}`, `Pick ticket: ${t.ticket}`, `Type: ${t.type}`, `Taker: ${t.taker || '-'}`,
    `Inspector: ${t.picker || '-'}`, `Date: ${fmtDate(t.completedAt || now())}`, `Customer: ${t.customer || '-'}`, `Customer #: ${t.customerId || '-'}`,
    `Bill To: ${(t.billTo || '-').split('\n').join(', ')}`, `Ship To: ${(t.shipTo || '-').split('\n').join(', ')}`];
  if (hasProblems(t)) lines.push('', 'These items were not delivered on this pick ticket.');
  for (const p of ticketProblems(t)) lines.push('', `${p.line.item}  ${p.line.desc}`, `Missing: ${fmtQty(p.qty)}  ${p.type}`, ...(p.needs || []).map(n => 'Part needed: ' + needText(n)), ...(p.note ? ['Notes: ' + p.note] : []));
  if (mism.length) lines.push('', 'MISMATCHED SERIAL NUMBERS', ...mism.map(m => `${m.item}  ticket: ${m.serial}  box: ${m.box}`));
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
// A Taker report that only has mismatched serial numbers is one copy, to go with the pick ticket on the order.
const printHtml = t => takerReport(t).repeat(hasProblems(t) ? 2 : 1) + adjustmentReport(t).repeat(2);

function reportsView(t) {
  const done = t.status === 'done', wait = !done && canWait(t), probs = hasProblems(t);
  if (!probs && !mismatches(t).length) return done ? cleanView(t) : ticketView(t);
  return `<div class="pageHead"><div><p class="eyebrow">${done ? 'Completed ' + esc(fmtDate(t.completedAt)) : 'Print reports'}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <div class="note strong printSteps">${isConversion(t) ? '<p>Put normal paper in the printer, not label paper.</p>' : ''}
      ${probs ? `<p>Printing makes 2 copies of ${adjustProblems(t).length ? 'each report' : 'the Taker report'}${done ? '' : wait ? ' and saves this order as Waiting for parts' : ' and completes this pick ticket'}.</p>
      <p><strong>Taker report:</strong> Place 1 copy of the Taker report with the order and take the other copy to the Taker.</p>`
      : `<p>Printing makes 1 copy of the Taker report${done ? '' : ' and completes this pick ticket'}. It lists the mismatched serial numbers.</p>
      <p><strong>Taker report:</strong> Place it with the pick ticket on the order.</p>`}
      ${adjustProblems(t).length ? `<p><strong>Inventory adjustment report:</strong> Attach 1 copy of the inventory report to the deficient item and place that item in the designated area. Give the other copy of the inventory report to the inventory adjuster.${adjustProblems(t).every(p => p.type === 'Not available') ? ' If the item is Not available, discard the extra copy.' : ''}</p>` : ''}
    </div>
    ${embedded ? '<p class="note">Printing works in the installed iPad app. It is blocked inside this preview window.</p>' : ''}
    <div class="paper">${reportsHtml(t)}</div>
    <div class="actionsBar">
      ${done ? deleteButton(t) + '<button data-act="home">Back to tickets</button>' : '<button data-act="backToTicket">Back to the items</button>'}${emailButton(t)}
      <button class="primary" data-act="print">${done ? 'Print again' : wait ? 'Print Taker report & wait for parts' : probs ? 'Print reports & complete' : 'Print report & complete'}</button>
    </div>`;
}

const madeWholeText = t => {
  const parts = t.madeWhole.filter(m => !m.replaced).flatMap(m => m.needs.map(needText)), swapped = t.madeWhole.filter(m => m.replaced).map(m => m.item);
  return (parts.length ? ` Made whole with the parts received: ${esc(parts.join(', '))}.` : '') + (swapped.length ? ` Replaced with a different one off the shelf: ${esc(swapped.join(', '))}.` : '');
};
// A pick ticket finished with no discrepancies: nothing was printed.
function cleanView(t) {
  const back = returnsOf(t).filter(r => r.bin), sent = t.conv && t.conv.v ? returnsOf(t) : [];
  return `<div class="pageHead"><div><p class="eyebrow">Completed ${esc(fmtDate(t.completedAt))}</p><h1>Order ${esc(t.orderNumber)} · ${esc(t.ticket)}</h1></div></div>
    <p class="note">Completed by ${esc(t.picker || 'the inspector')}${t.madeWhole ? '.' + madeWholeText(t) : ' with no discrepancies, so there are no reports to print.'}</p>
    <div class="panel">${orderBlock(t)}${sent.length ? `<p class="returned">Sent to receiving: ${sent.map(r => `<strong>${esc(r.item)}</strong>${r.qty !== 1 ? ' × ' + fmtQty(r.qty) : ''}`).join(', ')}</p>` : back.length ? `<p class="returned">Returned to inventory: ${back.map(r => `<strong>${esc(r.item)}</strong> in bin <strong>${esc(r.bin)}</strong>`).join(', ')}</p>` : ''}</div>
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
  let added = 0, plain = 0; const unread = [], check = [], plains = [], replaced = [], ids = [];
  const take = d => {
    if (leftOut(d)) { plain++; markSeen(d.fileId); }
    else if (dupOf(d)) markSeen(d.fileId);
    else if (draftProblem(d) || d.lines.some(l => !String(l.item).trim())) check.push(d);
    else { const swap = plainFor(d), t = newTicketFrom(d); stamp(t, 'Picked up from the Pick Tickets folder'); addTicket(t); save(); markSeen(d.fileId); swap ? replaced.push(t.orderNumber) : added++; ids.push(t.id); }
  };
  try {
    const r = await callFlow(list);
    const waiting = new Set(view.pending.map(d => d.fileId));
    const fresh = ((r.res && fileList(await r.res.text().catch(() => ''))) || []).filter(f => isPdfFile(f) && !seen.has(f.Id) && !waiting.has(f.Id))
      .sort((a, b) => String(a.LastModified).localeCompare(String(b.LastModified)));
    for (const f of fresh) {
      const g = await pdfFromFolder(one, f);
      if (g.problem) break; // the rest come next time
      if (g.unreadable) { unread.push(fileName(f)); markSeen(f.Id); continue; }
      if (g.draft.plain) plains.push(g.draft); else take(g.draft);
    }
    plains.forEach(take);
  } catch (e) { console.error(e); }
  finally { pickingUp = false; }
  view.pending.push(...check);
  const n = (k, single, plural) => `${k} ${k === 1 ? single : plural}`;
  const msg = [
    added && `${n(added, 'new pick ticket', 'new pick tickets')} added to In progress.`,
    replacedText(replaced),
    check.length && `${n(check.length, 'new pick ticket needs', 'new pick tickets need')} checking.`,
    plain && `${n(plain, 'plain pick ticket', 'plain pick tickets')} left out. ${PLAIN}`,
    unread.length && `Could not read ${unread.join(', ')} from the folder. Use Enter by hand for ${unread.length === 1 ? 'it' : 'those'}.`
  ].filter(Boolean).join(' ');
  if (!msg) return;
  if (view.screen === 'home' || ids.includes(view.id)) render(); // a BOM that replaced the plain ticket on screen keeps its id
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
  } else if (s.kind === 'label') {
    const f = (k, label, opts = '') => `<label>${label}<input id="labf-${k}" data-labf="${k}" value="${esc(s.c[k])}" ${opts} autocomplete="off" autocorrect="off" spellcheck="false"></label>`;
    el.innerHTML = `<div class="sheetBody" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle">${s.key ? 'Change this label page' : 'Make a label by hand'}</h2>
      <p class="muted">${s.key ? 'The changes print on this page.' : 'It prints on its own page.'}</p>
      <div class="grid six">${f('model', 'Model', 'autocapitalize="characters"')}${f('serial', 'Serial number', 'autocapitalize="characters"')}${f('power', 'Power')}${f('gph', 'GPH', 'inputmode="decimal"')}${f('psi', 'PSI', 'inputmode="decimal"')}${f('lph', 'LPH', 'inputmode="decimal"')}${f('bar', 'BAR', 'inputmode="decimal"')}${f('item', 'ITEM sticker', 'autocapitalize="characters"')}</div>
      <div class="actionsBar"><button data-act="closeSheet">Cancel</button><button class="primary" data-act="${s.key ? 'saveLabel' : 'printHandLabel'}">${s.key ? 'Save' : 'Print'}</button></div></div>`;
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
const go = (screen, id = view.id) => { view.screen = screen; view.id = id; view.sheet = view.flow = view.typing = null; if (screen !== 'review') view.queue = view.note = null; render(); window.scrollTo(0, 0); if (screen === 'home') pickup(); };
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
  const pdf = await PDFLib.PDFDocument.load(await labelTemplateBytes()), form = pdf.getForm(), val = k => String(c[k] == null ? '' : c[k]).trim();
  for (const n of ['1', '2', '3']) { form.getTextField('MODEL ' + n).setText(val('model')); form.getTextField('SERIAL ' + n).setText(val('serial')); }
  for (const k of ['POWER', 'LPH', 'BAR', 'GPH', 'PSI']) form.getTextField(k).setText(val(k.toLowerCase()));
  const item = c.item != null ? val('item') : val('removed');
  form.getTextField('ITEM').setText(item);
  for (const name of ['MODEL 2', 'SERIAL 2', 'MODEL 3', 'SERIAL 3']) barcodeBeside(pdf.getPage(0), form, name, 470);
  // The order and pick ticket numbers, small, on each outside sticker that has something on it (john 2026-11-25):
  // along the bottom of the ITEM sticker and beside SERIAL# on both big labels. The pump's own small label gets none.
  if (val('order') || val('ticket')) {
    const page = pdf.getPage(0), font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica), at = y => trackCodes(page, font, val('order'), val('ticket'), 470, y);
    if (item) at(418.7);
    if (val('model') || val('serial')) { at(272.5); at(69); }
  }
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

// Code 128, the kind on the warehouse's bin and box labels: short for numbers (two digits a bar pattern), so the order
// and pick ticket barcodes stay small. Each pattern is the widths of bar, space, bar, space... in narrow bars.
const CODE128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 ' +
  '131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 ' +
  '213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 ' +
  '421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

// The bar pattern for a value: digit pairs (set C) when the value is an even number of digits, else a character each (set B).
function code128(value) {
  const s = String(value), pairs = /^(\d\d)+$/.test(s);
  if (!s || [...s].some(ch => ch < ' ' || ch > '~')) return '';
  const codes = pairs ? [105, ...s.match(/\d\d/g).map(Number)] : [104, ...[...s].map(ch => ch.charCodeAt(0) - 32)];
  codes.push(codes.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103, 106);
  return codes.map(v => CODE128[v]).join('');
}

// The order and pick ticket barcodes side by side, ending at right, each with its number in small print under it;
// y is where the small print sits. Bars are a hundredth of an inch, whole dots on a 300 or 600 dpi printer.
function trackCodes(page, font, order, ticket, right, y) {
  const m = 0.72, h = 16, size = 5.5;
  for (const [label, value] of [['Pick ticket', ticket], ['Order', order]]) {
    const bars = code128(value); if (!bars) continue;
    const caption = label + ' ' + value, bw = [...bars].reduce((n, w) => n + +w, 0) * m, tw = font.widthOfTextAtSize(caption, size), w = Math.max(bw, tw);
    let x = right - w / 2 - bw / 2;
    [...bars].forEach((n, i) => { if (i % 2 === 0) page.drawRectangle({ x, y: y + size + 1.5, width: n * m, height: h, color: PDFLib.rgb(0, 0, 0) }); x += n * m; });
    page.drawText(caption, { x: right - w / 2 - tw / 2, y, size, font, color: PDFLib.rgb(0, 0, 0) });
    right -= w + 14; // the gap is wider than the 10 narrow bars of blank a scanner needs beside a barcode
  }
}

async function printPages(t, pages, byHand = false) {
  if (!pages.length) return toast('There are no label pages to print.');
  try {
    const out = await PDFLib.PDFDocument.create();
    for (const c of pages) { const doc = await PDFLib.PDFDocument.load(await labelSheet({ ...c, order: t.orderNumber, ticket: t.ticket })); const [pg] = await out.copyPages(doc, [0]); out.addPage(pg); }
    const blob = new Blob([await out.save()], { type: 'application/pdf' });
    if (!byHand) { t.conv.printed = t.conv.printed || {}; for (const c of pages) t.conv.printed[c.key] = now(); }
    stamp(t, (byHand ? 'Label made by hand: ' : pages.length > 1 ? 'Label pages printed: ' : 'Label page printed: ') + pages.map(c => [c.model, c.serial, c.item].filter(Boolean).join(' ')).join(', ')); save(); render();
    if (embedded) return toast(`Label ${pages.length > 1 ? 'pages' : 'page'} made. Printing works in the installed iPad app.`);
    const one = pages[0], name = pages.length > 1 ? `${t.orderNumber} - label pages.pdf` : `${t.orderNumber} - ${one.model || one.item || 'label'}${one.serial ? ' - ' + shortSerial(one.serial) : ''} - label.pdf`;
    await deliverFile(blob, name.replace(/[\\/:*?"<>|]/g, '_'), pages.length > 1 ? 'Label pages ready' : 'Label page ready', 'Print at actual size on label paper.');
  } catch (e) { console.error(e); toast('The label pages could not be made.'); }
}

function completeOrder(t) {
  t.status = 'done'; t.completedAt = now(); stamp(t, t.madeWhole ? 'Conversion finished with the parts received' : 'Saved with no discrepancies'); save();
  go('home', null); toast(`Order ${t.orderNumber} saved. On to the next one.`);
}

// Yes or No on a conversion question. The answer that means a discrepancy records it, then asks for anything else
// missing or wrong, so every missing piece is on the reports the first time round (john 2026-10-29).
function answer(yes) {
  const t = current(), s = convAt(t);
  stamp(t, `${s.text} ${yes ? 'Yes' : 'No'}`);
  if ((s.problemIf === 'yes') !== yes) return nextConv(t);
  save();
  const mine = (s.lines || []).map(id => t.lines.find(l => l.id === id)).filter(l => l && l.picked > 0);
  if (mine.length === 1) return openProblem(mine[0], true, 'reports');
  chooseProblem(t, null, mine.map(l => l.id));
}
// On to the next step, or the end of the conversion: the returns went to receiving, then the Taker report when a serial
// number didn't match and it hasn't printed yet, else the order is saved.
function nextConv(t) {
  if (t.conv.step < convFlow(t).length - 1) { t.conv.step++; save(); return go('convert'); }
  const sent = t.conv.stacks.flatMap(s => s.returns.map(r => r.item));
  if (sent.length) stamp(t, 'Sent to receiving: ' + sent.join(', '));
  if (mismatches(t).length && !t.mismatchPrinted) { stamp(t, 'Conversion finished'); save(); return go('reports'); }
  completeOrder(t);
}
// A conversion problem on any checked part: the parts to choose from, or the only one. again: the "Anything else?"
// step to come back to.
function chooseProblem(t, again = null, only = []) {
  const all = t.lines.filter(l => l.picked > 0), mine = all.filter(l => only.includes(l.id)), picked = mine.length ? mine : all;
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
  if (!t.conv) t.conv = newConv(t);
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
    const dup = dupOf(d);
    if (dup) return toast(`Pick ticket ${d.ticket} is already saved${dup.status === 'done' ? ' and completed' : ''}.`);
    const swap = plainFor(d), t = newTicketFrom(d); stamp(t, d.fromPdf ? 'Imported from PDF' : 'Entered by hand');
    const kept = addTicket(t); save();
    settled(d);
    if (view.queue) actions.nextDraft(null, swap ? replacedText([t.orderNumber]) : kept === t ? `Pick ticket ${t.ticket} added to In progress.` : `Pick ticket ${t.ticket} joined order ${t.orderNumber}, which was waiting for parts.`);
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
    if (!t.conv) { t.conv = newConv(t); stamp(t, 'Conversion started'); save(); }
    go('convert');
  },
  convDone: () => {
    const t = current(), s = convAt(t);
    if (s.phase === 'stack') {
      const st = t.conv.stacks[s.s], open = st.items.filter(x => x.serial && !x.ok), blank = st.items.filter(x => !x.serial && !x.box && ['driver', 'pump'].includes(kindOf(x.item)));
      if (open.length) return toast(`Tap the serial number for ${andList(open.map(x => x.item))}, or tap Different number and type the one on the box.`);
      if (blank.length) return toast(`Type the serial number on the box for ${andList(blank.map(x => x.item))}. It prints on the label page.`);
      stamp(t, `Stack ${s.s + 1} checked: ${st.items.map(x => x.item + (x.box || x.serial ? ' ' + (x.box || x.serial) + (x.box && x.serial && !sameSerial(x.box, x.serial) ? ' (ticket ' + x.serial + ')' : '') : '')).join(', ')}`);
    }
    if (s.phase === 'labels') {
      const left = labelPages(t).filter(pg => !(t.conv.printed || {})[pg.key]).length, key = t.id + ':' + t.conv.step;
      if (left && view.warned !== key) { view.warned = key; return toast(`${left === 1 ? '1 label page hasn\'t' : left + ' label pages haven\'t'} been printed. Tap Done again to go on anyway.`); }
    }
    nextConv(t);
  },
  convPrev: () => { const t = current(); t.conv.step = Math.max(0, t.conv.step - 1); save(); go('convert'); },
  serialOk: b => { const t = current(), x = t.conv.stacks[+b.dataset.s].items[+b.dataset.k]; x.ok = true; x.box = ''; view.typing = null; save(); render(); },
  serialOther: b => {
    const t = current(), x = t.conv.stacks[+b.dataset.s].items[+b.dataset.k];
    view.typing = `${b.dataset.s}:${b.dataset.k}`; x.ok = !!x.box; save(); render();
    const el = $(`#sbox-${b.dataset.s}-${b.dataset.k}`); if (el) el.focus();
  },
  printAllLabels: () => printPages(current(), labelPages(current())),
  printLabel: b => printPages(current(), labelPages(current()).filter(pg => pg.key === b.dataset.key)),
  editLabel: b => { const pg = labelPages(current()).find(x => x.key === b.dataset.key); view.sheet = { kind: 'label', key: pg.key, c: { ...pg } }; renderSheet(); },
  handLabel: () => { view.sheet = { kind: 'label', key: null, c: { model: '', serial: '', power: '', gph: '', psi: '', lph: '', bar: '', item: '' } }; renderSheet(); },
  saveLabel: () => {
    const t = current(), s = view.sheet;
    t.conv.edits = t.conv.edits || {}; t.conv.edits[s.key] = Object.fromEntries(LABEL_KEYS.map(k => [k, String(s.c[k] || '').trim()]));
    if (t.conv.printed) delete t.conv.printed[s.key];
    stamp(t, `Label page changed: ${LABEL_KEYS.map(k => s.c[k]).filter(Boolean).join(' ')}`); save(); view.sheet = null; render();
  },
  printHandLabel: async () => {
    const c = view.sheet.c;
    if (!LABEL_KEYS.some(k => String(c[k] || '').trim())) return toast('Fill in the label first.');
    view.sheet = null; renderSheet();
    await printPages(current(), [c], true);
  },
  convYes: () => answer(true),
  convNo: () => answer(false),
  backToTicket: () => go('ticket'),
  print: () => {
    const t = current();
    const first = t.status !== 'done', wait = first && canWait(t);
    if (wait) { t.waiting = now(); stamp(t, 'Taker report printed, waiting for parts'); }
    else if (first) { t.status = 'done'; t.completedAt = now(); stamp(t, hasProblems(t) ? 'Reports printed, pick ticket completed' : 'Taker report with the mismatched serial numbers printed, pick ticket completed'); }
    if (mismatches(t).length) t.mismatchPrinted = true;
    save();
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
// Some conversions print only the plain pick ticket (john 2026-10-30): one with a CONV line comes in, unless the app
// has its BOM (same pick ticket) or a BOM order of the same number waiting for parts, whose corrected BOM will come.
// A BOM that comes in later takes the plain one's place while nobody has started it. PDFs that arrive together
// bring in their BOMs before their plain pick tickets.
const PLAIN = 'The app only needs the BOM.';
const leftOut = d => d.plain && (!d.products.length || db.tickets.some(t => t.type === 'BOM' && (t.ticket === d.ticket.trim() || (t.waiting && t.orderNumber === d.orderNumber.trim()))));
const notStarted = t => t.status === 'open' && !t.picker && !t.conv && !t.waiting && t.lines.every(l => !l.picked && !l.problems.length);
const plainFor = d => d.type === 'BOM' && db.tickets.find(t => t.fromPlain && t.ticket === d.ticket.trim() && notStarted(t));
// The ticket the app already has with this pick ticket number, other than a plain one this BOM replaces.
const dupOf = d => !plainFor(d) && db.tickets.find(t => t.ticket === d.ticket.trim());
const replacedText = orders => orders.length > 1 ? `The BOMs for orders ${orders.join(', ')} replaced their plain pick tickets.` : orders.length ? `The BOM for order ${orders[0]} replaced its plain pick ticket.` : '';

async function importPdf(file) {
  if (!file) return;
  toast('Reading ' + file.name + '…');
  try {
    const d = await readPdf(file);
    if (leftOut(d)) return toast(`That's a plain pick ticket, so it was left out. ${PLAIN}`, 8000);
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
  let added = 0, already = 0, plain = 0; const unread = [], check = [], plains = [], replaced = [];
  const take = d => {
    if (leftOut(d)) plain++;
    else if (dupOf(d)) already++;
    else if (draftProblem(d) || d.lines.some(l => !String(l.item).trim())) check.push(d);
    else { const swap = plainFor(d), t = newTicketFrom(d); stamp(t, 'Imported from PDF'); addTicket(t); swap ? replaced.push(t.orderNumber) : added++; }
  };
  try {
    for (const [i, file] of files.entries()) {
      toast(`Reading ${i + 1} of ${files.length}…`, 60000);
      let d;
      try { d = await readPdf(file); } catch (e) { console.error(e); unread.push(file.name); continue; }
      if (d.plain) plains.push(d); else take(d);
    }
    plains.forEach(take);
  } finally { importing = false; }
  save();
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const msg = !added && !replaced.length && !check.length && !unread.length && !plain ? `All ${already} pick tickets are already in the app.` : [
    added && `${n(added, 'pick ticket', 'pick tickets')} added to In progress.`,
    replacedText(replaced),
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
  else if (el.dataset.serialbox) {
    // Typing the ticket's own number checks it like a tap. The screen isn't redrawn while typing, so the next tap
    // lands on the button under the finger; the note and the serial button change in place.
    const [si, k] = el.dataset.serialbox.split(':').map(Number), x = current().conv.stacks[si].items[k], typed = el.value.trim().toUpperCase();
    if (x.serial && sameSerial(typed, x.serial)) { x.box = ''; x.ok = true; } else { x.box = typed; x.ok = !!typed; }
    save();
    const note = $(`#soff-${si}-${k}`), btn = $(`.serialBtn[data-s="${si}"][data-k="${k}"]`), on = x.ok && !x.box;
    if (note) note.hidden = !(x.box && x.serial);
    if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on); btn.textContent = (on ? '✓ ' : '') + shortSerial(x.serial); }
  }
  else if (el.dataset.labf && view.sheet) {
    const c = view.sheet.c, k = el.dataset.labf;
    c[k] = el.value;
    if (k === 'gph') { c.lph = P.toLph(c.gph.trim()); $('#labf-lph').value = c.lph; }
    if (k === 'psi') { c.bar = P.toBar(c.psi.trim()); $('#labf-bar').value = c.bar; }
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
document.body.insertAdjacentHTML('beforeend', ART_DEFS);
load(); render(); pickup(true);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pickup(); });
if ('serviceWorker' in navigator && !embedded && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
