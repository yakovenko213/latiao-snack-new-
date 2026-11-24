'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');

initializeApp();
const db = getFirestore();
const KEYCRM_BASE = 'https://openapi.keycrm.app/v1';
const KEYCRM_SOURCE_ID = 7;
let cachedNewStatus = null;

// ===== Залишки та резерви: спільні хелпери =====
const ARTICLE_KEYS = ['article', 'articul', 'sku', 'vendorCode', 'productCode', 'code', 'артикул'];
const DEFAULT_CANCEL_STATUSES = ['Скасоване', 'Скасовано', 'Відмова', 'Не оплачено', 'Не забрано'];
const normSku = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const productSku = product => ARTICLE_KEYS.map(key => product[key]).find(value => value != null && String(value).trim());
// Сайти, що працюють з однією базою: основний і другий.
const SITE_MAIN = 'latiao-snack';
const SITE_SECOND = 'snack-latiao';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadStockSettings() {
  const snap = await db.doc('settings/keycrm').get();
  const data = snap.exists ? snap.data() : {};
  return {
    apiKey: String(data.apiKey || '').trim(),
    autoSync: !!data.autoSync,
    intervalMinutes: Math.max(1, Number(data.intervalMinutes) || 10),
    deductStatusIds: Array.isArray(data.deductStatusIds) ? data.deductStatusIds.map(String) : [],
    cancelStatuses: Array.isArray(data.cancelStatuses) && data.cancelStatuses.length ? data.cancelStatuses.map(String) : DEFAULT_CANCEL_STATUSES,
    autoReleaseUnpaid: !!data.autoReleaseUnpaid,
    unpaidTimeoutHours: Math.max(1, Number(data.unpaidTimeoutHours) || 48),
    lastSync: data.lastSync || null
  };
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sendError(res, error) {
  const status = Number(error.status) || 500;
  res.status(status).json({ error: error.message || 'Внутрішня помилка сервера', details: error.details });
}

async function requireAuth(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) throw new HttpError(401, 'Потрібна авторизація');
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    throw new HttpError(401, 'Недійсна сесія. Оновіть сторінку адміністратора.');
  }
}

async function currentKey() {
  const snap = await db.doc('settings/keycrm').get();
  const key = snap.exists ? String(snap.get('apiKey') || '').trim() : '';
  if (!key) throw new HttpError(400, 'Вкажіть API-ключ KeyCRM в Налаштуваннях');
  return key;
}

async function keycrmRequest(key, path, options = {}) {
  let response;
  try {
    response = await fetch(`${KEYCRM_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });
  } catch (error) {
    console.error('KeyCRM network error:', error.message);
    throw new HttpError(503, 'KeyCRM недоступний, спробуйте пізніше');
  }

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    // Повний body KeyCRM логгується, але секретні заголовки ніколи не логгуються.
    console.error('KeyCRM API error:', JSON.stringify({ status: response.status, path, response: body }));
    const details = body?.errors || body?.message || body?.error || text || `HTTP ${response.status}`;
    throw new HttpError(response.status, typeof details === 'string' ? details : JSON.stringify(details), body);
  }
  return { status: response.status, body };
}

function asDate(value) {
  if (!value) return null;
  if (value && typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function crmDate(value) {
  const date = asDate(value);
  if (!date) return undefined;
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

async function newStatusId(key) {
  if (cachedNewStatus && cachedNewStatus.expiresAt > Date.now()) return cachedNewStatus.id;
  let lastResponse = null;
  for (let page = 1; page <= 100; page++) {
    const result = await keycrmRequest(key, `/order/status?limit=50&page=${page}`);
    lastResponse = result.body;
    const candidates = [];
    const labelFields = ['name', 'title', 'label', 'status_name', 'statusName', 'status_title', 'statusTitle', 'display_name', 'displayName', 'status', 'value', 'uk', 'ua', 'ru', 'en', 'slug', 'code', 'alias'];
    const visit = (value, inheritedId = null) => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, inheritedId)); return; }
      if (!value || typeof value !== 'object') return;
      const id = value.id ?? value.status_id ?? value.statusId ?? inheritedId;
      for (const [field, child] of Object.entries(value)) {
        if (id != null && labelFields.includes(field) && typeof child === 'string' && child.trim()) candidates.push({ id, label: child });
        if (child && typeof child === 'object') visit(child, /^\d+$/.test(field) ? field : id);
      }
    };
    visit(result.body);
    const found = candidates.find(status => ['новий', 'новый', 'new', 'new_order'].includes(String(status.label).trim().normalize('NFKC').toLocaleLowerCase('uk').replace(/ё/g, 'е').replace(/[\s-]+/g, '_')));
    if (found) {
      cachedNewStatus = { id: found.id, expiresAt: Date.now() + 15 * 60 * 1000 };
      return found.id;
    }
    const responseRows = result.body?.data;
    const rowCount = Array.isArray(result.body) ? result.body.length : (Array.isArray(responseRows) ? responseRows.length : (Array.isArray(responseRows?.data) ? responseRows.data.length : 0));
    if (!rowCount || rowCount < 50) break;
    // API uses page-based pagination; one final empty page is harmless when
    // exactly 50 rows are returned on the last page.
  }
  console.error('KeyCRM «Новий» status lookup returned no match:', JSON.stringify({ endpoint: '/order/status', response: lastResponse }));
  throw new HttpError(422, 'У KeyCRM не знайдено статус «Новий»');
}

async function createKeycrmOrder(key, payload) {
  try {
    const created = await keycrmRequest(key, '/order', { method: 'POST', body: JSON.stringify(payload) });
    return { response: created, id: created.body?.id ?? created.body?.data?.id, statusUpdated: true };
  } catch (error) {
    const message = `${error.message || ''} ${JSON.stringify(error.details || {})}`;
    if (error.status !== 422 || !/status(?:_id)?/i.test(message)) throw error;
    const withoutStatus = { ...payload };
    delete withoutStatus.status_id;
    const created = await keycrmRequest(key, '/order', { method: 'POST', body: JSON.stringify(withoutStatus) });
    const id = created.body?.id ?? created.body?.data?.id;
    if (created.status !== 201 || id == null) return { response: created, id, statusUpdated: false };
    try {
      await keycrmRequest(key, `/order/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status_id: payload.status_id }) });
      return { response: created, id, statusUpdated: true };
    } catch (updateError) {
      console.error('KeyCRM order created but status update failed:', JSON.stringify({ orderId: id, status: updateError.status || 500, response: updateError.details || updateError.message }));
      return { response: created, id, statusUpdated: false };
    }
  }
}

function paymentStatus(order) {
  if (order.simplifiedOrder === true) return 'not_paid';
  const value = String(order.paymentStatus || order.payment_status || order.status || '').toLowerCase();
  if (/скас|відмов|cancel|refund|fail/.test(value)) return 'canceled';
  if (/оплачен|paid|успіш/.test(value) || order.paid === true) return 'paid';
  return 'not_paid';
}

