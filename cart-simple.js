/* cart-simple.js — спрощене замовлення для сторінки cart-simple.html.
   Список товарів із кошика (window.LatiaoCart, cart.js — логіку не змінюємо),
   без вибору доставки та оплати: лише ім’я, телефон і Telegram нікнейм.
   Замовлення зберігається у localStorage 'latiao_orders' (сумісний формат
   з checkout.js) зі статусом «Новий (спрощене)». */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '\u0026': '\u0026amp;', '\u003C': '\u0026lt;', '\u003E': '\u0026gt;', '"': '\u0026quot;', "'": '\u0026#39;' }[c];
    });
  }
  function money(n) { return String(Math.round(Number(n) * 100) / 100); }
  function formatMoney(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    return Math.round(v).toLocaleString('uk-UA').replace(/[ \u00a0\u202f]/g, '\u00a0');
  }
  function haptic(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) { } }

  var cart = window.LatiaoCart;
  var busy = false;
  var ordered = false;

  var itemsEl = $('#items');
  var totalEl = $('#total');
  var emptyEl = $('#empty');
  var cartBlock = $('#cart-block');
  var formError = $('#form-error');
  var submitBtn = $('#submit-btn');

  /* ---------- Рендер списку товарів ---------- */
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

  function render() {
    var list = cart ? cart.items() : [];
    var isEmpty = !list.length;
    emptyEl.classList.toggle('is-on', isEmpty);
    cartBlock.hidden = isEmpty;
    if (isEmpty) {
      if (ordered) {
        $('#order-view').style.display = 'none';
        $('#done-view').classList.add('is-on');
      }
      return;
    }
    itemsEl.innerHTML = list.map(function (i) {
      var ph = i.image
        ? '<img src="' + esc(i.image) + '" alt="">'
        : '🌶️';
      return ''
        + '<div class="item" data-id="' + esc(i.id) + '">'
        + '  <div class="item__ph">' + ph + '</div>'
        + '  <h3 class="item__name">' + esc(i.name) + '</h3>'
        + '  <p class="item__price">' + formatMoney(piecePrice(i, i.qty)) + ' грн / шт</p>'
        + '  <button class="item__del" type="button" data-del="' + esc(i.id) + '" aria-label="Видалити ' + esc(i.name) + '">'
        + '    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
        + '  </button>'
        + '  <div class="item__ctrl">'
        + '    <span class="qty">'
        + '      <button type="button" data-minus="' + esc(i.id) + '" aria-label="Менше">−</button>'
        + '      <output>' + i.qty + '</output>'
        + '      <button type="button" data-plus="' + esc(i.id) + '" aria-label="Більше">+</button>'
        + '    </span>'
        + '    <span class="item__sum">' + formatMoney(itemSum(i, i.qty)) + ' <small>грн</small></span>'
        + '  </div>'
        + '</div>';
    }).join('');
    totalEl.innerHTML = formatMoney(cart.total()) + ' <small>грн</small>';
  }

  /* ---------- Дії зі списком ---------- */
  itemsEl.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del) { haptic(10); cart.remove(b.dataset.del); return; }
    var it = null;
    var id = b.dataset.plus || b.dataset.minus;
    if (!id) return;
    var list = cart.items();
    for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(id)) { it = list[k]; break; } }
    if (!it) return;
    haptic(10);
    cart.setQty(id, it.qty + (b.dataset.plus ? 1 : -1));
  });

  if (cart && cart.onChange) cart.onChange(function () { render(); });

  /* ---------- Валідація форми ---------- */
  function showFormError(msg) {
    formError.textContent = msg;
    formError.classList.add('is-on');
    haptic(30);
  }
  function hideFormError() {
    formError.textContent = '';
    formError.classList.remove('is-on');
  }
  function markErr(input, bad) { input.classList.toggle('is-err', !!bad); }

  function validPhone(v) {
    var d = String(v).replace(/\D/g, '');
    return d.length >= 10 && d.length <= 15;
  }
  function validTelegram(v) {
    var t = String(v).trim().replace(/^@/, '');
    return /^[A-Za-z0-9_]{4,32}$/.test(t);
  }

  function collectForm() {
    var name = $('#f-name'), phone = $('#f-phone'), tg = $('#f-tg');
    var ok = true;
    var nameV = name.value.trim();
    var phoneV = phone.value.trim();
    var tgV = tg.value.trim().replace(/^@/, '');

    markErr(name, !nameV);
    markErr(phone, !validPhone(phoneV));
    markErr(tg, !validTelegram(tgV));
    if (!nameV) ok = false;
    if (!validPhone(phoneV)) ok = false;
    if (!validTelegram(tgV)) ok = false;

    if (!ok) {
      showFormError('Заповніть усі поля: ім’я, коректний номер телефону та Telegram нікнейм (напр., @nickname).');
      return null;
    }
    hideFormError();
    return { name: nameV, phone: phoneV, telegram: '@' + tgV };
  }

  ['f-name', 'f-phone', 'f-tg'].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener('input', function () { markErr(el, false); hideFormError(); });
  });

  /* ---------- Відправлення замовлення ---------- */
  async function submit() {
    if (busy) return;
    var list = cart ? cart.items() : [];
    if (!list.length) { render(); return; }

    var contact = collectForm();
    if (!contact) return;

    busy = true;
    var submitLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Відправляємо…';
    haptic(15);

    try {
      if (!cart || !cart.fetchStocks || !cart.stockFor) throw new Error('Не вдалося перевірити залишки товарів. Спробуйте ще раз.');
      await cart.fetchStocks(true);
      var unavailable = list.filter(function (item) {
        var stock = cart.stockFor(item);
        return stock === null || stock === undefined || stock <= 0 || Number(item.qty) > stock;
      });
      if (unavailable.length) throw new Error('Недостатньо залишку: ' + unavailable.map(function (item) { return item.name; }).join(', '));
    } catch (stockError) {
      busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
      showFormError(stockError.message);
      return;
    }

    var order = {
      id: 'Г-' + Date.now().toString(36).toUpperCase(),
      date: new Date().toISOString(),
      name: contact.name,
      phone: contact.phone,
      telegram: contact.telegram,
      carrier: '',
      city: '',
      branch: '',
      note: 'Спрощене замовлення: доставка та оплата узгоджуються в Telegram (' + contact.telegram + ')',
      payment: 'telegram',
      paymentAmount: cart.total(),
      status: 'Новий (спрощене)',
      payId: '',
      items: list,
      total: cart.total(),
      promo: '',
      discount: 0
    };

    try {
      var orders = JSON.parse(localStorage.getItem('latiao_orders') || '[]');
      orders.push(order);
      localStorage.setItem('latiao_orders', JSON.stringify(orders));
    } catch (err) { }

    /* Єдине джерело замовлень — Firestore latiao-snack (колекція orders).
       Локальний запис лишається лише як резервна копія. */
    try {
      if (window.LatiaoOrders) await window.LatiaoOrders.save(order);
      else await import('./js/firebase-init.js').then(function (m) { return m.saveOrder(order); });
    } catch (saveError) {
      console.warn('Не вдалося записати замовлення в Firestore', saveError);
      busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
      showFormError(saveError.message || 'Не вдалося зберегти замовлення. Спробуйте ще раз.');
      return;
    }

    ordered = true;
    cart.clear();
    try { sessionStorage.removeItem('latiao_checkout'); } catch (e) { }

    $('#order-view').style.display = 'none';
    $('#done-num').textContent = '№ ' + order.id;
    $('#done-tg').textContent = order.telegram;
    $('#done-view').classList.add('is-on');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    haptic([30, 60, 30]);
    busy = false;
  }

  submitBtn.addEventListener('click', submit);

  /* ---------- Старт ---------- */
  render();
})();
