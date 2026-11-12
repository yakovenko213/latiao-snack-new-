/* checkout.js — потік «Кошик → Доставка → Тип оплати → Підтвердження».
   Стан (ViewModel) у sessionStorage 'latiao_checkout':
   { step, delivery:{carrier, np:{city,branch}, up:{city,region,district,index}},
      contact:{name,phone,note}, payment:{method} }
   Замовлення — у localStorage 'latiao_orders' (сумісно з попереднім форматом).
   Кошик — window.LatiaoCart (cart.js), логіку cart.js не змінюємо. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '\u0026': '\u0026amp;', '\u003C': '\u0026lt;', '\u003E': '\u0026gt;', '"': '\u0026quot;', "'": '\u0026#39;' }[c]; }); }
  function money(n) { return String(Math.round(Number(n) * 100) / 100); }
  function haptic(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) { } }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function icon(id, cls) { return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

  var FREE_SHIP = window.FREE_SHIPPING_THRESHOLD;
  var MIN_ORDER = 100; /* мінімальна сума товарів для оформлення */
  var KEY = 'latiao_checkout';
  var ONLINE_PAYMENT_SHARE = 97;
  var PREPAY_AMOUNT = 100;
  var COMMISSION_PERCENT = 0.02;
  var COMMISSION_FIXED = 20;

  function calcCodCommission(orderTotal) {
    var total = Number(orderTotal);
    if (!isFinite(total) || total < 0) total = 0;
    var base = Math.max(0, total - PREPAY_AMOUNT);
    var commission = Math.ceil(base * COMMISSION_PERCENT + COMMISSION_FIXED);
    return { base: base, commission: commission, codTotal: base + commission };
  }
  window.calcCodCommission = calcCodCommission;
  function formatMoney(n) {
    var value = Number(n);
    if (!isFinite(value) || value < 0) value = 0;
    return Math.round(value).toLocaleString('uk-UA').replace(/[ \u00a0\u202f]/g, '\u00a0');
  }

  /* ---------- Конфігурація кроків ---------- */
  var STEPS = [
    { id: 'cart', name: 'Кошик', icon: 'i-cart', btn: 'Продовжити до доставки' },
    { id: 'delivery', name: 'Доставка', icon: 'i-truck', btn: 'Продовжити до оплати' },
    { id: 'paytype', name: 'Тип оплати', icon: 'i-wallet', btn: 'Продовжити' },
    { id: 'pay', name: 'Підсумок', icon: 'i-check', btn: 'Оплатити' }
  ];

  /* ---------- ViewModel ---------- */
  function defaults() {
    return {
      step: 0,
      delivery: { carrier: 'np', np: { city: '', branch: '' }, up: { city: '', region: '', district: '', index: '' } },
      contact: { name: '', phone: '', note: '' },
      payment: { method: 'online' }
    };
  }
  var vm = defaults();
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && typeof saved.step === 'number') {
      vm = Object.assign(defaults(), saved);
      /* Глибоке злиття вкладених об'єктів (сумісність зі старим форматом) */
      vm.delivery = Object.assign(defaults().delivery, saved.delivery || {});
      vm.delivery.np = Object.assign(defaults().delivery.np, (saved.delivery && saved.delivery.np) || {});
      vm.delivery.up = Object.assign(defaults().delivery.up, (saved.delivery && saved.delivery.up) || {});
      vm.contact = Object.assign(defaults().contact, saved.contact || {});
      vm.payment = Object.assign(defaults().payment, saved.payment || {});
    }
  } catch (e) { }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(vm)); } catch (e) { } }

  /* ---------- Елементи ---------- */
  var stage = $('#stage'), slide = $('#slide');
  var views = Array.prototype.slice.call(document.querySelectorAll('.step-view'));
  var stepper = $('#stepper');
  var backBtn = $('#back-btn');
  var nextBtns = Array.prototype.slice.call(document.querySelectorAll('.js-next'));
  var done = [false, false, false, false];
  var cart = window.LatiaoCart;
  var ordered = false;

  /* ---------- Степпер ---------- */
  STEPS.forEach(function (s, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'stp';
    b.setAttribute('data-step', i);
    b.dataset.icon = s.icon.replace(/^i-/, '');
    b.innerHTML = '<span class="stp__circ"><svg class="stp__icon" aria-hidden="true" focusable="false"><use href="#' + s.icon + '"></use></svg></span><span class="stp__label">' + s.name + '</span><span class="stepper__sr"></span>';
    b.addEventListener('click', function () {
      if (b.disabled) return;
      haptic(10);
      go(i, i < vm.step ? -1 : 1);
    });
    stepper.appendChild(b);
  });
  var stepBtns = Array.prototype.slice.call(stepper.querySelectorAll('.stp'));

  /* ---------- Переходи між кроками (слайд + висота) ---------- */
  function setStageHeight() {
    var v = views[vm.step];
    stage.style.height = v.offsetHeight + 'px';
  }
  function showStep(next, dir) {
    var cur = vm.step;
    if (next === cur) { paint(); return; }
    vm.step = next; save();
    if (reducedMotion()) { paint(); return; }
    var from = stage.offsetHeight;
    stage.style.height = from + 'px';
    var outCls = dir > 0 ? 'is-out-left' : 'is-out-right';
    var inCls = dir > 0 ? 'is-in-right' : 'is-in-left';
    slide.classList.add(outCls);
    setTimeout(function () {
      paint();
      var to = views[next].offsetHeight;
      stage.style.height = to + 'px';
      slide.classList.remove(outCls);
      slide.classList.add(inCls);
      void slide.offsetWidth;
      requestAnimationFrame(function () { slide.classList.remove(inCls); });
      /* The stage may be animated between steps, but must not retain a stale
         inline height after the new view has finished measuring. */
      setTimeout(function () { stage.style.height = 'auto'; }, 320);
    }, 300);
  }
  function go(next, dir) {
    showStep(next, dir);
    history.pushState({ step: next }, '', location.href.split('#')[0] + '#step-' + (next + 1));
  }
  function renderStepper(currentIndex) {
    currentIndex = Math.max(0, Math.min(STEPS.length - 1, Number(currentIndex) || 0));
    vm.step = currentIndex;
    stepper.style.setProperty('--progress', String(currentIndex / (STEPS.length - 1)));
    stepBtns.forEach(function (b, i) {
      var state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
      b.dataset.state = state;
      b.querySelector('.stp__icon use').setAttribute('href', '#' + (state === 'done' ? 'i-check' : 'i-' + b.dataset.icon));
      b.disabled = state === 'upcoming';
      if (state === 'current') b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.querySelector('.stepper__sr').textContent = state === 'done' ? ' (завершено)' : state === 'current' ? ' (поточний крок)' : '';
    });
  }
  function paint() {
    views.forEach(function (v, i) { v.hidden = i !== vm.step; });
    renderStepper(vm.step);
    if (vm.step === 3) renderConfirmation();
    /* Текст кнопки за кроком */
    var label = STEPS[vm.step].btn;
    if (vm.step === 3) label = 'Оплатити ' + formatMoney(payableAmount()) + ' грн';
    nextBtns.forEach(function (b) { b.textContent = label; b.disabled = vm.step === 3 && !$('#confirm-terms').checked; });
    /* Фокус на заголовок нового кроку */
    var h = views[vm.step].querySelector('h2');
    if (h && document.activeElement !== h) h.focus({ preventScroll: true });
    setStageHeight();
  }
  function cartTotal() { return cart ? cart.total() : 0; }
  function hasMinimumOrder() { return cartTotal() >= MIN_ORDER; }
  function showMinimumOrderError() {
    var error = $('#cart-error');
    if (!error) return;
    $('#cart-error-text').textContent = 'Мінімальна сума замовлення — ' + money(MIN_ORDER) + ' грн. Додайте товарів ще на ' + money(MIN_ORDER - cartTotal()) + ' грн, щоб продовжити.';
    error.classList.add('is-on');
    haptic(30);
  }

  /* ---------- Кнопка «назад» + системний жест назад ---------- */
  backBtn.addEventListener('click', function () {
    haptic(10);
    if (vm.step === 0) { location.href = 'catalog.html'; return; }
    go(vm.step - 1, -1);
  });
  window.addEventListener('popstate', function (e) {
    if (ordered) return;
    var st = e.state && typeof e.state.step === 'number' ? e.state.step : 0;
    if (st !== vm.step) showStep(st, st < vm.step ? -1 : 1);
  });
  var hashStep = /^#step-(\d+)$/.exec(location.hash);
  if (hashStep) vm.step = Math.max(0, Math.min(STEPS.length - 1, Number(hashStep[1]) - 1));
  history.replaceState({ step: vm.step }, '', location.href.split('#')[0] + '#step-' + (vm.step + 1));

  /* ---------- Валідація ---------- */
  function setErr(input, errId, bad) {
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    input.setAttribute('aria-describedby', errId);
    $('#' + errId).classList.toggle('is-on', bad);
    return !bad;
  }
  function validPhone(v) { return /^\+380 \d{2} \d{3} \d{2} \d{2}$/.test(v); }

  /* Пошук постійного клієнта за телефоном у збережених замовленнях. */
  var customerModal = $('#customer-modal');
  var foundCustomer = null;
  var customerLookupPhone = '';
  function phoneDigits(value) { return String(value || '').replace(/\D/g, '').replace(/^380/, ''); }
  function findCustomer(phone) {
    var wanted = phoneDigits(phone);
    if (wanted.length !== 9) return Promise.resolve(null);
    /* Firebase-модуль завантажується асинхронно. Спочатку перевіряємо
       локально збережені замовлення, щоб автопідстановка працювала навіть
       до завершення авторизації або за тимчасово закритих правилах Firestore. */
    var local = null;
    try {
      var orders = JSON.parse(localStorage.getItem('latiao_orders') || '[]');
      local = orders.filter(function (order) {
        return order && order.name && phoneDigits(order.phone) === wanted;
      }).sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })[0] || null;
    } catch (e) { }
    if (local) return Promise.resolve(local);
    /* Не пропускаємо пошук, якщо module-скрипт ще не встиг створити API. */
    return new Promise(function (resolve) {
      var started = Date.now();
      function lookup() {
        if (window.LatiaoCustomers) {
          window.LatiaoCustomers.findByPhone(wanted).then(resolve).catch(function (e) {
            console.warn('Клієнта не вдалося знайти у Firebase', e);
            resolve(null);
          });
        } else if (Date.now() - started < 5000) {
          setTimeout(lookup, 100);
        } else {
          resolve(null);
        }
      }
      lookup();
    });
  }
  function showCustomerModal(order) {
    foundCustomer = order;
    $('#customer-found-name').textContent = order.name || '—';
    $('#customer-found-phone').textContent = order.phone || $('#f-phone').value;
    $('#customer-found-address').textContent = [order.city, order.branch].filter(Boolean).join(', ') || '—';
    customerModal.hidden = false;
    $('#customer-confirm').focus();
  }
  function hideCustomerModal() { customerModal.hidden = true; foundCustomer = null; }
  function applyCustomer(order) {
    var isNp = String(order.carrier || '').toLowerCase().indexOf('нова') !== -1 || String(order.carrier || '').toLowerCase() === 'np';
    vm.delivery.carrier = isNp ? 'np' : 'up';
    document.querySelector('input[name="carrier"][value="' + vm.delivery.carrier + '"]').checked = true;
    if (isNp) {
      $('#np-city').value = order.city || '';
      $('#np-branch').value = order.branch || '';
    } else {
      $('#up-city').value = order.city || '';
      $('#up-index').value = (/\b\d{5}\b/.exec(order.branch || '') || [''])[0];
    }
    $('#f-name').value = order.name || '';
    $('#f-phone').value = order.phone || $('#f-phone').value;
    applyCarrier(false);
    collectDelivery();
    hideCustomerModal();
    haptic(15);
  }
  $('#customer-confirm').addEventListener('click', function () { if (foundCustomer) applyCustomer(foundCustomer); });
  $('#customer-dismiss').addEventListener('click', hideCustomerModal);
  customerModal.addEventListener('click', function (e) { if (e.target === customerModal) hideCustomerModal(); });

  /* ---------- Крок 1: Кошик ---------- */
  var cartBox = $('#cart-items');

  function renderCart() {
    if (!cart) return;
    var items = cart.items();
    if (!items.length && !ordered) {
      $('#cart-card').classList.add('is-empty');
      document.body.classList.add('is-cart-empty');
      stepper.classList.add('is-empty');
      cartBox.innerHTML = '<div class="empty">'
        + '<div class="empty__ic">' + icon('i-cart') + '</div>'
        + '<h3>Кошик порожній</h3>'
        + '<p>Додайте щось гостреньке з каталогу — доставимо швидко!</p>'
        + '<a class="btn" href="catalog.html">До каталогу</a></div>';
      $('#shipbar').hidden = true;
      $('#cart-error').classList.remove('is-on');
      nextBtns.forEach(function (b) { b.hidden = true; });
      renderSummary();
      /* Після заміни вмісту висота слайду має перерахуватися,
         інакше overflow: hidden обрізає текст порожнього кошика. */
      requestAnimationFrame(function () {
        $('#shipbar').hidden = true;
        setStageHeight();
      });
      return;
    }
    $('#cart-card').classList.remove('is-empty');
    document.body.classList.remove('is-cart-empty');
    stepper.classList.remove('is-empty');
    nextBtns.forEach(function (b) { b.hidden = false; });
    cartBox.innerHTML = items.map(function (i) {
      var st = cart.stockFor(i);
      var maxed = st !== null && st !== undefined && i.qty >= st;
      var ph = i.image ? '<img src="' + esc(i.image) + '" alt="">' : icon('i-box');
       var maxNote = maxed ? '<span class="ci__limit-sep" aria-hidden="true">·</span><span class="ci__max">макс. ' + st + ' шт</span>' : '';
      return '<article class="ci">'
        + '<div class="ci__img">' + ph + '</div>'
        + '<div class="ci__main"><div class="ci__top">'
        + '<h3 class="ci__title">' + esc(i.name) + '</h3>'
        + '<button class="ci__del" type="button" data-act="del" data-id="' + esc(i.id) + '" aria-label="Видалити ' + esc(i.name) + '">' + icon('i-trash') + '</button></div>'
        + '<div class="ci__grid"><span class="ci__sku">Арт. ' + esc(i.sku || '—') + '</span>'
        + '<div class="ci__stepper" role="group" aria-label="Кількість"><button type="button" data-act="dec" data-id="' + esc(i.id) + '" aria-label="Менше">' + icon('i-minus') + '</button>'
        + '<output aria-label="Кількість">' + i.qty + '</output><button type="button" data-act="inc" data-id="' + esc(i.id) + '" aria-label="Більше"' + (maxed ? ' disabled' : '') + '>' + icon('i-plus') + '</button></div>'
         + '<span class="ci__unit"><span class="ci__unit-price">' + formatMoney(i.price) + '\u00a0грн\u00a0/\u00a0шт</span>' + maxNote + '</span>'
        + '<span class="ci__sum">' + formatMoney(i.qty * i.price) + '\u00a0<small>грн</small></span></div></div></article>';
    }).join('');
    requestAnimationFrame(function () {
      cartBox.querySelectorAll('.ci__unit').forEach(function (unit) {
        var max = unit.querySelector('.ci__max');
        unit.classList.toggle('is-wrapped', !!max && max.offsetTop > unit.querySelector('.ci__unit-price').offsetTop);
      });
    });
    /* Єдина шкала безкоштовної доставки для всього кошика. */
    var sum = cart.total();
    var left = Math.max(0, FREE_SHIP - sum);
    var pct = Math.min(100, Math.round(sum / FREE_SHIP * 100));
    var ship = $('#shipbar');
    ship.hidden = false;
    var isDone = pct >= 100;
    ship.classList.toggle('is-done', isDone);
    var shipIcon = ship.querySelector('.shipbar__icon use');
    if (shipIcon) shipIcon.setAttribute('href', '#' + (isDone ? 'i-check' : 'i-truck'));
    ship.querySelector('#shipbar-text').textContent = pct >= 100
      ? 'Безкоштовна доставка'
      : (sum / FREE_SHIP < .5 ? 'Безкоштовна доставка від ' + formatMoney(FREE_SHIP) + ' грн' : 'Ще ' + formatMoney(left) + ' грн до безкоштовної доставки');
    var bar = $('#shipbar-bar');
    bar.setAttribute('aria-valuenow', String(pct));
    bar.querySelector('i').style.width = pct + '%';
    $('#shipbar-suggest').hidden = true;
    $('#cart-error').classList.remove('is-on');
    if (sum < MIN_ORDER) showMinimumOrderError();
    renderSummary();
  }

  cartBox.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    var it = cart.items().filter(function (i) { return String(i.id) === String(id); })[0];
    if (!it) return;
    haptic(10);
    if (act === 'inc') cart.setQty(id, it.qty + 1);
    if (act === 'dec') { it.qty <= 1 ? cart.remove(id) : cart.setQty(id, it.qty - 1); }
    if (act === 'del') cart.remove(id);
  });

  /* ---------- Підсумок ---------- */
  function shipLabel() {
    return cartTotal() >= FREE_SHIP ? 'Безкоштовно' : 'За тарифом перевізника';
  }
  function renderSummary() {
    var items = cart ? cart.items() : [];
    var n = cart ? cart.count() : 0;
    var goods = n + ' шт — ' + formatMoney(cartTotal()) + '\u00a0грн';
    ['sum-goods', 'pop-goods'].forEach(function (id) { $('#' + id).textContent = goods; });
    ['sum-ship', 'pop-ship'].forEach(function (id) { $('#' + id).textContent = shipLabel(); });
    $('#sum-total').textContent = formatMoney(cartTotal());
    $('#bar-total').textContent = formatMoney(cartTotal());
    renderPaymentDetails();
  }

  /* Розгортання мобільного підсумку */
  $('#sum-toggle').addEventListener('click', function () {
    var pop = $('#sum-pop');
    var on = pop.classList.toggle('is-on');
    this.setAttribute('aria-expanded', on ? 'true' : 'false');
  });

  /* ---------- Крок 2: Доставка ---------- */
  var fDelivery = $('#form-delivery');
  var condNp = $('#cond-np'), condUp = $('#cond-up'), condNote = $('#cond-note');
  var npFields = ['np-city', 'np-branch'].map(function (id) { return document.getElementById(id); });
  var upFields = ['up-city', 'up-region', 'up-district', 'up-index'].map(function (id) { return document.getElementById(id); });

  function setCond(el, on) { el.classList.toggle('is-on', on); }
  /* Перерахунок висоти stage після анімації розгортання */
  function remeasure() { setTimeout(setStageHeight, 340); }
  function setFieldsActive(fields, on) {
    fields.forEach(function (f) {
      f.required = on;
      if (on) f.removeAttribute('tabindex'); else f.setAttribute('tabindex', '-1');
    });
  }
  /* Область і район Укрпошти — необов'язкові */
  function relaxOptional(fields) {
    fields.forEach(function (f) { f.required = false; });
  }

  function applyCarrier(anim) {
    var np = vm.delivery.carrier === 'np';
    setCond(condNp, np);
    setCond(condUp, !np);
    setFieldsActive(npFields, np);
    setFieldsActive(upFields, !np);
    relaxOptional([upFields[1], upFields[2]]);
    if (!anim) { condNp.style.transition = 'none'; condUp.style.transition = 'none'; void condNp.offsetWidth; condNp.style.transition = ''; condUp.style.transition = ''; }
    else remeasure();
    applyPaymentAvailability();
  }
  fDelivery.addEventListener('change', function (e) {
    if (e.target.name === 'carrier') {
      vm.delivery.carrier = e.target.value; save();
      applyCarrier(true);
      haptic(10);
    }
  });
  $('#note-toggle').addEventListener('click', function () {
    var on = condNote.classList.toggle('is-on');
    this.textContent = on ? 'Приховати коментар' : 'Додати коментар';
    if (on) $('#f-note').focus();
    remeasure();
  });

  /* Маска телефону +380 XX XXX XX XX */
  $('#f-phone').addEventListener('input', function () {
    var d = this.value.replace(/\D/g, '');
    if (d.startsWith('380')) d = d.slice(3);
    d = d.slice(0, 9);
    var out = '+380';
    if (d.length > 0) out += ' ' + d.slice(0, 2);
    if (d.length > 2) out += ' ' + d.slice(2, 5);
    if (d.length > 5) out += ' ' + d.slice(5, 7);
    if (d.length > 7) out += ' ' + d.slice(7, 9);
    this.value = out;
    if (validPhone(out) && out !== customerLookupPhone) {
      customerLookupPhone = out;
      findCustomer(out).then(function (customer) {
        if (customer && $('#f-phone').value === out) showCustomerModal(customer);
      });
    }
  });
  $('#up-index').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 5); });

  function validateDelivery() {
    var ok = true, first = null;
    function chk(input, errId, bad) {
      var good = setErr(input, errId, bad);
      if (!good && !first) first = input;
      ok = ok && good;
    }
    if (vm.delivery.carrier === 'np') {
      chk(npFields[0], 'err-np-city', !npFields[0].value.trim());
      chk(npFields[1], 'err-np-branch', !npFields[1].value.trim());
    } else {
      chk(upFields[0], 'err-up-city', !upFields[0].value.trim());
      chk(upFields[3], 'err-up-index', !/^\d{5}$/.test(upFields[3].value));
    }
    chk($('#f-name'), 'err-name', $('#f-name').value.trim().length < 2);
    chk($('#f-phone'), 'err-phone', !validPhone($('#f-phone').value));
    if (!ok && first) { first.focus(); haptic(30); }
    return ok;
  }

  function collectDelivery() {
    vm.delivery.np = { city: $('#np-city').value.trim(), branch: $('#np-branch').value.trim() };
    vm.delivery.up = { city: $('#up-city').value.trim(), region: $('#up-region').value.trim(), district: $('#up-district').value.trim(), index: $('#up-index').value.trim() };
    vm.contact = { name: $('#f-name').value.trim(), phone: $('#f-phone').value.trim(), note: $('#f-note').value.trim() };
    save();
  }

  /* ---------- Крок 3: Тип оплати ---------- */
  function applyPaymentAvailability() {
    var np = vm.delivery.carrier === 'np';
    var codInput = document.querySelector('input[name="paytype"][value="cod"]');
    var codOption = $('#cod-option');
    var availability = $('#cod-availability');
    var canPrepay = np && cartTotal() > PREPAY_AMOUNT;
    codInput.disabled = !canPrepay;
    codOption.classList.toggle('opt--disabled', !canPrepay);
    codOption.hidden = !canPrepay;
    codOption.setAttribute('aria-disabled', canPrepay ? 'false' : 'true');
    availability.hidden = canPrepay;
    if (!canPrepay && vm.payment.method === 'cod') {
      vm.payment.method = 'online';
      document.querySelector('input[name="paytype"][value="online"]').checked = true;
      codInput.checked = false;
      save();
    }
    renderPaymentDetails();
  }

  function renderPaymentDetails() {
    var total = cartTotal();
    var onlineAmount = $('#online-amount');
    var remaining = $('#cod-remaining');
    var prepayTitle = $('#prepay-title-amount');
    if (onlineAmount) onlineAmount.innerHTML = 'До сплати: ' + formatMoney(total) + '&nbsp;грн';
    if (remaining) remaining.innerHTML = 'Решта при отриманні: ' + formatMoney(Math.max(0, total - PREPAY_AMOUNT)) + '&nbsp;грн';
    if (prepayTitle) prepayTitle.textContent = formatMoney(PREPAY_AMOUNT);
  }

  $('#paytype-opts').addEventListener('change', function (e) {
    if (e.target.name === 'paytype') {
      vm.payment.method = e.target.value; save();
      haptic(10);
      paint();
    }
  });

  /* ---------- Крок 4: Підтвердження ---------- */
  var payError = $('#pay-error'), payErrorText = $('#pay-error-text');
  var busy = false;
  $('#confirm-terms').addEventListener('change', function () {
    nextBtns.forEach(function (b) { b.disabled = vm.step === 3 && !this.checked; }, this);
  });

  function payableAmount() { return vm.payment.method === 'cod' && cartTotal() > PREPAY_AMOUNT ? PREPAY_AMOUNT : cartTotal(); }
  function renderConfirmation() {
    var d = vm.delivery, np = d.carrier === 'np';
    var city = np ? d.np.city : d.up.city;
    var branch = np ? d.np.branch : [d.up.city, d.up.region, d.up.district, d.up.index].filter(Boolean).join(', ');
    $('#confirm-contact').textContent = vm.contact.name + ', ' + vm.contact.phone;
    $('#confirm-delivery').textContent = (np ? 'Нова Пошта' : 'Укрпошта') + ', ' + city + ', ' + branch;
    $('#confirm-shipping').textContent = cartTotal() >= FREE_SHIP ? 'Доставка: Безкоштовно' : 'Доставка: за тарифом перевізника';
    $('#confirm-payment').textContent = vm.payment.method === 'cod' && cartTotal() > PREPAY_AMOUNT ? 'Передоплата ' + formatMoney(PREPAY_AMOUNT) + ' грн' : 'Повна оплата';
    $('#confirm-goods').textContent = formatMoney(cartTotal()) + ' грн';
    $('#confirm-ship').textContent = cartTotal() >= FREE_SHIP ? 'Безкоштовно' : 'За тарифом';
    $('#confirm-items').innerHTML = cart.items().map(function (i) {
      var photo = i.image
        ? '<img src="' + esc(i.image) + '" alt="' + esc(i.name) + '">'
        : '<span class="confirm-item__placeholder">' + icon('i-box') + '</span>';
      return '<div class="confirm-item">'
        + photo
        + '<div class="confirm-item__description"><strong>' + esc(i.name) + '</strong><small>Артикул: ' + esc(i.sku || '—') + '</small></div>'
        + '<span class="confirm-item__unit">' + formatMoney(i.price) + ' грн</span>'
        + '<span class="confirm-item__qty">× ' + i.qty + '</span>'
        + '<strong class="confirm-item__price">' + formatMoney(i.price * i.qty) + ' грн</strong>'
        + '</div>';
    }).join('');
    var prepay = vm.payment.method === 'cod' && cartTotal() > PREPAY_AMOUNT;
    $('#due-label').textContent = prepay ? 'До сплати зараз' : 'До сплати';
    $('#due-amount').textContent = formatMoney(payableAmount()) + ' грн';
    $('#due-note').hidden = !prepay;
    $('#due-note').textContent = 'Залишок ' + formatMoney(cartTotal() - PREPAY_AMOUNT) + ' грн сплатите при отриманні';
    $('#confirm-terms').checked = false;
  }

  document.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { go(Number(this.dataset.edit), -1); }); });

  function btnState(state, text) {
    nextBtns.forEach(function (b) {
      b.classList.remove('btn--ok', 'btn--err');
      var sp = b.querySelector('.btn__spin');
      if (sp) sp.remove();
      if (state === 'loading') {
        b.disabled = true;
        b.textContent = '';
        var s = document.createElement('span'); s.className = 'btn__spin'; s.setAttribute('aria-hidden', 'true');
        b.appendChild(s);
        b.appendChild(document.createTextNode(text || 'Обробляємо…'));
      } else {
        b.disabled = false;
        if (state === 'ok') b.classList.add('btn--ok');
        if (state === 'err') b.classList.add('btn--err');
        b.textContent = text;
      }
    });
  }
  function showPayError(msg) { payErrorText.textContent = msg; payError.classList.add('is-on'); }
  function hidePayError() { payError.classList.remove('is-on'); }


  /* Єдиний обробник переходу вперед */
  function next() {
    if (busy) return;
    hidePayError();
    var s = vm.step;
    if (s === 0) {
      if (!cart || !cart.items().length) return;
      if (!hasMinimumOrder()) { showMinimumOrderError(); return; }
      done[0] = true; save(); haptic(15);
      go(1, 1);
    } else if (s === 1) {
      if (!validateDelivery()) return;
      collectDelivery();
      done[1] = true; save(); haptic(15);
      go(2, 1);
    } else if (s === 2) {
      done[2] = true; save(); haptic(15);
      renderConfirmation();
      go(3, 1);
    } else if (s === 3) {
      submitPay();
    }
  }
  nextBtns.forEach(function (b) { b.addEventListener('click', next); });

  function submitPay() {
    if (busy) return;
    /* Повторна перевірка блокує оформлення навіть якщо суму зменшили на іншому кроці. */
    if (!hasMinimumOrder()) {
      vm.step = 0;
      save();
      renderCart();
      showMinimumOrderError();
      return;
    }
    if (!$('#confirm-terms').checked) { showPayError('Погодьтеся з умовами замовлення'); return; }
    busy = true;
    btnState('loading', 'Зачекайте…');
    haptic(15);
    try {
      finishOrder(vm.payment.method === 'online', '');
    } catch (err) {
        busy = false;
        btnState('err', 'Оплатити ' + formatMoney(payableAmount()) + ' грн');
        haptic(60);
        showPayError('Не вдалось перейти до оплати. Спробуйте ще раз');
    }
  }

  /* ---------- Оформлення замовлення ---------- */
  function finishOrder(online, payId) {
    var d = vm.delivery, np = d.carrier === 'np';
    var order = {
      id: 'Г-' + Date.now().toString(36).toUpperCase(),
      date: new Date().toISOString(),
      name: vm.contact.name, phone: vm.contact.phone,
      carrier: np ? 'Нова Пошта' : 'Укрпошта',
      city: np ? d.np.city : d.up.city,
      branch: np ? d.np.branch : [d.up.city, d.up.region, d.up.district, d.up.index].filter(Boolean).join(', '),
      note: vm.contact.note,
      payment: online ? 'online' : 'cod',
      paymentAmount: payableAmount(),
      status: 'Очікує оплати',
      payId: payId || '',
      items: cart.items(), total: cart.total()
    };
    try {
      var orders = JSON.parse(localStorage.getItem('latiao_orders') || '[]');
      orders.push(order); localStorage.setItem('latiao_orders', JSON.stringify(orders));
    } catch (err) { }
    ordered = true;
    /* Замовлено — запис покинутого кошика прибираємо */
    cancelAbandonSync();
    removeAbandoned();
    location.href = 'https://payment.example/checkout?order=' + encodeURIComponent(order.id) + '&amount=' + encodeURIComponent(payableAmount());
    return;
    cart.clear();
    try { sessionStorage.removeItem(KEY); } catch (e) { }
    /* Назад з екрану подяки не повертає в потік */
    history.replaceState({ done: true }, '', location.href.split('#')[0]);

    $('#ok-number').textContent = '№ ' + order.id;
    $('#ok-carrier').textContent = order.carrier + ', ' + order.city;
    $('#ok-branch').textContent = order.branch;
    $('#ok-pay').textContent = online ? 'Оплачено картою' : 'Оплата при отриманні';
    $('#ok-count').textContent = order.items.reduce(function (s, i) { return s + i.qty; }, 0) + ' шт';
    $('#ok-total').textContent = money(order.total) + ' грн';
    $('#ok-note').textContent = online
      ? 'Оплата надійшла — передаємо замовлення перевізнику.'
      : 'Підготуйте ' + money(order.total) + ' грн до сплати при отриманні.';

    $('#checkout-view').style.display = 'none';
    $('#bottom-bar').style.display = 'none';
    $('#success-view').classList.add('is-on');
    backBtn.hidden = true;
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    haptic([30, 60, 30]);
    busy = false;
  }

  /* «Відстежити замовлення»: системи відстеження ще немає — показуємо підказку */
  $('#ok-track').addEventListener('click', function () {
    var b = this;
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    var note = $('#ok-note');
    var old = note.textContent;
    note.textContent = 'Трек-номер з’явиться тут після відправки замовлення — ми надішлемо вам SMS на ' + vm.contact.phone + '.';
    setTimeout(function () { note.textContent = old; delete b.dataset.busy; }, 4000);
  });

  /* ---------- Покинуті кошики ----------
     Запис зберігається в Firestore (colекція abandonedCarts) одразу, коли коректний телефон,
     і оновлюється при зміні даних. Після успішного замовлення запис видаляється.
     Видаляти записи вручну може лише адміністратор. */
  var ABANDON_KEY = 'latiao_abandon';
  var abandonTimer = null, abandonSig = '';
  function storedAbandon() {
    try { var r = JSON.parse(localStorage.getItem(ABANDON_KEY) || 'null'); return r && r.id ? r : null; } catch (e) { return null; }
  }
  function abandonRecord() {
    var r = storedAbandon();
    if (!r) {
      r = { id: 'AC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase(), createdAt: new Date().toISOString() };
      try { localStorage.setItem(ABANDON_KEY, JSON.stringify(r)); } catch (e) { }
    }
    return r;
  }
  function abandonData() {
    var np = fDelivery.carrier.value === 'np';
    var up = ['up-city', 'up-region', 'up-district', 'up-index'].map(function (id) { return $('#' + id).value.trim(); });
    var pt = $('input[name="paytype"]:checked');
    return {
      name: $('#f-name').value.trim(),
      phone: $('#f-phone').value.trim(),
      note: $('#f-note').value.trim(),
      carrier: np ? 'Нова Пошта' : 'Укрпошта',
      city: np ? $('#np-city').value.trim() : up[0],
      branch: np ? $('#np-branch').value.trim() : up.filter(Boolean).join(', '),
      paymentMethod: pt ? pt.value : 'cod',
      step: vm.step,
      items: cart.items().map(function (i) { return { id: String(i.id), name: i.name, price: Number(i.price) || 0, qty: Number(i.qty) || 0, sku: i.sku || '', image: i.image || '' }; }),
      total: cart.total()
    };
  }
  function scheduleAbandonSync() {
    clearTimeout(abandonTimer);
    abandonTimer = setTimeout(syncAbandoned, 500);
  }
  function syncAbandoned() {
    abandonTimer = null;
    var api = window.LatiaoAbandoned;
    if (!api || ordered || !cart || !cart.items().length) return;
    var data = abandonData();
    if (!validPhone(data.phone)) return;
    var sig = JSON.stringify(data);
    if (sig === abandonSig) return;
    abandonSig = sig;
    var rec = abandonRecord();
    api.save(rec.id, Object.assign({}, data, { createdAt: rec.createdAt })).catch(function (e) {
      abandonSig = ''; console.warn('Покинуті кошики: не вдалося зберегти', e);
    });
  }
  function cancelAbandonSync() { clearTimeout(abandonTimer); abandonTimer = null; }
  function removeAbandoned() {
    var rec = storedAbandon();
    try { localStorage.removeItem(ABANDON_KEY); } catch (e) { }
    abandonSig = '';
    if (rec && window.LatiaoAbandoned) {
      window.LatiaoAbandoned.remove(rec.id).catch(function (e) { console.warn('Покинуті кошики: не вдалося видалити', e); });
    }
  }

  /* ---------- Ініціалізація ---------- */
  function init() {
    if (!cart) return;
    /* Відновлення даних у полях */
    fDelivery.carrier.value = vm.delivery.carrier;
    $('#np-city').value = vm.delivery.np.city; $('#np-branch').value = vm.delivery.np.branch;
    $('#up-city').value = vm.delivery.up.city; $('#up-region').value = vm.delivery.up.region;
    $('#up-district').value = vm.delivery.up.district; $('#up-index').value = vm.delivery.up.index;
    $('#f-name').value = vm.contact.name; $('#f-phone').value = vm.contact.phone; $('#f-note').value = vm.contact.note;
    if (vm.contact.note) {
      condNote.style.transition = 'none';
      condNote.classList.add('is-on');
      void condNote.offsetWidth;
      condNote.style.transition = '';
      $('#note-toggle').textContent = 'Приховати коментар';
    }
    document.querySelector('input[name="paytype"][value="' + vm.payment.method + '"]').checked = true;
    applyCarrier(false);
    applyPaymentAvailability();
    renderConfirmation();
    renderCart();
    cart.onChange(renderCart);

    /* Звіряння залишків: cart.js сам обрізає кількість; попереджаємо про закінчилися */
    cart.fetchStocks().then(function () {
      renderCart();
      var out = cart.items().filter(function (i) {
        var st = cart.stockFor(i);
        return st !== null && st !== undefined && st <= 0;
      });
      if (out.length) {
        $('#cart-error-text').textContent = 'Закінчилися: ' + out.map(function (i) { return i.name; }).join(', ') + '. Видаліть їх, щоб продовжити.';
        $('#cart-error').classList.add('is-on');
      }
    });

    /* Мережа: попередження на етапі оплати */
    window.addEventListener('offline', function () { if (vm.step === 3) showPayError('Немає з’єднання з інтернетом. Перевірте мережу та спробуйте ще раз.'); });
    window.addEventListener('online', hidePayError);

    /* Покинуті кошики: синхронізація при введенні даних і змінах кошика */
    ['f-name', 'f-phone', 'f-note', 'np-city', 'np-branch', 'up-city', 'up-region', 'up-district', 'up-index'].forEach(function (id) {
      $('#' + id).addEventListener('input', scheduleAbandonSync);
    });
    fDelivery.addEventListener('change', scheduleAbandonSync);
    $('#paytype-opts').addEventListener('change', scheduleAbandonSync);
    cart.onChange(scheduleAbandonSync);

    /* Перерахунок висоти при зміні розміру */
    window.addEventListener('resize', setStageHeight);

    paint();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ---------- Плашка «Найближча відправка» біля Нової Пошти (завжди видима) ----------
   Та сама логіка, що й у shipbar.js (час Києва):
     до 10:30          → відправка сьогодні до 12:00
     після 10:30       → відправка сьогодні до 17:00
     після 17:02       → найближча відправка завтра до 12:00 */
(function () {
  'use strict';
  var txt = document.getElementById('np-ship-txt');
  if (!txt) return;

  function kyivNow() {
    var now = new Date();
    var utc = now.getTime() + now.getTimezoneOffset() * 60000;
    var k = new Date(utc + 2 * 3600000);
    var y = k.getFullYear();
    function lastSunday(month) { var d = new Date(y, month + 1, 0); return d.getDate() - d.getDay(); }
    var dstStart = new Date(y, 2, lastSunday(2), 3, 0, 0);
    var dstEnd = new Date(y, 9, lastSunday(9), 4, 0, 0);
    if (k >= dstStart && k < dstEnd) k = new Date(utc + 3 * 3600000);
    return k;
  }

  function text() {
    var d = kyivNow();
    var h = d.getHours(), m = d.getMinutes();
    var t = h * 60 + m;
    if (t < 10 * 60 + 30) return 'Відправка сьогодні до 12:00';
    if (t < 17 * 60 + 2) return 'Відправка сьогодні до 17:00';
    return 'Найближча відправка — завтра до 12:00';
  }

  function refresh() { txt.textContent = text(); }
  refresh();
  setInterval(refresh, 60000); /* текст актуалізується щохвилини */
})();