function toKeycrmPayload(order, docId, statusId) {
  const items = Array.isArray(order.items) ? order.items : [];
  const buyer = compact({ full_name: String(order.name || order.fullName || '').trim(), email: order.email || order.customerEmail || undefined, phone: order.phone || order.customerPhone || undefined });
  if (!items.length) throw new HttpError(422, 'У замовленні немає товарів');
  if (!buyer.full_name || (!buyer.phone && !buyer.email)) throw new HttpError(422, 'Для передачі потрібні ім’я та телефон або email покупця');

  const total = Number(order.total) || 0;
  const discount = Number(order.discount) || 0;
  const itemRows = items.map(item => {
    const properties = [];
    const sourceProps = item.properties || item.variant || item.options;
    if (Array.isArray(sourceProps)) sourceProps.forEach(prop => {
      if (prop && prop.name && prop.value != null && prop.value !== '') properties.push({ name: String(prop.name), value: String(prop.value) });
    });
    else if (sourceProps && typeof sourceProps === 'object') Object.entries(sourceProps).forEach(([name, value]) => {
      if (value != null && value !== '') properties.push({ name, value: String(value) });
    });
    if (!properties.length && Number(item.packCount) > 1) properties.push({ name: 'Фасування', value: `${Number(item.packCount)} шт` });
    return compact({
      sku: item.sku || item.article || item.id || undefined,
      name: item.name || item.title || 'Товар',
      price: Number(item.price) || 0,
      quantity: Number(item.qty ?? item.quantity) || 0,
      unit_type: item.unit || item.unit_type || 'шт',
      picture: item.image || item.picture || undefined,
      properties: properties.length ? properties : undefined,
      discount_percent: Number(item.discount_percent) || undefined,
      discount_amount: Number(item.discount_amount) || undefined
    });
  });
  if (itemRows.some(item => !(item.quantity > 0))) throw new HttpError(422, 'У позиціях замовлення некоректна кількість товару');

  const shipping = compact({
    shipping_service: order.carrier || order.shipping_service || undefined,
    shipping_address_city: order.city || order.shipping_address_city || undefined,
    shipping_address_country: order.country || order.shipping_address_country || undefined,
    shipping_address_region: order.region || order.shipping_address_region || undefined,
    shipping_address_zip: order.zip || order.index || order.shipping_address_zip || undefined,
    shipping_receive_point: order.branch || order.shipping_receive_point || undefined,
    recipient_full_name: order.recipientName || order.recipient_full_name || buyer.full_name,
    recipient_phone: order.recipientPhone || order.recipient_phone || buyer.phone
  });
  const paidStatus = paymentStatus(order);
  const payment = compact({
    amount: Number(order.paymentAmount ?? total),
    payment_method: order.paymentMethod || ({ online: 'Картка онлайн', cod: 'Наложений платіж', prepaid: 'Передоплата' }[order.payment] || order.payment || undefined),
    status: paidStatus,
    payment_date: paidStatus === 'paid' ? crmDate(order.paymentDate || order.paidAt || order.date) : undefined,
    description: order.payId ? `ID платежу: ${order.payId}` : undefined
  });
  const summedProducts = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty ?? item.quantity) || 0), 0);
  const discountPercent = discount > 0 && summedProducts > 0 ? Math.round(discount / summedProducts * 10000) / 100 : undefined;

  return compact({
    source_id: KEYCRM_SOURCE_ID,
    source_uuid: String(order.id || docId),
    status_id: statusId,
    buyer,
    buyer_comment: order.note || order.buyer_comment || undefined,
    shipping: Object.keys(shipping).length ? shipping : undefined,
    shipping_price: order.shippingPrice != null || order.shipping_price != null ? Number(order.shippingPrice ?? order.shipping_price) : undefined,
    promocode: order.promo || order.promocode || undefined,
    discount_percent: discountPercent,
    discount_amount: discount || undefined,
    ordered_at: crmDate(order.date || order.createdAt),
    marketing: order.utm_source || order.utmSource ? compact({
      utm_source: order.utm_source || order.utmSource,
      utm_medium: order.utm_medium || order.utmMedium,
      utm_campaign: order.utm_campaign || order.utmCampaign,
      utm_term: order.utm_term || order.utmTerm,
      utm_content: order.utm_content || order.utmContent
    }) : undefined,
    products: itemRows,
    payments: [payment]
  });
}

async function transferOrder(req, res, orderId) {
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpError(404, 'Замовлення не знайдено');
  const order = orderSnap.data();
  if (order.keycrm_order_id) throw new HttpError(409, `Замовлення вже передано в KeyCRM (#${order.keycrm_order_id})`);
  const customerName = String(order.name || order.fullName || '').trim();
  if (!customerName || !(order.phone || order.email || order.customerEmail || order.customerPhone)) {
    throw new HttpError(422, 'Для передачі потрібні ім’я та телефон або email покупця');
  }
  if (!Array.isArray(order.items) || !order.items.length) throw new HttpError(422, 'У замовленні немає товарів');

  const claim = await db.runTransaction(async transaction => {
    const fresh = await transaction.get(orderRef);
    if (fresh.get('keycrm_order_id')) return { alreadySent: fresh.get('keycrm_order_id') };
    const startedAt = fresh.get('keycrm_transfer_started_at');
    if (startedAt && Date.now() - startedAt.toMillis() < 5 * 60 * 1000) throw new HttpError(409, 'Передача цього замовлення вже виконується');
    transaction.update(orderRef, { keycrm_transfer_started_at: FieldValue.serverTimestamp() });
    return { alreadySent: null };
  });
  if (claim.alreadySent) throw new HttpError(409, `Замовлення вже передано в KeyCRM (#${claim.alreadySent})`);

  try {
    const key = await currentKey();
    const statusName = 'Новий';
    const statusId = await newStatusId(key);
    const payload = toKeycrmPayload(order, orderId, statusId);
    const created = await createKeycrmOrder(key, payload);
    const keycrmOrderId = created.id;
    if (created.response.status !== 201 || keycrmOrderId == null) {
      console.error('KeyCRM create response:', JSON.stringify({ status: created.response.status, response: created.response.body }));
      throw new HttpError(502, 'KeyCRM повернув неочікувану відповідь під час створення замовлення');
    }
    await orderRef.update({
      keycrm_order_id: keycrmOrderId,
      keycrm_transferred_at: FieldValue.serverTimestamp(),
      keycrm_transfer_started_at: FieldValue.delete()
    });
    res.status(201).json({ id: keycrmOrderId, statusName, statusUpdated: created.statusUpdated });
  } catch (error) {
    await orderRef.update({ keycrm_transfer_started_at: FieldValue.delete() }).catch(updateError => console.error('Failed to release KeyCRM order lock:', updateError.message));
    throw error;
  }
}

async function keycrmStocks(key, limit, page) {
  return keycrmRequest(key, `/offers/stocks?limit=${limit}&page=${page}&filter[details]=true`);
}

async function fetchKeycrmOrderStatuses(key, crmIds) {
  const statuses = new Map();
  for (let index = 0; index < crmIds.length; index += 20) {
    const batch = crmIds.slice(index, index + 20);
    const results = await Promise.all(batch.map(async crmId => {
      try {
        const result = await keycrmRequest(key, `/order/${encodeURIComponent(crmId)}`);
        const order = result.body?.data && !Array.isArray(result.body.data) ? result.body.data : result.body;
        return [String(crmId), order?.status_id ?? order?.statusId ?? null];
      } catch (error) {
        if (error.status === 401) throw error;
        console.error('KeyCRM order status fetch failed:', JSON.stringify({ crmId, status: error.status || 500, message: error.message }));
        return [String(crmId), null];
      }
    }));
    results.forEach(([crmId, statusId]) => statuses.set(crmId, statusId));
    if (index + 20 < crmIds.length) await pause(600);
  }
  return statuses;
}

