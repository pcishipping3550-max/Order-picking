// Reads pick tickets and bills of material (text from pdf.js) into a ticket draft.
// Input: pages = [[{text, x, y}]], y measured down from the top of the page.
// Every import goes through a review screen, so the picker can fix anything this misreads.
(function (root) {
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const isQty = s => /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(clean(s));
  const toQty = s => Number(clean(s).replace(/,/g, ''));
  const isItem = s => /^[A-Z0-9][A-Z0-9 ._\/#-]*$/i.test(clean(s)) && /\d/.test(s) && clean(s).length <= 40;

  // Group text pieces into visual rows, left to right. Emailed tickets draw some text twice in the same spot, a hidden
  // white copy first and the visible text over it, so only the last piece drawn at a spot is kept.
  function rows(items) {
    const out = [], drawn = items.filter(i => clean(i.text) && !/^[▌█\s]+$/.test(i.text));
    const shown = drawn.filter((it, n) => !drawn.some((o, m) => m > n && Math.abs(o.x - it.x) < 1.5 && Math.abs(o.y - it.y) < 1.5));
    for (const it of shown.sort((a, b) => a.y - b.y || a.x - b.x)) {
      let r = out.find(r => Math.abs(r.y - it.y) < 2.5);
      if (!r) { r = { y: it.y, items: [] }; out.push(r); }
      r.items.push(it);
    }
    for (const r of out) { r.items.sort((a, b) => a.x - b.x); r.text = r.items.map(i => clean(i.text)).join(' '); }
    return out.sort((a, b) => a.y - b.y);
  }

  // The first number printed under a label such as "Pick Ticket Number".
  function numberUnder(items, re) {
    const label = items.find(i => re.test(clean(i.text)));
    if (!label) return '';
    const hit = items
      .filter(i => i.y > label.y + 2 && i.y < label.y + 30 && i.x > label.x - 45 && i.x < label.x + 160 && /^\d{4,}$/.test(clean(i.text)))
      .sort((a, b) => a.y - b.y)[0];
    return hit ? clean(hit.text) : '';
  }

  function taker(items) {
    const label = items.find(i => /^Taker:?$/i.test(clean(i.text)));
    if (!label) {
      // Service orders print it on one line at the top right: "Order Taker: name".
      const inline = items.find(i => /^Order Taker:/i.test(clean(i.text)));
      return inline ? clean(inline.text).replace(/^Order Taker:\s*/i, '') : '';
    }
    return rows(items.filter(i => i.y > label.y + 2 && i.y < label.y + 30 && i.x > label.x - 70 && i.x < label.x + 110))
      .map(r => r.text).find(t => t && !/^\d/.test(t)) || '';
  }

  function addresses(items) {
    const bill = items.find(i => /^Bill To:?/i.test(clean(i.text)));
    const ship = items.find(i => /^Ship To:?/i.test(clean(i.text)));
    if (!bill || !ship) return { billTo: '', shipTo: '' };
    const stop = items.filter(i => /Ordered By:|Customer ID:|Order Date/i.test(i.text) && i.y > bill.y + 5).sort((a, b) => a.y - b.y)[0];
    const end = stop ? stop.y : bill.y + 80;
    const block = (left, right) => rows(items.filter(i => i.x >= left - 3 && i.x < right && i.y > bill.y + 2 && i.y < end - 2)).map(r => r.text).join('\n');
    const lo = bill.x < ship.x ? bill : ship, hi = lo === bill ? ship : bill;
    const a = block(lo.x, hi.x - 10), b = block(hi.x, 612);
    return lo === bill ? { billTo: a, shipTo: b } : { billTo: b, shipTo: a };
  }

  // "Customer ID: 123456": the number is in the same piece of text or the next one on that line.
  function customerId(items) {
    const label = items.find(i => /^Customer (?:ID|No\.?|Number|#):?/i.test(clean(i.text)));
    if (!label) return '';
    const inline = clean(label.text).replace(/^Customer (?:ID|No\.?|Number|#):?\s*/i, '');
    if (inline) return inline;
    const next = items.filter(i => Math.abs(i.y - label.y) < 2.5 && i.x > label.x + 5 && i.x < label.x + 160).sort((a, b) => a.x - b.x)[0];
    return next ? clean(next.text) : '';
  }

  // qty is how many the ticket says to take from that bin, when it says.
  function addBin(target, bin, qty) {
    bin = clean(bin);
    if (!target || !bin) return;
    const bins = target.bin ? target.bin.split(' / ') : [];
    if (!bins.includes(bin)) bins.push(bin);
    target.bin = bins.join(' / ');
    if (qty != null) target.binQty = { ...target.binQty, [bin]: qty };
  }
  // "BIN: FF0404   Qty: 1.00 EA": the number after "Qty:".
  function binQty(r) {
    const label = r.items.find(i => /^Qty:?$/i.test(clean(i.text)));
    const q = label && r.items.find(i => i.x > label.x && isQty(i.text));
    return q ? toQty(q.text) : null;
  }

  function addDesc(target, text) {
    text = clean(text);
    if (!target || !text || /^(EA|BIN:?|Qty:?|PROD)$/i.test(text) || isQty(text)) return;
    if (target.desc.includes(text)) return;
    if (text.includes(target.desc) && target.desc) { target.desc = text; return; } // a fuller repeat of the same text
    target.desc = target.desc ? target.desc + ' ' + text : text;
  }

  const SKIP = /Deposit Bin:|Total Lines:|Total Pieces:|Total Weight:|REPRINT|Document ID|Complete Order|SUB-TOTAL|GRAND TOTAL|TAX:|ACH ACCOUNT|ACCT NO\.|Picked By|^\d+\.\d+\.\d+ - \d/i;

  function header(first) {
    return {
      orderNumber: numberUnder(first, /^(?:Service |Sales |Production )?Order (?:Number|No\.?|#)$/i),
      ticket: numberUnder(first, /^Pick Ticket (?:Number|No\.?)$/i),
      taker: taker(first)
    };
  }

  // Where a page's part number and quantity columns are, found from their headings: the tickets and BOMs Prophet 21
  // emails have them further right than the printed ones. Quantity is To Pick, or Allocated on a service order.
  function columns(page) {
    const head = re => page.find(i => re.test(clean(i.text)));
    const item = head(/^(?:Item ID|Parts ID and Description)$/i), qty = head(/^To Pick$/i) || head(/^Allocated$/i);
    return item && qty ? { item: [item.x - 10, item.x + 25], qty: [qty.x - 12, qty.x + 35] } : null;
  }

  // Sales, service and BOM tickets share one layout of rows; their columns move.
  function parseStandard(pages, isBom) {
    const first = pages[0];
    const t = {
      type: isBom ? 'BOM' : first.some(i => /Service Order Number/i.test(i.text)) ? 'Service' : 'Sales',
      ...header(first), customerId: customerId(first), service: '', lines: [], products: [], ...addresses(first)
    };
    t.customer = t.billTo.split('\n')[0] || t.shipTo.split('\n')[0] || '';
    let serviceMode = false, cur = null, product = null, comp = null, col = { item: [215, 255], qty: [110, 175] };
    for (const page of pages) {
      const head = page.find(i => /^Item Description$/i.test(clean(i.text)));
      const top = head ? head.y + 14 : 230;
      col = columns(page) || col;
      for (const r of rows(page)) {
        if (r.y < top || r.y > 718 || SKIP.test(r.text)) continue;
        if (/\*+\s*Service Item\s*\*+/i.test(r.text)) { serviceMode = true; cur = null; continue; }
        if (/\*+\s*Service Part\s*\*+/i.test(r.text)) { serviceMode = false; cur = null; continue; }

        if (isBom) {
          const level = r.items.find(i => /^Level:$/i.test(clean(i.text)));
          if (level) {
            const num = r.items.find(i => i.x >= col.item[0] && i.x < col.item[1]); // the part number, in the Item ID column
            if (num && product) {
              comp = { item: clean(num.text), desc: '', bin: '', qty: 0, level: Number(clean((r.items.find(i => i.x > level.x + 20 && i.x < 200) || {}).text)) || 0 };
              product.components.push(comp);
            }
            cur = comp;
            continue;
          }
          if (/Qty Per Assembly:|Total Qty:/i.test(r.text)) {
            const q = r.items.find(i => i.x > 110 && i.x < 175 && isQty(i.text));
            if (comp && q && /Total Qty:/i.test(r.text)) comp.qty = toQty(q.text);
            continue;
          }
        }

        const item = r.items.find(i => i.x >= col.item[0] && i.x < col.item[1] && isItem(i.text));
        const qty = r.items.find(i => i.x >= col.qty[0] && i.x < col.qty[1] && isQty(i.text));
        if (item && qty) {
          if (serviceMode) { t.service += clean(item.text) + '\n'; cur = null; continue; }
          if (isBom) {
            product = { item: clean(item.text), desc: '', qty: toQty(qty.text), components: [] };
            t.products.push(product); comp = null; cur = product;
          } else {
            cur = { item: clean(item.text), desc: '', bin: '', qty: toQty(qty.text) };
            t.lines.push(cur);
          }
          continue;
        }
        if (serviceMode) { if (/Serial Number:|Ordered As:/i.test(r.text)) t.service += r.text + '\n'; continue; }
        if (!cur) continue;
        const serial = /^Serial Number:\s*(\S.*)$/i.exec(r.text); // the serial numbers Prophet 21 set aside for this line
        if (serial) { cur.serials = [...(cur.serials || []), clean(serial[1])]; continue; }
        const binLabel = r.items.find(i => /^BIN:/i.test(clean(i.text)));
        if (binLabel) {
          const inline = clean(binLabel.text).replace(/\bBIN:\s*/gi, ''); // service orders list every bin: "BIN:A1; BIN:DOCK"
          const next = r.items.find(i => i.x > binLabel.x + 5 && i.x < 380 && !/Qty:/i.test(i.text));
          if (cur !== product) addBin(cur, inline || (next && next.text), binQty(r));
          continue;
        }
        addDesc(cur, r.items.filter(i => i.x >= 215 && i.x < 440).map(i => i.text).join(' '));
      }
    }
    t.service = t.service.trim();
    for (const p of t.products) {
      p.kind = /\bCONV\b/i.test(p.item + ' ' + p.desc) ? 'conversion' : 'assembly';
      p.returns = p.components.filter(c => c.qty < 0).map(c => ({ item: c.item, desc: c.desc, bin: c.bin, qty: -c.qty }));
      for (const c of p.components.filter(c => c.qty > 0)) t.lines.push({ item: c.item, desc: c.desc, bin: c.bin, binQty: c.binQty, serials: c.serials, qty: c.qty, product: p.item });
      delete p.components;
    }
    return t;
  }

  function parseProduction(pages) {
    const t = { type: 'Production', ...header(pages[0]), customer: '', customerId: '', billTo: '', shipTo: '', service: '', lines: [], products: [] };
    let cur = null; // a line's bin can land at the top of the next page
    for (const page of pages) {
      const head = page.find(i => clean(i.text) === 'To Pick');
      const top = head ? head.y + 8 : 190;
      for (const r of rows(page)) {
        if (r.y < top || r.y > 750 || SKIP.test(r.text)) continue;
        const item = r.items.find(i => i.x > 262 && i.x < 292 && isItem(i.text));
        const qty = r.items.find(i => i.x > 175 && i.x < 240 && isQty(i.text));
        if (item && qty) { cur = { item: clean(item.text), desc: '', bin: '', qty: toQty(qty.text) }; t.lines.push(cur); continue; }
        if (!cur) continue;
        const binLabel = r.items.find(i => /^BIN:?$/i.test(clean(i.text)));
        if (binLabel) { const b = r.items.find(i => i.x > binLabel.x + 5 && i.x < 430); addBin(cur, b && b.text, binQty(r)); continue; }
        addDesc(cur, r.items.filter(i => i.x >= 262 && i.x < 540).map(i => i.text).join(' '));
      }
    }
    return t;
  }

  function parsePages(pages) {
    const empty = { type: 'Sales', orderNumber: '', ticket: '', taker: '', customer: '', customerId: '', billTo: '', shipTo: '', service: '', lines: [], products: [] };
    if (!pages || !pages.length || !pages[0].length) return { ...empty, unreadable: true };
    const first = pages[0];
    let t;
    if (first.some(i => /PRODUCTION PICK TICKET/i.test(i.text))) t = parseProduction(pages);
    else t = parseStandard(pages, first.some(i => /BILL OF MATERIAL/i.test(i.text)));
    t.lines = t.lines.filter(l => l.qty > 0);
    for (const l of t.lines) {
      l.bin = pickBins(l);
      if (l.serials) l.desc = [l.desc, (l.serials.length > 1 ? 'Serial numbers ' : 'Serial number ') + l.serials.join(', ')].filter(Boolean).join(' · ');
      delete l.binQty; delete l.serials;
    }
    return t;
  }

  // The bins a line shows. When the ticket gives a quantity per bin, the bins it says to take them from: a sales
  // ticket can list a part's empty bins too, at 0.00. Otherwise the current bins.
  function pickBins(line) {
    const from = Object.keys(line.binQty || {}).filter(b => line.binQty[b] > 0);
    return from.length ? from.join(' / ') : currentBins(line.bin);
  }

  // Bins are being renamed, and the current ones are two characters then four numbers (CC0201-T, FF0503, 0H0201).
  // When a part lists one of those, the old bins are left off.
  function currentBins(bin) {
    const all = String(bin || '').split(/;|\s\/\s/).map(clean).filter(Boolean);
    const current = all.filter(b => /^[A-Z0-9][A-Z]\d{4}/i.test(b));
    return current.length ? current.join(bin.includes(';') ? '; ' : ' / ') : clean(bin);
  }

  // Conversion label values from a BOM product, e.g. "C131-415SI CONV" + "8 gph 60 psi ...".
  function labelDefaults(product) {
    const text = product.desc || '';
    const gph = (text.match(/([\d.]+)\s*gph/i) || [])[1] || '';
    const psi = (text.match(/([\d.]+)\s*psi/i) || [])[1] || '';
    return {
      model: clean(product.item.replace(/\bCONV\b/ig, '')),
      removed: (product.returns || []).map(r => r.item).join(', '),
      gph, psi, lph: toLph(gph), bar: toBar(psi), power: '', serial: ''
    };
  }
  const round3 = n => String(+n.toFixed(3));
  const toLph = gph => gph === '' || isNaN(+gph) ? '' : round3(+gph * 3.785411784);
  const toBar = psi => psi === '' || isNaN(+psi) ? '' : round3(+psi * 0.0689475729);

  root.TicketParser = { parsePages, rows, labelDefaults, toLph, toBar };
  if (typeof module !== 'undefined') module.exports = root.TicketParser;
})(globalThis);
