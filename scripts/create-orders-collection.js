/* scripts/create-orders-collection.js
   Створює колекцію "orders" у Firestore проєкту latiao-snack,
   якщо її ще немає (Firestore створює колекцію лише після першого запису).
   Використовує OAuth-токен Firebase CLI (~/.config/firebase/token.json).
   Запуск: node scripts/create-orders-collection.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'latiao-snack';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function getToken() {
  const candidates = [
    path.join(os.homedir(), '.config', 'firebase', 'token.json'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'firebase', 'token.json') : null
  ].filter(Boolean);
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf8')).access_token;
    }
  }
  throw new Error('Не знайдено token.json Firebase CLI: ' + candidates.join(' | '));
}

async function main() {
  const token = getToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // 1) Перевіряємо, чи колекція вже існує
  const check = await fetch(`${BASE}/orders`, { headers });
  if (check.status === 200) {
    const body = await check.json();
    console.log(`Колекція "orders" вже існує. Документів: ${body.documents ? body.documents.length : 0}`);
    return;
  }
  if (check.status !== 404) {
    console.error('Неочікувана відповідь при перевірці:', check.status, await check.text());
    process.exit(1);
  }

  // 2) Створюємо колекцію записом seed-документа
  const create = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      documents: [{
        documentId: 'seed',
        fields: {
          __seed: { booleanValue: true },
          note: { stringValue: 'Початковий документ: колекцію orders створено автоматично' },
          createdAt: { serverTimestamp: {} }
        }
      }]
    })
  });
  if (!create.ok) {
    console.error('Помилка створення колекції:', create.status, await create.text());
    process.exit(1);
  }
  console.log('Колекцію "orders" створено в Firestore (latiao-snack).');
}

main().catch(e => { console.error(e); process.exit(1); });