async function applyStockSync({ activeReservations, orderIdToCrm, crmStatuses, stocks, deductStatusIds }) {
  const now = new Date();
  const bySku = new Map(stocks.map(item => [normSku(item.sku), item]).filter(([sku]) => sku));
  const deductSet = new Set(deductStatusIds.map(String));
  const releasedCrmIds = new Set();
  crmStatuses.forEach((statusId, crmId) => { if (statusId != null && deductSet.has(String(statusId))) releasedCrmIds.add(crmId); });

  return db.runTransaction(async transaction => {
    // Повторне читання резервів усередині транзакції — ідемпотентність списання.
    const fresh = await Promise.all(activeReservations.map(reservation => transaction.get(db.doc('stock_reservations/' + reservation.id))));
    const stillActive = [];
    fresh.forEach((snap, index) => {
      if (snap.exists && snap.get('status') === 'active') stillActive.push({ id: snap.id, ...snap.data() });
    });

    const released = stillActive.filter(reservation => {
      const crmId = orderIdToCrm.get(String(reservation.orderId || ''));
      return crmId && releasedCrmIds.has(crmId);
    });
    const releasedIds = new Set(released.map(reservation => reservation.id));
    const reservedBySku = new Map();
    stillActive.forEach(reservation => {
      if (releasedIds.has(reservation.id)) return;
      const sku = normSku(reservation.sku);
      if (!sku) return;
      reservedBySku.set(sku, (reservedBySku.get(sku) || 0) + (Number(reservation.quantity) || 0));
    });

    const productSnap = await transaction.get(db.collection('products'));
    const logs = [];
    const mismatches = [];
    productSnap.docs.forEach(productDoc => {
      const product = productDoc.data();
      const skuRaw = productSku(product);
      const sku = normSku(skuRaw || '');
      const update = { stockSyncedAt: now, stockSource: 'keycrm' };
      if (!sku || !bySku.has(sku)) {
        update.skuMismatch = true;
        update.skuMismatchMessage = !skuRaw ? 'У товару не заповнено артикул (sku)' : `Артикул «${skuRaw}» не знайдено в KeyCRM`;
        if (product.stock_total == null) update.stock_total = Number(product.stock) || 0;
        mismatches.push({ productId: productDoc.id, name: product.name || product.title || productDoc.id, sku: skuRaw || '', message: update.skuMismatchMessage });
      } else {
        const row = bySku.get(sku);
        const stockTotal = Number(row.quantity) || 0;
        const reserved = reservedBySku.get(sku) || 0;
        const available = stockTotal - reserved;
        update.skuMismatch = FieldValue.delete();
        update.skuMismatchMessage = FieldValue.delete();
        update.stock_total = stockTotal;
        update.stock = available;
        update.crmQuantity = stockTotal;
        update.crmReserve = Number(row.reserve) || 0;
        update.crmWarehouses = row.warehouse || [];
        update.crmSku = row.sku || '';
        if (product.inStock !== undefined) update.inStock = available > 0;
        if (available < 0) update.negativeAvailable = true; else update.negativeAvailable = FieldValue.delete();
        const previousTotal = Number(product.stock_total);
        if (Number.isFinite(previousTotal) && previousTotal !== stockTotal) {
          logs.push({ at: now, productId: productDoc.id, sku: skuRaw, change: stockTotal - previousTotal, reservedChange: 0, reason: 'Синхронізація залишків з KeyCRM', orderId: null, source: 'sync' });
        }
      }
      transaction.update(productDoc.ref, update);
    });

    for (const reservation of released) {
      transaction.update(db.doc('stock_reservations/' + reservation.id), { status: 'released_sold', releasedAt: now, reason: 'Списано в KeyCRM (статус замовлення, що списує)' });
      transaction.set(db.collection('stock_log').doc(), { at: now, productId: reservation.productId || '', sku: reservation.sku || '', change: 0, reservedChange: -(Number(reservation.quantity) || 0), reason: 'Списано в KeyCRM', orderId: reservation.orderId || null, source: 'sync' });
      transaction.set(db.doc('orders/' + reservation.orderId), { reservationState: 'sold', reservationSoldAt: now }, { merge: true });
    }
    return { updated: productSnap.size, released: released.length, mismatches, logs };
  });
}

async function runStockSync() {
  const settings = await loadStockSettings();
  if (!settings.apiKey) throw new HttpError(400, 'Вкажіть API-ключ KeyCRM в Налаштуваннях');
  const key = settings.apiKey;
  const startedAt = new Date();
  try {
    // Крок 1: статуси замовлень з активними резервами, переданих у KeyCRM.
    const activeReservations = (await db.collection('stock_reservations').where('status', '==', 'active').get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const orderIds = [...new Set(activeReservations.map(reservation => String(reservation.orderId || '')).filter(Boolean))];
    const orderSnaps = await Promise.all(orderIds.map(id => db.collection('orders').doc(id).get().catch(() => null)));
    const orderIdToCrm = new Map();
    const missingOrderIds = [];
    orderSnaps.forEach((snap, index) => {
      if (snap?.exists) {
        const crmId = snap.get('keycrm_order_id');
        if (crmId != null && String(crmId).trim()) orderIdToCrm.set(snap.id, String(crmId));
      } else {
        missingOrderIds.push(orderIds[index]);
      }
    });
    // Замовлення видалено з бази → його резерв анулюємо (залишок повертається в available).
    for (const orderId of [...new Set(missingOrderIds)].filter(Boolean)) {
      try {
        const released = await releaseOrderReservations(orderId, 'released_cancelled', 'Замовлення видалено з бази — резерв анульовано', { restoreStock: true, skipOrderUpdate: true });
        console.log('Released reservation of deleted order:', JSON.stringify({ orderId, ...released }));
      } catch (error) {
        console.error('Failed to release reservation of deleted order:', JSON.stringify({ orderId, message: error.message }));
      }
    }
    const crmStatuses = await fetchKeycrmOrderStatuses(key, [...orderIdToCrm.values()]);
    // Крок 2: залишки товарів із KeyCRM.
    const stocks = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await keycrmStocks(key, 50, page);
      const rows = Array.isArray(result.body?.data) ? result.body.data : [];
      stocks.push(...rows);
      if (!rows.length || !result.body?.next_page_url) break;
    }
    // Крок 3: одна транзакція — stock_total, зняття резервів, журнал.
    const result = await applyStockSync({ activeReservations, orderIdToCrm, crmStatuses, stocks, deductStatusIds: settings.deductStatusIds });
    const finishedAt = new Date();
    const summary = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), status: 'ok', processed: stocks.length, updated: result.updated, released: result.released, mismatches: result.mismatches.length, error: '' };
    await db.collection('syncLogs').add(summary);
    await db.doc('settings/keycrm').set({ lastSync: { at: finishedAt.toISOString(), ok: true, error: '', released: result.released, mismatches: result.mismatches } }, { merge: true });
    return { ...summary, mismatchList: result.mismatches };
  } catch (error) {
    // Помилка API: залишки й резерви не змінюємо, логуємо та показуємо помилку.
    const message = String(error.message || 'Помилка синхронізації').slice(0, 500);
    await db.collection('syncLogs').add({ startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), status: 'error', processed: 0, updated: 0, released: 0, mismatches: 0, error: message }).catch(() => {});
    await db.doc('settings/keycrm').set({ lastSync: { at: new Date().toISOString(), ok: false, error: message } }, { merge: true }).catch(() => {});
    throw error;
  }
}

async function syncStocks(res) {
  const result = await runStockSync();
  return res.json({ processed: result.processed, updated: result.updated, released: result.released, mismatches: result.mismatches, mismatchList: result.mismatchList, finishedAt: result.finishedAt });
}

