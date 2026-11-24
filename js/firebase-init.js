/* js/firebase-init.js — єдине місце ініціалізації Firebase для всього сайту.
   Усі сторінки читають товари/категорії/замовлення і записують дані
   ТІЛЬКИ в цей проєкт Firestore: latiao-snack.
   Використовується як ES-модуль:
     import { db, auth, ensureAuth } from './js/firebase-init.js';
   Або динамічно зі звичайних скриптів:
     import('./js/firebase-init.js').then(m => m.db) */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs,
  addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, writeBatch, serverTimestamp, onSnapshot, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Your web app's Firebase configuration (latiao-snack)
const firebaseConfig = {
  apiKey: "AIzaSyCJ71TSX4VcvB_-mSy7V7Cp8H83YvsNdlQ",
  authDomain: "latiao-snack.firebaseapp.com",
  projectId: "latiao-snack",
  storageBucket: "latiao-snack.firebasestorage.app",
  messagingSenderId: "6960322548",
  appId: "1:6960322548:web:cd6b9e51e3fd4f14e00ba1"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/* Забезпечує anonymous-сесію (потрібна для запису за правилами Firestore). */
export async function ensureAuth() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

/* Зручний запис замовлення в колекцію "orders".
   phoneDigits — для пошуку постійного клієнта (LatiaoCustomers.findByPhone).
   Замовлення створюється разом із резервом залишку (захист від перепродажу):
   спершу бекенд-endpoint /api/orders, за його відсутності — клієнтська
   транзакція Firestore (той самий алгоритм резервування). */
export async function saveOrder(order) {
  await ensureAuth();
  const phoneDigits = String(order.phone || '').replace(/\D/g, '').replace(/^380/, '');
  const orderData = Object.assign({}, order, { phoneDigits: phoneDigits, site: order.site || 'latiao-snack' });

  // Спроба 1: бекенд (надійніше, резерв у транзакції на сервері).
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(orderData)
    });
    let result = {};
    try { result = await response.json(); } catch { }
    if (response.ok && result.id) return result.id;
    if (response.status === 409) throw new Error(result.error || 'Недостатньо товару на складі');
    if (response.status === 422) throw new Error(result.error || 'Некоректні дані замовлення');
    if (response.status >= 500) throw new Error('Помилка сервера, спробуйте пізніше');
    throw new Error(result.error || result.message || 'Не вдалося створити замовлення');
  } catch (error) {
    // Мережева помилка / endpoint недоступний → fallback на клієнтську транзакцію.
    if (!(error instanceof TypeError) && !/Failed to fetch|NetworkError|load failed/i.test(String(error.message))) throw error;
  }

  // Спроба 2: клієнтська транзакція — перевірка available і створення резерву.
  const products = await getDocs(collection(db, 'products'));
  const bySku = new Map();
  const normSku = value => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  products.docs.forEach(product => {
    const data = product.data();
    const sku = ['article', 'articul', 'sku', 'vendorCode', 'productCode', 'code', 'артикул']
      .map(key => data[key]).find(value => value != null && String(value).trim());
    if (sku) bySku.set(normSku(sku), product);
  });
  const wanted = new Map();
  (Array.isArray(order.items) ? order.items : []).forEach(item => {
    const sku = normSku(item.sku || item.article || item.articul || item.vendorCode || item.id || '');
    const qty = Number(item.qty ?? item.quantity) || 0;
    if (!sku) throw new Error('У позиції «' + (item.name || 'невідомий товар') + '» не вказано артикул');
    if (!(qty > 0)) throw new Error('Некоректна кількість товару: ' + (item.name || sku));
    const entry = wanted.get(sku) || { qty: 0, name: item.name || item.title || sku };
    entry.qty += qty;
    wanted.set(sku, entry);
  });
  if (!wanted.size) throw new Error('У замовленні немає товарів');
  const missing = [];
  wanted.forEach((entry, sku) => { if (!bySku.has(sku)) missing.push('Товар «' + entry.name + '» (артикул ' + sku + ') не знайдено на складі'); });
  if (missing.length) throw new Error(missing.join('; '));

  const orderRef = doc(collection(db, 'orders'));
  await runTransaction(db, async transaction => {
    const activeSnap = await transaction.get(query(collection(db, 'stock_reservations'), where('status', '==', 'active')));
    const reservedBySku = new Map();
    activeSnap.docs.forEach(reservationDoc => {
      const sku = normSku(reservationDoc.get('sku'));
      if (!sku) return;
      reservedBySku.set(sku, (reservedBySku.get(sku) || 0) + (Number(reservationDoc.get('quantity')) || 0));
    });
    const shortages = [];
    const plans = [];
    for (const [sku, entry] of wanted) {
      const productSnap = bySku.get(sku);
      const product = productSnap.data();
      const stockTotal = Number(product.stock_total != null ? product.stock_total : (product.stock ?? product.quantity ?? 0));
      const reserved = reservedBySku.get(sku) || 0;
      const available = stockTotal - reserved;
      if (available < entry.qty) shortages.push('«' + entry.name + '»: доступно ' + Math.max(0, available) + ', потрібно ' + entry.qty);
      else plans.push({ sku, entry, productSnap, available, product });
    }
    if (shortages.length) throw new Error('Недостатньо товару на складі: ' + shortages.join('; '));
    const now = new Date();
    plans.forEach(plan => {
      const nextAvailable = plan.available - plan.entry.qty;
      transaction.update(plan.productSnap.ref, Object.assign({ stock: nextAvailable }, plan.product.inStock !== undefined ? { inStock: nextAvailable > 0 } : {}));
      transaction.set(doc(collection(db, 'stock_reservations')), {
        orderId: orderRef.id,
        productId: plan.productSnap.id,
        sku: plan.sku,
        quantity: plan.entry.qty,
        status: 'active',
        createdAt: now,
        releasedAt: null,
        reason: 'Замовлення з сайту',
        site: orderData.site
      });
    });
    transaction.set(orderRef, Object.assign({}, orderData, { createdAt: serverTimestamp(), reservationState: 'active', reservationCreatedAt: now }));
  });
  return orderRef.id;
}

/* Запит «повідомити про наявність» → колекція "notify". */
export async function saveNotify(entry) {
  await ensureAuth();
  await addDoc(collection(db, 'notify'), Object.assign({}, entry, {
    createdAt: serverTimestamp()
  }));
}

/* Сумісність зі старими скриптами, що шукають window.db / window.firebaseApp */
window.LatiaoFirebase = { app, auth, db, ensureAuth, saveOrder, saveNotify };
window.firebaseApp = window.firebaseApp || app;
window.db = window.db || db;

export { collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, writeBatch, serverTimestamp, onSnapshot, runTransaction };
