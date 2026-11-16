/* cart.js — спільний кошик для всіх сторінок «Гостро».
   Зберігання: localStorage 'latiao_cart' → [{id,name,price,qty,image,sku}]
   API: window.LatiaoCart = {add, remove, setQty, items, count, total, open, close, onChange}
   Залишки: кількість товару в кошику обмежена залишками (stock) з Firestore,
   звіряння по артикулу (article/sku). */
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
  function total() { return read().reduce(function (s, i) { return s + i.qty * Number(i.price || 0); }, 0); }

  /* ---------- Залишки (звіряння по артикулу) ---------- */
  var PROJECT_ID = 'my-magazin-81c96';
  var stockMap = null;          // нормалізований артикул → {stock, id}
  var stockById = null;         // doc id → stock
  var stockPromise = null;

  function normSku(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, ''); }

  function fetchStocks() {
    if (stockPromise) return stockPromise;
    stockPromise = fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/products?pageSize=500')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        stockMap = {}; stockById = {};
        (data.documents || []).forEach(function (d) {
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
          var stock = num('stock');
          if (f.stock === undefined && f.quantity !== undefined) stock = num('quantity');
          var id = d.name.split('/').pop();
          var sku = str('article') || str('articul') || str('sku') || str('vendorCode') || str('productCode') || str('code');
          stockById[id] = stock;
          if (sku) stockMap[normSku(sku)] = { stock: stock, id: id };
        });
        return stockMap;
      })
      .catch(function (e) { console.warn('cart.js: не вдалося завантажити залишки', e); stockMap = {}; stockById = {}; return stockMap; });
    return stockPromise;
  }

  function stockFor(p) {
    /* Спочатку по артикулу, потім по id як fallback */
    if (p.sku && stockMap && stockMap[normSku(p.sku)] !== undefined) return stockMap[normSku(p.sku)].stock;
    if (stockById && stockById[String(p.id)] !== undefined) return stockById[String(p.id)];
    return null; /* невідомо — не обмежуємо */
  }

  var lastAdd = { id: null, t: 0 };
  function add(p) {
    /* Захист від подвійного додавання в межах одного кліку: якщо на кнопці «В кошик»
       вішається кілька обробників (напр., onclick на картці + глобальний слухач cart.js),
       другий виклик add() з тим самим id протягом 50 мс ігнорується.
       Людина фізично не може клікнути двічі за 50 мс, тому звичайні повторні
       кліки (додати ще 1 шт) працюють як і раніше. */
    var now = Date.now();
    if (p && String(p.id) === String(lastAdd.id) && now - lastAdd.t < 50) return;
    lastAdd = { id: p ? String(p.id) : null, t: now };
    var list = read();
    var found = null;
    for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(p.id)) { found = list[k]; break; } }
    var q = Math.max(1, Number(p.qty || 1));
    var stock = stockFor(p);
    if (stock !== null && stock <= 0) { notify('Товару немає в наявності'); return; }
    if (found) {
      var max = stock !== null ? stock : 99;
      if (found.qty + q > max) {
        found.qty = max;
        notify('В наявності лише ' + max + ' шт — більше додати не можна');
      } else {
        found.qty = found.qty + q;
      }
    } else {
      var q2 = stock !== null ? Math.min(q, stock) : q;
      if (q2 < q) notify('В наявності лише ' + stock + ' шт — додано ' + q2 + ' шт');
      list.push({ id: p.id, name: p.name || 'Товар', price: Number(p.price || 0), qty: q2, image: p.image || '', sku: p.sku || '' });
    }
    write(list);
  }
  function setQty(id, qty) {
    var list = read();
    var it = null;
    for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(id)) { it = list[k]; break; } }
    if (!it) return;
    var stock = stockFor(it);
    var max = stock !== null ? stock : 99;
    var v = Math.max(1, Math.min(max, Number(qty) || 1));
    if (Number(qty) > max) notify('В наявності лише ' + max + ' шт');
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

  /* ---------- Лічильник у хедері ---------- */
  function syncCount() {
    var n = count();
    document.querySelectorAll('[data-count]').forEach(function (c) {
      c.textContent = String(n);
      c.hidden = n === 0;
      c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
    });
  }

  /* ---------- Розмітка та стилі шухляди ---------- */
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
    + '.cart-item__ph{grid-row:1/3;width:56px;height:56px;border-radius:14px;background:var(--color-accent,#FF6A1A);display:flex;align-items:center;justify-content:center;font-size:1.4rem;overflow:hidden}'
    + '.cart-item__ph img{width:100%;height:100%;object-fit:cover}'
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
      + '<aside class="cart-panel' + (cartOnLeft() ? ' cart-panel--left' : '') + '" role="dialog" aria-modal="true" aria-label="Кошик">'
      + '<div class="cart-head"><h2>Кошик <small data-cart-n-label>· 0 товарів</small></h2>'
      + '<button class="cart-close" type="button" data-cart-close aria-label="Закрити кошик">' + ICON_CLOSE + '</button></div>'
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
    if (m10 === 1 && m100 !== 11) return 'товар';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'товари';
    return 'товарів';
  }

  var stocksRendered = false;
  /* Після завантаження залишків обрізаємо кількість у кошику до наявної */
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
    root.querySelector('[data-cart-n-label]').textContent = '· ' + n + ' ' + plural(n);
    var body = root.querySelector('[data-cart-body]'), foot = root.querySelector('[data-cart-foot]');
    if (!list.length) {
      body.innerHTML = '<div class="cart-empty"><div class="cart-empty__emoji">🌶️</div><h3>Кошик порожній</h3><p>Додайте щось гостреньке з каталогу — доставимо швидко!</p></div>';
      foot.innerHTML = '<a class="cart-checkout" href="catalog.html">Перейти до каталогу</a>';
      return;
    }
    body.innerHTML = list.map(function (i) {
      var ph = i.image ? '<img src="' + esc(i.image) + '" alt="">' : '<img src="image/image-svgrepo-com.svg" alt="">';
      var st = itemStock(i.id);
      return '<div class="cart-item">'
        + '<div class="cart-item__ph">' + ph + '</div>'
        + '<p class="cart-item__name">' + esc(i.name) + '</p>'
        + '<button class="cart-item__del" type="button" data-cart-act="del" data-id="' + esc(i.id) + '" aria-label="Видалити ' + esc(i.name) + '">' + ICON_TRASH + '</button>'
        + '<p class="cart-item__price">' + money(i.price) + ' грн / шт</p>'
        + '<div class="cart-item__ctrl">'
        + '<div class="cart-qty"><button type="button" data-cart-act="dec" data-id="' + esc(i.id) + '" aria-label="Менше">−</button>'
        + '<output>' + i.qty + (st !== null && st !== undefined ? ' / ' + st + ' шт' : '') + '</output>'
        + '<button type="button" data-cart-act="inc" data-id="' + esc(i.id) + '" aria-label="Більше"' + (st !== null && st !== undefined && i.qty >= st ? ' disabled style="opacity:.35;cursor:default"' : '') + '>+</button></div>'
        + '<span class="cart-item__sum">' + money(i.qty * i.price) + ' <small>грн</small></span>'
        + '</div></div>';
    }).join('');
    var left = Math.max(0, FREE_SHIPPING_THRESHOLD - sum);
    var pct = Math.min(100, Math.round(sum / FREE_SHIPPING_THRESHOLD * 100));
    foot.innerHTML =
      '<div><p class="cart-ship">' + (left > 0
        ? 'До безкоштовної доставки ще <strong>' + money(left) + ' грн</strong>'
        : '<strong>Безкоштовна доставка — у вас є!</strong>') + '</p>'
      + '<div class="cart-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div></div>'
      + '<div class="cart-total"><span>Разом</span><span>' + money(sum) + ' <small>грн</small></span></div>'
      + '<p class="cart-shipnote">Вартість доставки розрахуємо на наступному кроці.</p>'
      + '<a class="cart-checkout" href="checkout.html">Оформити замовлення</a>'
      + '<button class="cart-continue" type="button" data-cart-close>Продовжити покупки</button>';
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

  /* ---------- Ініціалізація на сторінці ---------- */
  function init() {
    build();
    syncCount();
    fetchStocks();
    /* Клік по іконці кошика в хедері → повноекранний потік оформлення */
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href="cart.html"],a[href="./cart.html"],a[href$="/cart.html"]');
      if (a) { e.preventDefault(); location.href = 'checkout.html'; }
    });
    /* Кнопки «В кошик» — додаємо реальний товар */
    var ICON_CHECK = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 12.5l5 5L20 6.5"/></svg>';
    function markAdded(b) {
      if (!b || b.dataset.addBusy) return;
      b.dataset.addBusy = '1';
      var orig = b.innerHTML;
      b.classList.add('is-added');
      b.innerHTML = ICON_CHECK + '<span class="t">Додано в кошик</span>';
      setTimeout(function () {
        b.innerHTML = orig;
        b.classList.remove('is-added');
        delete b.dataset.addBusy;
      }, 2000);
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]'); if (!b) return;
      /* Перевірка наявності по data-stock батьківської картки */
      var card = b.closest('.pcard');
      if (card && card.getAttribute('data-stock') === '0') {
        notify('Товару немає в наявності');
        return;
      }
      var p = resolveProduct(b);
      if (p) { add(p); markAdded(b); }
    });
    onChange(render);
  }

  function resolveProduct(btn) {
    var card = btn.closest('.pcard');
    if (card) {
      var nameEl = card.querySelector('.pcard__title');
      var img = card.querySelector('.ph img');
      return {
        id: card.getAttribute('data-id') || (nameEl && nameEl.textContent.trim()) || 'item',
        name: nameEl ? nameEl.textContent.trim() : 'Товар',
        price: Number(card.getAttribute('data-price') || 0),
        qty: 1,
        image: img ? img.getAttribute('src') : '',
        sku: card.getAttribute('data-sku') || ''
      };
    }
    /* Сторінка товару */
    var id = new URLSearchParams(location.search).get('id') || 'product';
    var h1 = document.querySelector('main h1, h1');
    var priceEl = document.getElementById('pprice');
    var price = priceEl ? (parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || 0) : 0;
    var qtyOut = document.querySelector('[data-qty] output');
    var img2 = document.querySelector('.gal__main .ph img');
    var artEl = document.getElementById('partic-v');
    return { id: id, name: h1 ? h1.textContent.trim() : 'Товар', price: price, qty: qtyOut ? Math.max(1, +qtyOut.textContent || 1) : 1, image: img2 ? img2.getAttribute('src') : '', sku: artEl ? artEl.textContent.trim() : '' };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LatiaoCart = { add: add, remove: remove, setQty: setQty, clear: clear, items: items, count: count, total: total, open: open, close: close, onChange: onChange, stockFor: stockFor, fetchStocks: fetchStocks };
})();