function keycrmShippingFields(body) {
  const order = body?.data && !Array.isArray(body.data) ? body.data : body;
  const shipping = order?.shipping && !Array.isArray(order.shipping) ? order.shipping : {};
  const deliveryService = shipping.deliveryService || shipping.delivery_service || {};
  const trackingNumber = String(shipping.tracking_code || shipping.trackingCode || '').trim();
  const service = shipping.shipping_service || shipping.shippingService || deliveryService.name || deliveryService.title || shipping.delivery_service_id;
  const history = Array.isArray(shipping.lastHistory) ? shipping.lastHistory[shipping.lastHistory.length - 1] : (shipping.lastHistory || {});
  const shippedAt = shipping.shipping_date || shipping.shipped_at || shipping.shippingDate || history?.shipping_date || history?.created_at || history?.date;
  return {
    trackingNumber,
    shippingService: service == null ? '' : String(service).trim(),
    shippedAt: shippedAt == null ? '' : String(shippedAt).trim(),
    city: String(shipping.shipping_address_city || shipping.city || '').trim(),
    point: String(shipping.shipping_receive_point || shipping.branch || shipping.warehouse || '').trim()
  };
}

async function syncOrderTracking(orderRef, orderData, key) {
  const keycrmOrderId = orderData.keycrm_order_id;
  if (keycrmOrderId == null || keycrmOrderId === '') throw new HttpError(409, 'Замовлення ще не передано в KeyCRM');

  let result;
  try {
    result = await keycrmRequest(key, `/order/${encodeURIComponent(keycrmOrderId)}?include=shipping.deliveryService,shipping.lastHistory`);
  } catch (error) {
    if (error.status !== 404) {
      if (error.status === 401) throw new HttpError(401, 'Невірний API-ключ KeyCRM, перевірте Налаштування');
      throw error;
    }
    await orderRef.update({
      tracking_synced_at: FieldValue.serverTimestamp(),
      tracking_sync_status: 'not_found',
      tracking_sync_error: 'keycrm_order_not_found'
    });
    return { notFound: true, tracking_number: String(orderData.tracking_number || orderData.ttn || ''), tracking_synced_at: new Date().toISOString() };
  }

  const fields = keycrmShippingFields(result.body);
  const existingTracking = String(orderData.tracking_number || orderData.ttn || '').trim();
  const changed = !!fields.trackingNumber && fields.trackingNumber !== existingTracking;
  const update = {
    tracking_synced_at: FieldValue.serverTimestamp(),
    tracking_sync_status: fields.trackingNumber || existingTracking ? 'synced' : 'pending',
    tracking_sync_error: FieldValue.delete()
  };
  if (changed) {
    update.tracking_number = fields.trackingNumber;
    if (fields.shippingService) update.shipping_service = fields.shippingService;
    if (fields.shippedAt) update.shipped_at = fields.shippedAt;
    if (fields.city) update.shipping_city = fields.city;
    if (fields.point) update.shipping_point = fields.point;
  }
  await orderRef.update(update);
  return {
    changed,
    hasTrackingNumber: !!(fields.trackingNumber || existingTracking),
    tracking_number: fields.trackingNumber || existingTracking,
    shipping_service: changed ? (fields.shippingService || orderData.shipping_service || '') : (orderData.shipping_service || ''),
    shipped_at: changed ? (fields.shippedAt || orderData.shipped_at || '') : (orderData.shipped_at || ''),
    shipping_city: changed ? (fields.city || orderData.shipping_city || '') : (orderData.shipping_city || ''),
    shipping_point: changed ? (fields.point || orderData.shipping_point || '') : (orderData.shipping_point || ''),
    tracking_synced_at: new Date().toISOString()
  };
}

async function syncOrderTrackingManually(res, orderId) {
  const orderRef = db.collection('orders').doc(orderId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) throw new HttpError(404, 'Замовлення не знайдено на сайті');
  const order = snapshot.data();
  if (order.keycrm_order_id == null || order.keycrm_order_id === '') throw new HttpError(409, 'Замовлення ще не передано в KeyCRM');
  const result = await syncOrderTracking(orderRef, order, await currentKey());
  if (result.notFound) return res.status(404).json({ error: 'Замовлення не знайдено в KeyCRM', ...result });
  return res.json(result);
}

exports.syncKeycrmTracking = onSchedule({
  schedule: 'every 20 minutes',
  region: 'us-central1',
  timeoutSeconds: 120,
  maxInstances: 1
}, async () => {
  const key = await currentKey();
  const snapshot = await db.collection('orders').where('keycrm_order_id', '!=', null).get();
  const now = Date.now();
  const candidates = snapshot.docs
    .map(orderDoc => ({ ref: orderDoc.ref, data: orderDoc.data() }))
    .filter(order => String(order.data.keycrm_order_id || '').trim())
    .filter(order => !String(order.data.tracking_number || order.data.ttn || '').trim())
    .filter(order => {
      const attemptedAt = asDate(order.data.tracking_synced_at);
      return order.data.tracking_sync_status !== 'not_found' || !attemptedAt || now - attemptedAt.getTime() >= 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => (asDate(a.data.tracking_synced_at)?.getTime() || 0) - (asDate(b.data.tracking_synced_at)?.getTime() || 0))
    .slice(0, 20);

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      await syncOrderTracking(candidate.ref, candidate.data, key);
    } catch (error) {
      console.error('KeyCRM tracking sync failed:', JSON.stringify({ orderId: candidate.ref.id, keycrmOrderId: candidate.data.keycrm_order_id, status: error.status || 500, message: error.message }));
      await candidate.ref.update({
        tracking_synced_at: FieldValue.serverTimestamp(),
        tracking_sync_status: 'error',
        tracking_sync_error: String(error.message || 'KeyCRM sync failed').slice(0, 300)
      }).catch(updateError => console.error('Failed to record KeyCRM tracking sync error:', updateError.message));
      if (error.status === 401) break;
    }
    if (index < candidates.length - 1) await new Promise(resolve => setTimeout(resolve, 600));
  }
  console.log('KeyCRM tracking sync batch complete:', JSON.stringify({ selected: candidates.length }));
});

// ===== Резерви =====

/* Створює резерви для позицій замовлення в одній транзакції.
   createOrder=true — замовлення ще не існує (публічне оформлення),
   createOrder=false — повторне відкриття скасованого замовлення. */
