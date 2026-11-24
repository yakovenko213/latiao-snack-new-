/* Діагностика: останні замовлення з Firestore (без персональних даних).
   Використовує access_token з firebase-tools config. */
const fs = require('fs');
const https = require('https');

const cfg = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.config/configstore/firebase-tools.json', 'utf8'));
const token = cfg.tokens.access_token;
const PROJECT = 'latiao-snack';

function listCollection(col, pageSize = 5) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${col}?pageSize=${pageSize}&orderBy=createdAt%20desc`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(body.slice(0, 500))); }
      });
    }).on('error', reject);
  });
}

function summarize(doc) {
  const f = doc.fields || {};
  const out = {};
  for (const k of Object.keys(f)) {
    const v = f[k];
    const type = Object.keys(v)[0];
    let val = v[type];
    if (type === 'mapValue') val = '{fields: ' + Object.keys(val.fields || {}).join(',') + '}';
    if (type === 'arrayValue') val = '[' + (val.values || []).map(x => JSON.stringify(x.stringValue || x.integerValue || Object.keys(x)[0])).join(',') + ']';
    if (type === 'timestampValue') val = val.slice(0, 25);
    if (typeof val === 'string' && val.length > 60) val = val.slice(0, 60) + '…';
    out[k] = val;
  }
  return out;
}

(async () => {
  for (const col of ['orders', 'orders_snack', 'snack_orders', 'stock_reservations', 'stock_log']) {
    try {
      const r = await listCollection(col);
      if (r.error) { console.log(`\n=== ${col}: ERROR ${r.error.code} ${r.error.message.slice(0, 120)}`); continue; }
      const docs = r.documents || [];
      console.log(`\n=== ${col}: ${docs.length} docs (latest)`);
      docs.slice(0, 3).forEach(d => {
        console.log('--- id:', d.name.split('/').pop());
        console.log(JSON.stringify(summarize(d), null, 1));
      });
    } catch (e) {
      console.log(`\n=== ${col}: FAIL ${e.message}`);
    }
  }
})();
