/* cart.js вЂ” СЃРїС–Р»СЊРЅРёР№ РєРѕС€РёРє РґР»СЏ РІСЃС–С… СЃС‚РѕСЂС–РЅРѕРє В«Р“РѕСЃС‚СЂРѕВ».
   Р—Р±РµСЂС–РіР°РЅРЅСЏ: localStorage 'latiao_cart' в†’ [{id,name,price,qty,image,sku}]
   API: window.LatiaoCart = {add, remove, setQty, items, count, total, open, close, onChange}
   Р—Р°Р»РёС€РєРё: РєС–Р»СЊРєС–СЃС‚СЊ С‚РѕРІР°СЂСѓ РІ РєРѕС€РёРєСѓ РѕР±РјРµР¶РµРЅР° Р·Р°Р»РёС€РєР°РјРё (stock) Р· Firestore,
   Р·РІС–СЂСЏРЅРЅСЏ РїРѕ Р°СЂС‚РёРєСѓР»Сѓ (article/sku). */
(function () {
  'use strict';
  var KEY = 'latiao_cart';
  var FREE_SHIPPING_THRESHOLD = window.FREE_SHIPPING_THRESHOLD || 1100;
  window.FREE_SHIPPING_THRESHOLD = FREE_SHIPPING_THRESHOLD;

  function read() {
    try { var raw = localStorage.getItem(KEY); var a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    listeners.forEach(function (f) { f(items); });
    syncCount();
  }
  var listeners = [];
  function onChange(f) { if (typeof f === 'function') listeners.push(f); }

  function items() { return read(); }
  function count() { return read().reduce(function (s, i) { return s + i.qty; }, 0); }
  /* РЎСѓРјР° РїРѕ РїРѕР·РёС†С–С— РІ С€С‚СѓРєР°С…: РїРѕРІРЅС– С„Р°СЃСѓРІР°РЅРЅСЏ вЂ” РїРѕ С†С–РЅС– С„Р°СЃСѓРІР°РЅРЅСЏ (packPrice),
     Р·Р°Р»РёС€РѕРє (РјРµРЅС€Рµ Р·Р° С„Р°СЃСѓРІР°РЅРЅСЏ) вЂ” РїРѕ СЃС‚Р°РЅРґР°СЂС‚РЅС–Р№ С†С–РЅС– Р·Р° 1 С€С‚ (basePrice).
     РќР°РїСЂ., С„Р°СЃСѓРІР°РЅРЅСЏ В«2 С€С‚ / 145 РіСЂРЅВ», СЃС‚Р°РЅРґР°СЂС‚ 79 РіСЂРЅ:
     1 С€С‚ = 79, 2 С€С‚ = 145, 3 С€С‚ = 224, 4 С€С‚ = 290. */
  function itemSum(i, qty) {
    var pc = Number(i.packCount || 1);
    if (!(pc > 1) || !(i.packPrice > 0)) return qty * Number(i.price || 0);
    var packs = Math.floor(qty / pc);
    var rem = qty - packs * pc;
    return packs * Number(i.packPrice || 0) + rem * Number(i.basePrice || i.price || 0);
  }
  function piecePrice(i, qty) {
    qty = qty || 0;
    return qty > 0 ? itemSum(i, qty) / qty : Number(i.price || 0);
  }
  function total() { return read().reduce(function (s, i) { return s + itemSum(i, i.qty); }, 0); }

  /* ---------- Р—Р°Р»РёС€РєРё (Р·РІС–СЂСЏРЅРЅСЏ РїРѕ Р°СЂС‚РёРєСѓР»Сѓ) ---------- */
  var PROJECT_ID = 'latiao-snack';
  var stockMap = null;          // РЅРѕСЂРјР°Р»С–Р·РѕРІР°РЅРёР№ Р°СЂС‚РёРєСѓР» в†’ {stock, id}
  var stockMapByName = null;
  var stockById = null;         // doc id в†’ stock
  var stockPromise = null;
  var stockLoadFailed = false;

  function normSku(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, ''); }
  function normName(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s"'«»„“”.,:;!?()\-–—]+/g, ''); }

  function fetchStocks(force) {
    if (force) { stockPromise = null; stockMap = null; stockMapByName = null; stockById = null; stockLoadFailed = false; }
    if (stockPromise) return stockPromise;
    function buildMaps(list) {
      stockMap = {}; stockMapByName = {}; stockById = {};
      list.forEach(function (rec) {
        var p = rec.data || {};
        var stock = (p.stock !== undefined && p.stock !== null) ? Number(p.stock) : (p.quantity !== undefined ? Number(p.quantity) : 0);
        if (p.stock === false || p.inStock === false) stock = 0;
        if (!isFinite(stock)) stock = 0;
        var sku = ['article', 'articul', 'sku', 'vendorCode', 'productCode', 'code'].map(function (k) { return p[k]; }).find(function (v) { return v !== undefined && v !== null && String(v).trim(); }) || '';
        stockById[rec.id] = stock;
        if (sku) stockMap[normSku(sku)] = { stock: stock, id: rec.id };
        var name = p.name || p.title || '';
        if (name) stockMapByName[normName(name)] = { stock: stock, id: rec.id };
      });
      stockLoadFailed = false;
      return stockMap;
    }
    /* Stocks are read from Firestore latiao-snack via the shared module js/firebase-init.js.
       Fallback - public REST access to the same Firestore. */
    stockPromise = import('./js/firebase-init.js')
      .then(function (m) { return m.getDocs(m.collection(m.db, 'products')); })
      .then(function (snap) { return snap.docs.map(function (d) { return { id: d.id, data: d.data() }; }); })
      .then(buildMaps)
      .catch(function () {
        return fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/products?pageSize=500')
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function (data) {
            return buildMaps((data.documents || []).map(function (d) {
              var f = d.fields || {};
              function num(name) {
                var v = f[name];
                if (!v) return 0;
                if (v.integerValue !== undefined) return Number(v.integerValue);
                if (v.doubleValue !== undefined) return Number(v.doubleValue);
                return 0;
              }
              function str(name) {
                var v = f[name];
                return v && v.stringValue !== undefined ? String(v.stringValue) : '';
              }
              return {
                id: d.name.split('/').pop(),
                data: {
                  stock: f.stock !== undefined ? num('stock') : (f.quantity !== undefined ? num('quantity') : undefined),
                  quantity: f.quantity !== undefined ? num('quantity') : undefined,
                  article: str('article'), articul: str('articul'), sku: str('sku'),
                  vendorCode: str('vendorCode'), productCode: str('productCode'), code: str('code'),
                  name: str('name'), title: str('title')
                }
              };
            }));
          });
      })
      .catch(function (e) { console.warn('cart.js: failed to load stocks', e); stockMap = {}; stockMapByName = {}; stockById = {}; stockLoadFailed = true; return stockMap; });
    return stockPromise;
  }

  function stockFor(p) {
    /* РЎРїРѕС‡Р°С‚РєСѓ РїРѕ Р°СЂС‚РёРєСѓР»Сѓ, РїРѕС‚С–Рј РїРѕ id СЏРє fallback */
    if (p.sku && stockMap && stockMap[normSku(p.sku)] !== undefined) return stockMap[normSku(p.sku)].stock;
    if (stockById && stockById[String(p.id)] !== undefined) return stockById[String(p.id)];
    if (p.name && stockMapByName && stockMapByName[normName(p.name)] !== undefined) return stockMapByName[normName(p.name)].stock;
    return null;
  }

  var lastAdd = { id: null, t: 0 };
  function add(p) {
    /* Р—Р°С…РёСЃС‚ РІС–Рґ РїРѕРґРІС–Р№РЅРѕРіРѕ РґРѕРґР°РІР°РЅРЅСЏ РІ РјРµР¶Р°С… РѕРґРЅРѕРіРѕ РєР»С–РєСѓ: СЏРєС‰Рѕ РЅР° РєРЅРѕРїС†С– В«Р’ РєРѕС€РёРєВ»
       РІС–С€Р°С”С‚СЊСЃСЏ РєС–Р»СЊРєР° РѕР±СЂРѕР±РЅРёРєС–РІ (РЅР°РїСЂ., onclick РЅР° РєР°СЂС‚С†С– + РіР»РѕР±Р°Р»СЊРЅРёР№ СЃР»СѓС…Р°С‡ cart.js),
       РґСЂСѓРіРёР№ РІРёРєР»РёРє add() Р· С‚РёРј СЃР°РјРёРј id РїСЂРѕС‚СЏРіРѕРј 50 РјСЃ С–РіРЅРѕСЂСѓС”С‚СЊСЃСЏ.
       Р›СЋРґРёРЅР° С„С–Р·РёС‡РЅРѕ РЅРµ РјРѕР¶Рµ РєР»С–РєРЅСѓС‚Рё РґРІС–С‡С– Р·Р° 50 РјСЃ, С‚РѕРјСѓ Р·РІРёС‡Р°Р№РЅС– РїРѕРІС‚РѕСЂРЅС–
       РєР»С–РєРё (РґРѕРґР°С‚Рё С‰Рµ 1 С€С‚) РїСЂР°С†СЋСЋС‚СЊ СЏРє С– СЂР°РЅС–С€Рµ. */
    var now = Date.now();
    if (p && String(p.id) === String(lastAdd.id) && now - lastAdd.t < 50) return;
    lastAdd = { id: p ? String(p.id) : null, t: now };
    var list = read();
    var found = null;
    for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(p.id)) { found = list[k]; break; } }
    var pc = Math.max(1, Number(p.packCount || 1));
    var packPrice = Number(p.packPrice || 0);
    var basePrice = Number(p.basePrice || 0);
    var q = Math.max(1, Number(p.qty || 1)) * pc; /* РєС–Р»СЊРєС–СЃС‚СЊ Сѓ С€С‚СѓРєР°С… */
    var stock = stockFor(p);
    if (stock !== null && stock <= 0) { notify('РўРѕРІР°СЂСѓ РЅРµРјР°С” РІ РЅР°СЏРІРЅРѕСЃС‚С–'); return false; }
    if (found) {
      var max = stock !== null ? stock : 99;
      if (found.qty + q > max) {
        found.qty = max;
        notify('Р’ РЅР°СЏРІРЅРѕСЃС‚С– Р»РёС€Рµ ' + max + ' С€С‚ вЂ” Р±С–Р»СЊС€Рµ РґРѕРґР°С‚Рё РЅРµ РјРѕР¶РЅР°');
      } else {
        found.qty = found.qty + q;
      }
    } else {
      var q2 = stock !== null ? Math.min(q, stock) : q;
      if (q2 < q) notify('Р’ РЅР°СЏРІРЅРѕСЃС‚С– Р»РёС€Рµ ' + stock + ' С€С‚ вЂ” РґРѕРґР°РЅРѕ ' + q2 + ' С€С‚');
      list.push({
        id: p.id, name: p.name || 'РўРѕРІР°СЂ',
        price: pc > 1 && packPrice > 0 ? packPrice / pc : Number(p.price || 0),
        qty: q2, image: p.image || '', sku: p.sku || '', unit: p.unit || '',
        packCount: pc, packPrice: packPrice, basePrice: basePrice || Number(p.price || 0)
      });
    }
    write(list);
    return true;
  }
  function setQty(id, qty) {
    var list = read();
    var it = null;
    for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(id)) { it = list[k]; break; } }
    if (!it) return;
    var stock = stockFor(it);
    var max = stock !== null ? stock : 99;
    var v = Math.max(1, Math.min(max, Number(qty) || 1));
    if (Number(qty) > max) notify('Р’ РЅР°СЏРІРЅРѕСЃС‚С– Р»РёС€Рµ ' + max + ' С€С‚');
    write(list.map(function (i) { return String(i.id) === String(id) ? Object.assign({}, i, { qty: v }) : i; }));
  }
  function notify(msg) {
    if (typeof window.__say === 'function') { window.__say(msg); return; }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1B1B1B;color:#FFF4E6;padding:12px 20px;border-radius:999px;font:600 14px sans-serif;z-index:999;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function remove(id) { write(read().filter(function (i) { return String(i.id) !== String(id); })); }
  function clear() { write([]); }

  /* ---------- Р›С–С‡РёР»СЊРЅРёРє Сѓ С…РµРґРµСЂС– ---------- */
  function syncCount() {
    var n = count();
    document.querySelectorAll('[data-count]').forEach(function (c) {
      c.textContent = String(n);
      c.hidden = n === 0;
      c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
    });
  }

  /* ---------- Р РѕР·РјС–С‚РєР° С‚Р° СЃС‚РёР»С– С€СѓС…Р»СЏРґРё ---------- */
  var CSS = ''
    + '.cartroot{position:fixed;inset:0;z-index:90;pointer-events:none}'
    + '.cartroot[hidden]{display:none}'
    + '.cart-scrim{position:absolute;inset:0;background:rgba(27,27,27,.6);opacity:0;transition:opacity .2s ease-out;pointer-events:auto}'
    + '.cartroot.is-open .cart-scrim{opacity:1}'
    + '.cart-panel{position:absolute;top:0;right:0;height:100%;width:min(420px,100%);background:var(--color-cream,#FFF4E6);color:var(--color-ink,#1B1B1B);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .24s ease-out;pointer-events:auto}'
    + '.cart-panel--left{left:0;right:auto;transform:translateX(-102%)}'
    + '.cartroot.is-open .cart-panel{transform:none}'
    + '.cart-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 20px 16px}'
    + '.cart-head h2{font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:1.5rem;margin:0;letter-spacing:-.01em}'
    + '.cart-head h2 small{font-weight:800;font-size:1.5rem}'
    + '.cart-close{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;flex:none;border:0;border-radius:50%;background:var(--color-ink,#1B1B1B);color:var(--color-cream,#FFF4E6);cursor:pointer;transition:transform .16s ease-out,background .16s ease-out}'
    + '.cart-close:hover{background:var(--color-accent,#FF6A1A);color:var(--color-ink,#1B1B1B)}'
    + '.cart-close:active{transform:scale(.94)}'
    + '.cart-close svg{width:22px;height:22px;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;fill:none}'
    + '.cart-body{flex:1;overflow-y:auto;padding:0 20px;-webkit-overflow-scrolling:touch}'
    + '.cart-item{display:grid;grid-template-columns:56px 1fr auto;gap:6px 12px;align-items:start;padding:14px 0;border-bottom:2px solid var(--color-ink,#1B1B1B)}'
    + '.cart-item:last-child{border-bottom:0}'
    + '.cart-item__ph{grid-row:1/3;width:64px;height:64px;flex:none;border-radius:14px;border:2px solid var(--color-ink,#1B1B1B);background:var(--color-white,#fff);box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:1.4rem;overflow:hidden}'
    + '.cart-item__ph img{display:block;width:100%;height:100%;object-fit:contain;object-position:center}'
    + '.cart-item__name{font-family:var(--font-head,Montserrat,sans-serif);font-weight:700;font-size:.82rem;line-height:1.25;margin:0;padding-right:6px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}'
    + '.cart-item__price{margin:0;font-size:.78rem;font-weight:500;opacity:.85}'
    + '.cart-item__del{grid-row:1;grid-column:3;justify-self:end;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:var(--color-ink,#1B1B1B);cursor:pointer;opacity:.8;transition:opacity .16s ease-out,color .16s ease-out}'
    + '.cart-item__del:hover{opacity:1;color:#DA291C}'
    + '.cart-item__del svg{width:16px;height:16px;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;fill:none}'
    + '.cart-item__ctrl{grid-row:2;grid-column:2/4;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}'
    + '.cart-qty{display:inline-flex;align-items:center;gap:2px;border:2px solid var(--color-ink,#1B1B1B);border-radius:999px;background:var(--color-cream,#FFF4E6);padding:2px}'
    + '.cart-qty button{width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:var(--color-ink,#1B1B1B);font-size:1rem;font-weight:700;cursor:pointer;line-height:1;transition:background .16s ease-out}'
    + '.cart-qty button:hover{background:var(--color-accent,#FF6A1A)}'
    + '.cart-qty output{min-width:24px;text-align:center;font-weight:700;font-size:.85rem}'
    + '.cart-item__sum{font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:1rem;white-space:nowrap}'
    + '.cart-item__sum small{font-weight:800;font-size:.8rem}'
    + '.cart-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:32px 20px}'
    + '.cart-empty__emoji{width:72px;height:72px;border-radius:50%;background:var(--color-white,#fff);border:3px solid var(--color-ink,#1B1B1B);display:flex;align-items:center;justify-content:center;font-size:2rem}'
    + '.cart-empty h3{font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:1.15rem;margin:0}'
    + '.cart-empty p{margin:0;font-size:.9rem;opacity:.75}'
    + '.cart-foot{padding:14px 20px calc(16px + env(safe-area-inset-bottom,0px));border-top:2px solid var(--color-ink,#1B1B1B);display:flex;flex-direction:column;gap:12px}'
    + '.cart-ship{font-size:.85rem;font-weight:600}'
    + '.cart-ship strong{font-weight:800}'
    + '.cart-bar{height:10px;margin-top:8px;border:2px solid var(--color-ink,#1B1B1B);border-radius:999px;background:var(--color-white,#fff);overflow:hidden}'
    + '.cart-bar i{display:block;height:100%;background:var(--color-accent,#FF6A1A);border-radius:999px;transition:width .3s ease-out}'
    + '.cart-total{display:flex;align-items:baseline;justify-content:space-between;font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:1.35rem}'
    + '.cart-total small{font-weight:800;font-size:1.05rem}'
    + '.cart-shipnote{margin:-4px 0 0;font-size:.8rem;opacity:.75}'
    + '.cart-checkout{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:54px;padding:14px 28px;border:2px solid var(--color-ink,#1B1B1B);border-radius:999px;background:var(--color-ink,#1B1B1B);color:var(--color-cream,#FFF4E6);font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:1rem;text-decoration:none;cursor:pointer;transition:background .16s ease-out,color .16s ease-out,transform .16s ease-out}'
    + '.cart-checkout:hover{background:var(--color-accent,#FF6A1A);color:var(--color-ink,#1B1B1B);border-color:var(--color-ink,#1B1B1B)}'
    + '.cart-checkout:active{transform:scale(.97)}'
    + '.cart-continue{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 28px;border:2px solid var(--color-ink,#1B1B1B);border-radius:999px;background:transparent;color:var(--color-ink,#1B1B1B);font-family:var(--font-head,Montserrat,sans-serif);font-weight:800;font-size:.95rem;text-decoration:none;cursor:pointer;transition:background .16s ease-out,color .16s ease-out,transform .16s ease-out}'
    + '.cart-continue:hover{background:var(--color-ink,#1B1B1B);color:var(--color-cream,#FFF4E6)}'
    + '.cart-continue:active{transform:scale(.97)}'
    + '@media(prefers-reduced-motion:reduce){.cart-scrim,.cart-panel,.cart-bar i{transition:none}}';

  var ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '\u0026': '\u0026amp;', '<': '\u0026lt;', '>': '\u0026gt;', '"': '\u0026quot;', "'": '\u0026#39;' }[c]; }); }
  function money(n) { return String(Math.round(Number(n) * 100) / 100); }

  var root = null, lastFocus = null;

  function cartOnLeft() {
    var link = document.querySelector('a[href*="cart.html"] .count, [data-cart-open], a[href*="cart.html"]');
    if (!link) return false;
    var el = link.closest('a') || link;
    var r = el.getBoundingClientRect();
    return r.left + r.width / 2 < window.innerWidth / 2;
  }

  function build() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div');
    root.className = 'cartroot'; root.hidden = true;
    root.innerHTML =
      '<div class="cart-scrim" data-cart-close></div>'
      + '<aside class="cart-panel' + (cartOnLeft() ? ' cart-panel--left' : '') + '" role="dialog" aria-modal="true" aria-label="РљРѕС€РёРє">'
      + '<div class="cart-head"><h2>РљРѕС€РёРє <small data-cart-n-label>В· 0 С‚РѕРІР°СЂС–РІ</small></h2>'
      + '<button class="cart-close" type="button" data-cart-close aria-label="Р—Р°РєСЂРёС‚Рё РєРѕС€РёРє">' + ICON_CLOSE + '</button></div>'
      + '<div class="cart-body" data-cart-body></div>'
      + '<div class="cart-foot" data-cart-foot></div>'
      + '</aside>';
    document.body.appendChild(root);
    root.addEventListener('click', function (e) { if (e.target.closest('[data-cart-close]')) close(); });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cart-act]'); if (!b) return;
      var id = b.getAttribute('data-id');
      var act = b.getAttribute('data-cart-act');
      if (act === 'inc') setQty(id, (itemQty(id)) + 1);
      if (act === 'dec') { var q = itemQty(id); q <= 1 ? remove(id) : setQty(id, q - 1); }
      if (act === 'del') remove(id);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !root.hidden) close(); });
  }
  function itemQty(id) {
    var it = read().filter(function (i) { return String(i.id) === String(id); })[0];
    return it ? it.qty : 1;
  }
  function itemStock(id) {
    var it = read().filter(function (i) { return String(i.id) === String(id); })[0];
    return it ? stockFor(it) : null;
  }
  function plural(n) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'С‚РѕРІР°СЂ';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'С‚РѕРІР°СЂРё';
    return 'С‚РѕРІР°СЂС–РІ';
  }

  var stocksRendered = false;
  /* РџС–СЃР»СЏ Р·Р°РІР°РЅС‚Р°Р¶РµРЅРЅСЏ Р·Р°Р»РёС€РєС–РІ РѕР±СЂС–Р·Р°С”РјРѕ РєС–Р»СЊРєС–СЃС‚СЊ Сѓ РєРѕС€РёРєСѓ РґРѕ РЅР°СЏРІРЅРѕС— */
  var stocksClamped = false;
  function clampAll() {
    var list = read(), changed = false;
    list = list.map(function (i) {
      var st = stockFor(i);
      if (st !== null && st !== undefined && i.qty > st) { changed = true; return Object.assign({}, i, { qty: Math.max(0, st) }); }
      return i;
    });
    if (changed) write(list.filter(function (i) { return i.qty > 0; }));
  }
  fetchStocks().then(function () { if (!stocksClamped) { stocksClamped = true; clampAll(); } });
  function render() {
    if (!root) return;
    var list = read(), n = count(), sum = total();
    if (!stocksRendered) {
      fetchStocks().then(function () { stocksRendered = true; if (root && !root.hidden) render(); });
    }
    root.querySelector('[data-cart-n-label]').textContent = 'В· ' + n + ' ' + plural(n);
    var body = root.querySelector('[data-cart-body]'), foot = root.querySelector('[data-cart-foot]');
    if (!list.length) {
      body.innerHTML = '<div class="cart-empty"><div class="cart-empty__emoji">рџЊ¶пёЏ</div><h3>РљРѕС€РёРє РїРѕСЂРѕР¶РЅС–Р№</h3><p>Р”РѕРґР°Р№С‚Рµ С‰РѕСЃСЊ РіРѕСЃС‚СЂРµРЅСЊРєРµ Р· РєР°С‚Р°Р»РѕРіСѓ вЂ” РґРѕСЃС‚Р°РІРёРјРѕ С€РІРёРґРєРѕ!</p></div>';
      foot.innerHTML = '<a class="cart-checkout" href="test1.html">РџРѕРІРµСЂРЅСѓС‚РёСЃСЊ РЅР° РіРѕР»РѕРІРЅСѓ</a>';
      return;
    }
    body.innerHTML = list.map(function (i) {
      var ph = i.image ? '<img src="' + esc(i.image) + '" alt="">' : '<img src="image/image-svgrepo-com.svg" alt="">';
      var st = itemStock(i.id);
      return '<div class="cart-item">'
        + '<div class="cart-item__ph">' + ph + '</div>'
        + '<p class="cart-item__name">' + esc(i.name) + '</p>'
        + '<button class="cart-item__del" type="button" data-cart-act="del" data-id="' + esc(i.id) + '" aria-label="Р’РёРґР°Р»РёС‚Рё ' + esc(i.name) + '">' + ICON_TRASH + '</button>'
        + '<p class="cart-item__price">' + money(piecePrice(i, i.qty)) + ' РіСЂРЅ / С€С‚'
        + (Number(i.packCount) > 1 ? ' В· С„Р°СЃСѓРІР°РЅРЅСЏ ' + i.packCount + ' С€С‚ (' + money(i.packPrice) + ' РіСЂРЅ)' : '')
        + '</p>'
        + '<div class="cart-item__ctrl">'
        + '<div class="cart-qty"><button type="button" data-cart-act="dec" data-id="' + esc(i.id) + '" aria-label="РњРµРЅС€Рµ">в€’</button>'
        + '<output>' + i.qty + (st !== null && st !== undefined ? ' / ' + st + ' С€С‚' : '') + '</output>'
        + '<button type="button" data-cart-act="inc" data-id="' + esc(i.id) + '" aria-label="Р‘С–Р»СЊС€Рµ"' + (st !== null && st !== undefined && i.qty >= st ? ' disabled style="opacity:.35;cursor:default"' : '') + '>+</button></div>'
        + '<span class="cart-item__sum">' + money(itemSum(i, i.qty)) + ' <small>РіСЂРЅ</small></span>'
        + '</div></div>';
    }).join('');
    var left = Math.max(0, FREE_SHIPPING_THRESHOLD - sum);
    var pct = Math.min(100, Math.round(sum / FREE_SHIPPING_THRESHOLD * 100));
    foot.innerHTML =
      '<div><p class="cart-ship">' + (left > 0
        ? 'Р”Рѕ Р±РµР·РєРѕС€С‚РѕРІРЅРѕС— РґРѕСЃС‚Р°РІРєРё С‰Рµ <strong>' + money(left) + ' РіСЂРЅ</strong>'
        : '<strong>Р‘РµР·РєРѕС€С‚РѕРІРЅР° РґРѕСЃС‚Р°РІРєР° вЂ” Сѓ РІР°СЃ С”!</strong>') + '</p>'
      + '<div class="cart-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div></div>'
      + '<div class="cart-total"><span>Р Р°Р·РѕРј</span><span>' + money(sum) + ' <small>РіСЂРЅ</small></span></div>'
      + '<p class="cart-shipnote">Р’Р°СЂС‚С–СЃС‚СЊ РґРѕСЃС‚Р°РІРєРё СЂРѕР·СЂР°С…СѓС”РјРѕ РЅР° РЅР°СЃС‚СѓРїРЅРѕРјСѓ РєСЂРѕС†С–.</p>'
      + '<a class="cart-checkout" href="checkout.html">РћС„РѕСЂРјРёС‚Рё Р·Р°РјРѕРІР»РµРЅРЅСЏ</a>'
      + '<a class="cart-continue" href="test1.html">РџСЂРѕРґРѕРІР¶РёС‚Рё РїРѕРєСѓРїРєРё</a>';
  }

  function open() {
    if (!root) build();
    lastFocus = document.activeElement;
    render();
    root.hidden = false;
    requestAnimationFrame(function () { root.classList.add('is-open'); });
    document.body.style.overflow = 'hidden';
    var c = root.querySelector('.cart-close'); if (c) c.focus();
  }
  function close() {
    if (!root || root.hidden) return;
    root.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(function () { root.hidden = true; }, 260);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- Р†РЅС–С†С–Р°Р»С–Р·Р°С†С–СЏ РЅР° СЃС‚РѕСЂС–РЅС†С– ---------- */
  function init() {
    build();
    syncCount();
    fetchStocks();
    /* РљР»С–Рє РїРѕ С–РєРѕРЅС†С– РєРѕС€РёРєР° РІ С…РµРґРµСЂС– в†’ РїРѕРІРЅРѕРµРєСЂР°РЅРЅРёР№ РїРѕС‚С–Рє РѕС„РѕСЂРјР»РµРЅРЅСЏ */
    /* Р—Р°РїР°Рј'СЏС‚РѕРІСѓС”РјРѕ СЃС‚РѕСЂС–РЅРєСѓ, Р· СЏРєРѕС— РєРѕСЂРёСЃС‚СѓРІР°С‡ РІС–РґРєСЂРёРІ РєРѕС€РёРє,
       С‰РѕР± РєРЅРѕРїРєР° В«РќР°Р·Р°РґВ» Сѓ РєРѕС€РёРєСѓ РїРѕРІРµСЂС‚Р°Р»Р° СЃР°РјРµ СЃСЋРґРё (РЅР°РїСЂ., РЅР° С‚РѕРІР°СЂ). */
    function saveReturnUrl() {
      try {
        var p = location.pathname.split('/').pop().toLowerCase();
        if (p !== 'checkout.html' && p !== 'cart.html') {
          sessionStorage.setItem('latiao_return_url', location.href);
        }
      } catch (e) {}
    }
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href="cart.html"],a[href="./cart.html"],a[href$="/cart.html"]');
      if (a) {
        e.preventDefault();
        saveReturnUrl();
        location.href = 'checkout.html';
      }
    });
    /* РўР°РєРѕР¶ С„С–РєСЃСѓС”РјРѕ СЃС‚РѕСЂС–РЅРєСѓ РїСЂРё РІС–РґРєСЂРёС‚С‚С– РїР°РЅРµР»С– РєРѕС€РёРєР° */
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-cart-open]')) saveReturnUrl();
    }, true);
    /* РљРЅРѕРїРєРё В«Р’ РєРѕС€РёРєВ» вЂ” РґРѕРґР°С”РјРѕ СЂРµР°Р»СЊРЅРёР№ С‚РѕРІР°СЂ */
    var ICON_CHECK = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 12.5l5 5L20 6.5"/></svg>';
    function markAdded(b) {
      if (!b || b.dataset.addBusy) return;
      b.dataset.addBusy = '1';
      var orig = b.innerHTML;
      b.classList.add('is-added');
      b.innerHTML = ICON_CHECK + '<span class="t">Р”РѕРґР°РЅРѕ РІ РєРѕС€РёРє</span>';
      setTimeout(function () {
        b.innerHTML = orig;
        b.classList.remove('is-added');
        delete b.dataset.addBusy;
      }, 2000);
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]'); if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.stockCheck) return;
      /* РџРµСЂРµРІС–СЂРєР° РЅР°СЏРІРЅРѕСЃС‚С– РїРѕ data-stock Р±Р°С‚СЊРєС–РІСЃСЊРєРѕС— РєР°СЂС‚РєРё */
      var card = b.closest('.pcard');
      if (card && card.getAttribute('data-stock') === '0') {
        notify('РўРѕРІР°СЂСѓ РЅРµРјР°С” РІ РЅР°СЏРІРЅРѕСЃС‚С–');
        return;
      }
      var p = resolveProduct(b);
      if (p) {
        b.dataset.stockCheck = '1'; b.disabled = true;
        fetchStocks(true).then(function () {
          if (stockLoadFailed) { notify('Не вдалося перевірити залишок. Спробуйте ще раз'); return; }
          if (stockFor(p) === null || stockFor(p) === undefined) { notify('Не вдалося знайти товар у складі. Додавання недоступне'); return; }
          if (add(p)) markAdded(b);
        }).catch(function () { notify('Не вдалося перевірити залишок. Спробуйте ще раз'); })
          .finally(function () { b.disabled = false; delete b.dataset.stockCheck; });
      }
    }, true);
    onChange(render);
  }

  function resolveProduct(btn) {
    var card = btn.closest('.pcard');
    if (card) {
      var nameEl = card.querySelector('.pcard__title');
      var img = card.querySelector('.ph img');
      return {
        id: card.getAttribute('data-id') || (nameEl && nameEl.textContent.trim()) || 'item',
        name: nameEl ? nameEl.textContent.trim() : 'РўРѕРІР°СЂ',
        price: Number(card.getAttribute('data-price') || 0),
        qty: 1,
        image: img ? img.getAttribute('src') : '',
        sku: card.getAttribute('data-sku') || ''
      };
    }
    /* РЎС‚РѕСЂС–РЅРєР° С‚РѕРІР°СЂСѓ */
    var id = new URLSearchParams(location.search).get('id') || 'product';
    var h1 = document.querySelector('main h1, h1');
    var qtyOut = document.querySelector('[data-qty] output');
    var img2 = document.querySelector('.gal__main .ph img');
    var artEl = document.getElementById('partic-v');
    /* Р’РёР±СЂР°РЅР° С„Р°СЃСѓРІР°РЅРЅСЏ: СЂР°С…СѓС”РјРѕ РІСЃРµ Сѓ С€С‚СѓРєР°С…. РЇРєС‰Рѕ РѕР±СЂР°РЅРѕ В«2 С€С‚ / 145 РіСЂРЅВ»
       вЂ” Сѓ РєРѕС€РёРє РґРѕРґР°С”С‚СЊСЃСЏ 2 С€С‚СѓРєРё; РїРѕРІРЅС– С„Р°СЃСѓРІР°РЅРЅСЏ СЂР°С…СѓСЋС‚СЊСЃСЏ РїРѕ 145 РіСЂРЅ,
       РјРµРЅС€Рµ Р·Р° С„Р°СЃСѓРІР°РЅРЅСЏ вЂ” РїРѕ СЃС‚Р°РЅРґР°СЂС‚РЅС–Р№ С†С–РЅС– Р·Р° 1 С€С‚. */
    var unit = null, packCount = 1, packPrice = 0, basePrice = 0;
    var chip = document.querySelector('#vars .chip[aria-checked="true"]');
    var baseChip = document.querySelector('#vars .chip[data-count="1"]') || chip;
    if (baseChip) basePrice = Number(baseChip.getAttribute('data-price') || 0);
    if (chip) {
      packCount = Math.max(1, Number(chip.getAttribute('data-count') || 1));
      packPrice = Number(chip.getAttribute('data-price') || 0);
      unit = chip.getAttribute('data-w') || (chip.querySelector('.chip-qty') ? chip.querySelector('.chip-qty').textContent.trim() : '') || null;
    }
    var price = packPrice > 0 ? packPrice : 0;
    if (!price) {
      var priceEl = document.getElementById('pprice');
      price = priceEl ? (parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || 0) : 0;
    }
    var h1txt = h1 ? h1.textContent.trim() : 'РўРѕРІР°СЂ';
    return { id: id, name: h1txt, price: price, qty: qtyOut ? Math.max(1, +qtyOut.textContent || 1) : 1, image: img2 ? img2.getAttribute('src') : '', sku: artEl ? artEl.textContent.trim() : '', unit: unit || '', packCount: packCount, packPrice: packPrice, basePrice: basePrice };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LatiaoCart = { add: add, remove: remove, setQty: setQty, clear: clear, items: items, count: count, total: total, open: open, close: close, onChange: onChange, stockFor: stockFor, fetchStocks: fetchStocks };
})();