async function reserveOrderItems(orderRef, orderData, { createOrder }) {
  const items = Array.isArray(orderData.items) ? orderData.items : [];
  if (!items.length) throw new HttpError(422, 'У замовленні немає товарів');
  const wanted = new Map();
  items.forEach(item => {
    const sku = normSku(item.sku || item.article || item.articul || item.vendorCode || item.id || '');
    const qty = Number(item.qty ?? item.quantity) || 0;
    if (!sku) throw new HttpError(422, 'У позиції «' + (item.name || 'невідомий товар') + '» не вказано артикул');
    if (!(qty > 0)) throw new HttpError(422, 'Некоректна кількість товару: ' + (item.name || sku));
    const entry = wanted.get(sku) || { qty: 0, name: item.name || item.title || sku };
    entry.qty += qty;
    wanted.set(sku, entry);
  });

  const productMap = new Map();
  (await db.collection('products').get()).docs.forEach(doc => {
    const sku = normSku(productSku(doc.data()) || '');
    if (sku && !productMap.has(sku)) productMap.set(sku, doc);
  });

  return db.runTransaction(async transaction => {
    if (!createOrder) {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) throw new HttpError(404, 'Замовлення не знайдено');
      if (orderSnap.get('reservationState') === 'active') throw new HttpError(409, 'Резерв для цього замовлення вже активний');
    }
    const activeSnap = await transaction.get(db.collection('stock_reservations').where('status', '==', 'active'));
    const reservedBySku = new Map();
    activeSnap.docs.forEach(doc => {
      const sku = normSku(doc.get('sku'));
      if (!sku) return;
      reservedBySku.set(sku, (reservedBySku.get(sku) || 0) + (Number(doc.get('quantity')) || 0));
    });

    const now = new Date();
    const shortages = [];
    const plans = [];
    for (const [sku, entry] of wanted) {
      const productDoc = productMap.get(sku);
      if (!productDoc) { shortages.push('Товар «' + entry.name + '» (артикул ' + sku + ') не знайдено на складі'); continue; }
      const product = productDoc.data();
      const stockTotal = Number(product.stock_total != null ? product.stock_total : (product.stock ?? product.quantity ?? 0));
      const reserved = reservedBySku.get(sku) || 0;
      const available = stockTotal - reserved;
      if (available < entry.qty) shortages.push('«' + entry.name + '»: доступно ' + Math.max(0, available) + ', потрібно ' + entry.qty);
      else plans.push({ sku, entry, productDoc, available });
    }
    if (shortages.length) throw new HttpError(409, 'Недостатньо товару на складі: ' + shortages.join('; '));

    for (const plan of plans) {
      const product = plan.productDoc.data();
      const nextAvailable = plan.available - plan.entry.qty;
      transaction.update(plan.productDoc.ref, Object.assign({ stock: nextAvailable }, product.inStock !== undefined ? { inStock: nextAvailable > 0 } : {}));
      const reservationRef = db.collection('stock_reservations').doc();
      transaction.set(reservationRef, {
        orderId: orderRef.id,
        productId: plan.productDoc.id,
        sku: plan.sku,
        quantity: plan.entry.qty,
        status: 'active',
        createdAt: now,
        releasedAt: null,
        reason: createOrder ? 'Замовлення з сайту' : 'Повторне відкриття замовлення',
        site: String(orderData.site || SITE_MAIN)
      });
      transaction.set(db.collection('stock_log').doc(), { at: now, productId: plan.productDoc.id, sku: plan.sku, change: 0, reservedChange: plan.entry.qty, reason: createOrder ? 'Створено резерв за замовленням' : 'Резерв відновлено (замовлення повернуто в роботу)', orderId: orderRef.id, source: 'order' });
    }

    const orderPayload = Object.assign({}, orderData, { reservationState: 'active', reservationCreatedAt: now });
    if (createOrder) transaction.set(orderRef, orderPayload);
    else transaction.update(orderRef, { reservationState: 'active', reservationCreatedAt: now, reservationReleasedAt: FieldValue.delete() });
    return { reserved: plans.length };
  });
}

/* Знімає резерви замовлення. restoreStock=true — товар повертається в available
   (скасування); false — залишки не чіпаємо (списання в KeyCRM). */
async function releaseOrderReservations(orderId, targetStatus, reason, { restoreStock, skipOrderUpdate } = {}) {
  const now = new Date();
  return db.runTransaction(async transaction => {
    const activeSnap = await transaction.get(db.collection('stock_reservations').where('orderId', '==', orderId).where('status', '==', 'active'));
    const soldSnap = await transaction.get(db.collection('stock_reservations').where('orderId', '==', orderId).where('status', '==', 'released_sold'));
    if (!activeSnap.size) return { released: 0, alreadySold: soldSnap.size > 0, nothing: soldSnap.size === 0 };
    for (const doc of activeSnap.docs) {
      const reservation = doc.data();
      transaction.update(doc.ref, { status: targetStatus, releasedAt: now, reason });
      if (restoreStock && reservation.productId) {
        const productRef = db.collection('products').doc(String(reservation.productId));
        const productSnap = await transaction.get(productRef);
        if (productSnap.exists) {
          const product = productSnap.data();
          const stockTotal = Number(product.stock_total != null ? product.stock_total : (product.stock ?? 0));
          const nextAvailable = stockTotal + (Number(reservation.quantity) || 0);
          transaction.update(productRef, Object.assign({ stock: nextAvailable }, product.inStock !== undefined ? { inStock: nextAvailable > 0 } : {}));
        }
      }
      transaction.set(db.collection('stock_log').doc(), { at: now, productId: reservation.productId || '', sku: reservation.sku || '', change: 0, reservedChange: -(Number(reservation.quantity) || 0), reason, orderId, source: 'order' });
    }
    // skipOrderUpdate — замовлення видалено з бази, не відтворюємо його документ.
    if (!skipOrderUpdate) transaction.set(db.doc('orders/' + orderId), { reservationState: targetStatus === 'released_sold' ? 'sold' : 'released', reservationReleasedAt: now }, { merge: true });
    return { released: activeSnap.size, alreadySold: false, nothing: false };
  });
}

/* ===== Автоматичний резерв для БУДЬ-ЯКОГО нового замовлення в orders =====
   Використовується тригером onCreate (замовлення другого сайту) та міграцією.
   Ідемпотентність: резерви мають детермінований id {orderId}_{sku}; якщо для
   замовлення вже є хоч один резерв (створений кодом основного сайту) — нічого не дублюється. */
const reservationDocId = (orderId, sku) => String(orderId) + '_' + String(sku).replace(/[\/\s]+/g, '_');

/* Визначає сайт за даними замовлення. Явне поле site/джерело має пріоритет;
   інакше: замовлення, що прийшло вже з резервом (код основного сайту) → основний,
   без резерву → другий сайт (inferred=true). */
function detectOrderSite(order, hasReservations) {
  const explicit = String(order.site || '').trim();
  const hints = [order.siteId, order.source, order.origin, order.host, order.hostname, order.domain, order.siteUrl, order.site_url, order.url, order.referrer, order.shop, order.store]
    .map(value => (typeof value === 'string' ? value : '')).join(' ');
  const probe = (explicit + ' ' + hints).toLowerCase();
  if (/snack-?latiao/.test(probe)) return { site: SITE_SECOND, inferred: false };
  if (/latiao-?snack/.test(probe)) return { site: SITE_MAIN, inferred: false };
  if (explicit) return { site: explicit, inferred: false };
  if (hasReservations || order.reservationState === 'active') return { site: SITE_MAIN, inferred: true };
  return { site: SITE_SECOND, inferred: true };
}

async function ensureOrderReservations(orderId, { touchProductStock = true, reason = 'Замовлення з сайту (автоматичний резерв)' } = {}) {
  const orderRef = db.collection('orders').doc(orderId);
  const productMap = new Map();
  const productById = new Map();
  (await db.collection('products').get()).docs.forEach(doc => {
    productById.set(doc.id, doc);
    const sku = normSku(productSku(doc.data()) || '');
    if (sku && !productMap.has(sku)) productMap.set(sku, doc);
  });

  return db.runTransaction(async transaction => {
    // --- Усі читання ---
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return { status: 'missing' };
    const order = orderSnap.data();
    const existingSnap = await transaction.get(db.collection('stock_reservations').where('orderId', '==', orderId));
    const siteInfo = detectOrderSite(order, !existingSnap.empty);
    const now = new Date();

    // Резерв уже є (основний сайт/попередній запуск) або замовлення знято/списано — не дублюємо.
    if (!existingSnap.empty || ['sold', 'released'].includes(String(order.reservationState || ''))) {
      existingSnap.docs.forEach(doc => { if (!doc.get('site')) transaction.update(doc.ref, { site: siteInfo.site }); });
      if (!order.site) transaction.set(orderRef, { site: siteInfo.site, siteInferred: siteInfo.inferred }, { merge: true });
      return { status: 'already_reserved', site: siteInfo.site, reservations: existingSnap.size };
    }

    const activeSnap = await transaction.get(db.collection('stock_reservations').where('status', '==', 'active'));
    const reservedBySku = new Map();
    activeSnap.docs.forEach(doc => {
      const sku = normSku(doc.get('sku'));
      if (sku) reservedBySku.set(sku, (reservedBySku.get(sku) || 0) + (Number(doc.get('quantity')) || 0));
    });

    // --- Розбір позицій (без винятків: проблеми збираємо в список) ---
    const problems = [];
    const wanted = new Map();
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) problems.push('У замовленні немає товарів');
    items.forEach(item => {
      const label = item.name || item.title || 'невідомий товар';
      let sku = normSku(item.sku || item.article || item.articul || item.vendorCode || item.id || '');
      if (!sku || !productMap.has(sku)) {
        const byDocId = productById.get(String(item.productId || item.id || ''));
        if (byDocId) sku = normSku(productSku(byDocId.data()) || '') || sku;
      }
      const qty = Number(item.qty ?? item.quantity) || 0;
      if (!sku) { problems.push('У позиції «' + label + '» не вказано артикул'); return; }
      if (!(qty > 0)) { problems.push('Некоректна кількість товару: ' + label); return; }
      const entry = wanted.get(sku) || { qty: 0, name: label };
      entry.qty += qty;
      wanted.set(sku, entry);
    });
    const productRefs = [];
    wanted.forEach((entry, sku) => {
      const productDoc = productMap.get(sku);
      if (!productDoc) problems.push('Товар «' + entry.name + '» (артикул ' + sku + ') не знайдено на складі');
      else productRefs.push(productDoc.ref);
    });
    const freshProducts = new Map();
    if (productRefs.length) (await transaction.getAll(...productRefs)).forEach(snap => freshProducts.set(snap.id, snap));

    const plans = [];
    wanted.forEach((entry, sku) => {
      const productDoc = productMap.get(sku);
      const fresh = productDoc && freshProducts.get(productDoc.id);
      if (!fresh || !fresh.exists) return;
      const product = fresh.data();
      const stockTotal = Number(product.stock_total != null ? product.stock_total : (product.stock ?? product.quantity ?? 0));
      const available = stockTotal - (reservedBySku.get(sku) || 0);
      if (available < entry.qty) problems.push('«' + entry.name + '»: доступно ' + Math.max(0, available) + ', потрібно ' + entry.qty);
      else plans.push({ sku, entry, ref: fresh.ref, productId: fresh.id, product, available });
    });

    // --- Записи ---
    if (problems.length) {
      // Залишок не чіпаємо (без від'ємних значень), замовлення не губимо — позначаємо «потребує уваги».
      transaction.set(orderRef, { site: siteInfo.site, siteInferred: siteInfo.inferred, needsAttention: true, needsAttentionReason: problems.join('; '), needsAttentionAt: now }, { merge: true });
      transaction.set(db.collection('stock_log').doc(), { at: now, productId: '', sku: '', change: 0, reservedChange: 0, reason: 'Резерв не створено — замовлення потребує уваги: ' + problems.join('; '), orderId, source: 'order', site: siteInfo.site });
      return { status: 'needs_attention', site: siteInfo.site, problems };
    }
    for (const plan of plans) {
      const nextAvailable = plan.available - plan.entry.qty;
      if (touchProductStock) transaction.update(plan.ref, Object.assign({ stock: nextAvailable }, plan.product.inStock !== undefined ? { inStock: nextAvailable > 0 } : {}));
      transaction.set(db.collection('stock_reservations').doc(reservationDocId(orderId, plan.sku)), {
        orderId,
        productId: plan.productId,
        sku: plan.sku,
        quantity: plan.entry.qty,
        status: 'active',
        createdAt: now,
        releasedAt: null,
        reason,
        site: siteInfo.site,
        siteInferred: siteInfo.inferred
      });
      transaction.set(db.collection('stock_log').doc(), { at: now, productId: plan.productId, sku: plan.sku, change: 0, reservedChange: plan.entry.qty, reason: 'Створено резерв за замовленням (' + siteInfo.site + ')', orderId, source: 'order', site: siteInfo.site });
    }
    transaction.set(orderRef, {
      site: siteInfo.site,
      siteInferred: siteInfo.inferred,
      reservationState: 'active',
      reservationCreatedAt: now,
      needsAttention: FieldValue.delete(),
      needsAttentionReason: FieldValue.delete(),
      needsAttentionAt: FieldValue.delete()
    }, { merge: true });
    return { status: 'reserved', site: siteInfo.site, reserved: plans.length };
  });
}

/* Замовлення без резерву, які ще актуальні (не доставлені/скасовані/списані в KeyCRM). */
async function findOrdersWithoutReservation() {
  const settings = await loadStockSettings();
  const [ordersSnap, reservationsSnap] = await Promise.all([db.collection('orders').get(), db.collection('stock_reservations').get()]);
  const reservedOrders = new Set(reservationsSnap.docs.map(doc => String(doc.get('orderId') || '')));
  const norm = value => String(value || '').trim().toLowerCase();
  const isFinalStatus = status => settings.cancelStatuses.some(item => norm(item) === norm(status)) || /виконан|доставлен|отриман|delivered|completed|received/i.test(String(status || ''));
  const candidates = [];
  const excluded = [];
  ordersSnap.docs.forEach(doc => {
    if (reservedOrders.has(doc.id)) return;
    const order = doc.data();
    const row = {
      orderId: doc.id,
      orderNumber: order.id || doc.id,
      name: order.name || '',
      status: order.status || '',
      createdAt: asDate(order.createdAt || order.date)?.toISOString() || null,
      site: detectOrderSite(order, false).site,
      keycrmOrderId: order.keycrm_order_id || null,
      items: (Array.isArray(order.items) ? order.items : []).map(item => ({ sku: item.sku || item.article || item.articul || item.vendorCode || item.id || '', qty: Number(item.qty ?? item.quantity) || 0 }))
    };
    if (['sold', 'released'].includes(String(order.reservationState || ''))) { excluded.push({ ...row, reason: 'Резерв уже знято/списано' }); return; }
    if (isFinalStatus(order.status)) { excluded.push({ ...row, reason: 'Доставлене/скасоване (статус: ' + (order.status || '—') + ')' }); return; }
    candidates.push(row);
  });
  // Перевірка списання в KeyCRM (лише для замовлень, переданих у KeyCRM).
  const withCrm = candidates.filter(row => row.keycrmOrderId != null && String(row.keycrmOrderId).trim());
  if (withCrm.length && settings.apiKey && settings.deductStatusIds.length) {
    try {
      const statuses = await fetchKeycrmOrderStatuses(settings.apiKey, withCrm.map(row => String(row.keycrmOrderId)));
      const deductSet = new Set(settings.deductStatusIds.map(String));
      withCrm.forEach(row => {
        const statusId = statuses.get(String(row.keycrmOrderId));
        if (statusId != null && deductSet.has(String(statusId))) row.writtenOff = true;
      });
    } catch (error) {
      console.error('Migration: KeyCRM status check failed:', error.message);
    }
  }
  return {
    candidates: candidates.filter(row => !row.writtenOff),
    excluded: excluded.concat(candidates.filter(row => row.writtenOff).map(row => ({ ...row, reason: 'Списано в KeyCRM' })))
  };
}

/* Тригер: будь-яке нове замовлення в orders (з будь-якого сайту) автоматично потрапляє в резерв. */
exports.reserveNewOrder = onDocumentCreated({ document: 'orders/{orderId}', region: 'europe-west1' }, async event => {
  const orderId = event.params.orderId;
  try {
    const result = await ensureOrderReservations(orderId);
    console.log('reserveNewOrder:', JSON.stringify({ orderId, ...result }));
  } catch (error) {
    console.error('reserveNewOrder failed:', JSON.stringify({ orderId, message: error.message }));
    try {
      await db.doc('orders/' + orderId).set({ needsAttention: true, needsAttentionReason: 'Помилка автоматичного резерву: ' + error.message, needsAttentionAt: new Date() }, { merge: true });
    } catch (markError) {
      console.error('reserveNewOrder: cannot mark order:', markError.message);
    }
  }
});

/* Тригер: замовлення видалено з бази → його активні резерви анулюються,
   залишок повертається в available (без відтворення документа замовлення). */
exports.releaseDeletedOrderReservations = onDocumentDeleted({ document: 'orders/{orderId}', region: 'europe-west1' }, async event => {
  const orderId = event.params.orderId;
  try {
    const result = await releaseOrderReservations(orderId, 'released_cancelled', 'Замовлення видалено з бази — резерв анульовано', { restoreStock: true, skipOrderUpdate: true });
    console.log('releaseDeletedOrderReservations:', JSON.stringify({ orderId, ...result }));
  } catch (error) {
    console.error('releaseDeletedOrderReservations failed:', JSON.stringify({ orderId, message: error.message }));
  }
});

/* Публічне створення замовлення з сайту з резервуванням (без адмін-авторизації). */
async function createPublicOrder(req, res) {
  const order = req.body && typeof req.body === 'object' ? req.body : {};
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) throw new HttpError(422, 'У замовленні немає товарів');
  if (!String(order.name || order.fullName || '').trim()) throw new HttpError(422, 'Вкажіть ім’я покупця');
  if (!String(order.phone || order.customerPhone || '').trim() && !String(order.email || order.customerEmail || '').trim()) throw new HttpError(422, 'Вкажіть телефон або email покупця');
  const phoneDigits = String(order.phone || '').replace(/\D/g, '').replace(/^380/, '');
  const orderRef = db.collection('orders').doc();
  const orderData = Object.assign({}, order, { phoneDigits, createdAt: FieldValue.serverTimestamp(), reservationState: 'active', site: String(order.site || SITE_MAIN) });
  await reserveOrderItems(orderRef, orderData, { createOrder: true });
  return res.status(201).json({ id: orderRef.id });
}

/* Зміна статусу замовлення в адмінці: скасування / повторне відкриття. */
async function applyOrderStatus(req, res, orderId) {
  const status = String(req.body?.status || '').trim();
  if (!status) throw new HttpError(422, 'Не вказано статус');
  const settings = await loadStockSettings();
  const orderRef = db.collection('orders').doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpError(404, 'Замовлення не знайдено');
  const order = orderSnap.data();
  const normalize = value => String(value || '').trim().toLowerCase();
  const isCancel = settings.cancelStatuses.some(item => normalize(item) === normalize(status));
  const wasCancel = settings.cancelStatuses.some(item => normalize(item) === normalize(order.status));
  await orderRef.update({ status, statusUpdatedAt: FieldValue.serverTimestamp() });
  if (isCancel) {
    const result = await releaseOrderReservations(orderId, 'released_cancelled', 'Скасовано в адмін-панелі (статус: ' + status + ')', { restoreStock: true });
    if (result.alreadySold) return res.json({ status, reservationState: 'sold', warning: 'Товар уже списаний у KeyCRM, зробіть повернення там. Залишок підтягнеться синхронізацією.' });
    return res.json({ status, reservationState: result.released ? 'released' : String(order.reservationState || ''), released: result.released });
  }
  if (wasCancel) {
    try {
      await reserveOrderItems(orderRef, order, { createOrder: false });
      return res.json({ status, reservationState: 'active', reserved: true });
    } catch (error) {
      if (error.status === 409) return res.status(409).json({ error: error.message, status, reservationState: String(order.reservationState || 'released') });
      throw error;
    }
  }
  return res.json({ status, reservationState: String(order.reservationState || '') });
}

async function route(req, res) {
  await requireAuth(req);
  const path = req.path.replace(/^\/api\/admin(?=\/|$)/, '').replace(/\/$/, '') || '/';

  if (path === '/settings/keycrm' && req.method === 'GET') {
    const settings = await loadStockSettings();
    return res.json({
      apiKeyConfigured: !!settings.apiKey,
      autoSync: settings.autoSync,
      intervalMinutes: settings.intervalMinutes,
      deductStatusIds: settings.deductStatusIds,
      cancelStatuses: settings.cancelStatuses,
      autoReleaseUnpaid: settings.autoReleaseUnpaid,
      unpaidTimeoutHours: settings.unpaidTimeoutHours,
      lastSync: settings.lastSync
    });
  }
  if (path === '/settings/keycrm' && req.method === 'PUT') {
    const data = {
      autoSync: !!req.body?.autoSync,
      intervalMinutes: Math.max(1, Number.parseInt(req.body?.intervalMinutes, 10) || 10),
      deductStatusIds: Array.isArray(req.body?.deductStatusIds) ? req.body.deductStatusIds.map(String).filter(Boolean) : [],
      cancelStatuses: Array.isArray(req.body?.cancelStatuses) && req.body.cancelStatuses.length ? req.body.cancelStatuses.map(String).map(item => item.trim()).filter(Boolean) : DEFAULT_CANCEL_STATUSES,
      autoReleaseUnpaid: !!req.body?.autoReleaseUnpaid,
      unpaidTimeoutHours: Math.max(1, Number.parseInt(req.body?.unpaidTimeoutHours, 10) || 48),
      updatedAt: FieldValue.serverTimestamp()
    };
    const newKey = String(req.body?.apiKey || '').trim();
    if (newKey) data.apiKey = newKey;
    await db.doc('settings/keycrm').set(data, { merge: true });
    const settings = await loadStockSettings();
    return res.json({
      apiKeyConfigured: !!settings.apiKey,
      autoSync: settings.autoSync,
      intervalMinutes: settings.intervalMinutes,
      deductStatusIds: settings.deductStatusIds,
      cancelStatuses: settings.cancelStatuses,
      autoReleaseUnpaid: settings.autoReleaseUnpaid,
      unpaidTimeoutHours: settings.unpaidTimeoutHours,
      lastSync: settings.lastSync
    });
  }
  if (path === '/keycrm/statuses' && req.method === 'GET') {
    const key = await currentKey();
    const statuses = [];
    for (let page = 1; page <= 20; page++) {
      const result = await keycrmRequest(key, `/order/status?limit=50&page=${page}`);
      const rows = Array.isArray(result.body?.data) ? result.body.data : (Array.isArray(result.body) ? result.body : []);
      rows.forEach(row => {
        const id = row?.id ?? row?.status_id;
        const name = row?.name || row?.title || row?.status_name || (id != null ? String(id) : null);
        if (id != null && name) statuses.push({ id: String(id), name: String(name) });
      });
      if (!rows.length || !result.body?.next_page_url) break;
    }
    return res.json({ statuses });
  }
  if (path === '/stock/orders-without-reservation' && req.method === 'GET') {
    return res.json(await findOrdersWithoutReservation());
  }
  if (path === '/stock/migrate-reservations' && req.method === 'POST') {
    // Міграція лише за явним підтвердженням: резерв + журнал, залишки товарів НЕ змінюються
    // (наступна синхронізація з KeyCRM сама перерахує доступний залишок).
    const orderIds = Array.isArray(req.body?.orderIds) ? [...new Set(req.body.orderIds.map(String).filter(Boolean))].slice(0, 100) : [];
    if (!orderIds.length) throw new HttpError(422, 'Не вибрано жодного замовлення');
    const results = [];
    for (const orderId of orderIds) {
      try {
        results.push({ orderId, ...(await ensureOrderReservations(orderId, { touchProductStock: false, reason: 'Міграція: замовлення без резерву' })) });
      } catch (error) {
        results.push({ orderId, status: 'error', message: error.message });
      }
    }
    return res.json({ results });
  }
  if (path === '/stock/reservations' && req.method === 'GET') {
    // orderId → усі резерви замовлення (будь-який статус); інакше — лише активні.
    let queryRef = req.query.orderId
      ? db.collection('stock_reservations').where('orderId', '==', String(req.query.orderId))
      : db.collection('stock_reservations').where('status', '==', 'active');
    if (req.query.productId) queryRef = queryRef.where('productId', '==', String(req.query.productId));
    const snap = await queryRef.get();
    const reservations = snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: asDate(doc.get('createdAt'))?.toISOString() || null }));
    const orderIds = [...new Set(reservations.map(reservation => String(reservation.orderId || '')).filter(Boolean))];
    const orders = {};
    await Promise.all(orderIds.map(async orderId => {
      const orderSnap = await db.collection('orders').doc(orderId).get().catch(() => null);
      if (orderSnap?.exists) orders[orderId] = { orderNumber: orderSnap.get('id') || orderId, name: orderSnap.get('name') || '', status: orderSnap.get('status') || '', keycrm_order_id: orderSnap.get('keycrm_order_id') || null, site: orderSnap.get('site') || null, needsAttention: !!orderSnap.get('needsAttention') };
    }));
    return res.json({ reservations: reservations.map(reservation => ({ ...reservation, order: orders[reservation.orderId] || null })) });
  }
  if (path === '/stock/log' && req.method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const snap = await db.collection('stock_log').orderBy('at', 'desc').limit(limit).get();
    return res.json({ entries: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), at: asDate(doc.get('at'))?.toISOString() || null })) });
  }
  if (path === '/keycrm/test' && req.method === 'POST') {
    const key = await currentKey();
    const result = await keycrmStocks(key, 1, 1);
    return res.json({ connected: true, total: result.body?.total ?? null });
  }
  if (path === '/keycrm/sync-stocks' && req.method === 'POST') return syncStocks(res);

  const orderMatch = /^\/orders\/([^/]+)\/send-to-keycrm$/.exec(path);
  if (orderMatch && req.method === 'POST') return transferOrder(req, res, decodeURIComponent(orderMatch[1]));
  const trackingMatch = /^\/orders\/([^/]+)\/sync-tracking$/.exec(path);
  if (trackingMatch && req.method === 'POST') return syncOrderTrackingManually(res, decodeURIComponent(trackingMatch[1]));
  const statusMatch = /^\/orders\/([^/]+)\/apply-status$/.exec(path);
  if (statusMatch && req.method === 'POST') return applyOrderStatus(req, res, decodeURIComponent(statusMatch[1]));
  const releaseMatch = /^\/orders\/([^/]+)\/release-reservation$/.exec(path);
  if (releaseMatch && req.method === 'POST') {
    const orderId = decodeURIComponent(releaseMatch[1]);
    const reason = String(req.body?.reason || 'Знято резерв вручну в адмін-панелі');
    const result = await releaseOrderReservations(orderId, 'released_cancelled', reason, { restoreStock: true });
    if (result.alreadySold) return res.json({ released: 0, reservationState: 'sold', warning: 'Товар уже списаний у KeyCRM, зробіть повернення там. Залишок підтягнеться синхронізацією.' });
    if (result.nothing) throw new HttpError(409, 'У цього замовлення немає активного резерву');
    return res.json({ released: result.released, reservationState: 'released' });
  }
  const reserveMatch = /^\/orders\/([^/]+)\/re-reserve$/.exec(path);
  if (reserveMatch && req.method === 'POST') {
    const orderId = decodeURIComponent(reserveMatch[1]);
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new HttpError(404, 'Замовлення не знайдено');
    await reserveOrderItems(orderRef, orderSnap.data(), { createOrder: false });
    return res.json({ reservationState: 'active', reserved: true });
  }
  throw new HttpError(404, 'Endpoint не знайдено');
}

exports.adminApi = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Публічне оформлення замовлення з сайту: авторизація не потрібна.
  if (req.path === '/api/orders' && req.method === 'POST') {
    try {
      await createPublicOrder(req, res);
    } catch (error) {
      sendError(res, error);
    }
    return;
  }
  try {
    await route(req, res);
  } catch (error) {
    sendError(res, error);
  }
});

// Розклад синхронізації залишків: інтервал береться з Налаштувань.
exports.syncKeycrmStocks = onSchedule({
  schedule: 'every 5 minutes',
  region: 'us-central1',
  timeoutSeconds: 540,
  maxInstances: 1
}, async () => {
  const settings = await loadStockSettings();
  if (!settings.autoSync || !settings.apiKey) return;
  const lastOkAt = settings.lastSync && settings.lastSync.ok ? (asDate(settings.lastSync.at)?.getTime() || 0) : 0;
  if (lastOkAt && Date.now() - lastOkAt < settings.intervalMinutes * 60 * 1000 - 30000) return;
  try {
    const result = await runStockSync();
    console.log('KeyCRM stock sync complete:', JSON.stringify({ updated: result.updated, released: result.released, mismatches: result.mismatches }));
  } catch (error) {
    console.error('KeyCRM stock sync failed:', error.message);
    return; // помилка API: залишки не змінено, наступний запуск повторить спробу
  }
  // Опційне автоматичне зняття резерву за таймаутом для неоплачених замовлень.
  if (!settings.autoReleaseUnpaid) return;
  const timeoutMs = settings.unpaidTimeoutHours * 60 * 60 * 1000;
  const snapshot = await db.collection('orders').where('reservationState', '==', 'active').get();
  const now = Date.now();
  for (const orderDoc of snapshot.docs) {
    const order = orderDoc.data();
    const createdAt = asDate(order.createdAt)?.getTime() || 0;
    if (!createdAt || now - createdAt < timeoutMs) continue;
    const status = String(order.paymentStatus || order.status || '');
    if (/оплачен|paid|виконан|відправлен/i.test(status) || order.paid === true) continue;
    try {
      await releaseOrderReservations(orderDoc.id, 'released_cancelled', 'Автоматичне зняття резерву: неоплачене замовлення (таймаут ' + settings.unpaidTimeoutHours + ' год)', { restoreStock: true });
      console.log('Auto-released reservation for unpaid order:', orderDoc.id);
    } catch (error) {
      console.error('Auto-release failed:', JSON.stringify({ orderId: orderDoc.id, message: error.message }));
    }
  }
});
