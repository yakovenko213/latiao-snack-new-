/* Список колекцій Firestore + останні документи без orderBy */
const fs = require('fs');
const https = require('https');

const cfg = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.config/configstore/firebase-tools.json', 'utf8'));
const token = cfg.tokens.access_token;
const PROJECT = 'latiao-snack';

function req(path, method = 'GET', payload = null) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)${path}`;
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(body.slice(0, 400))); } });
    });
    r.on('error', reject);
    if (payload) r.write(JSON.stringify(payload));
    r.end();
  });
}

(async () => {
  const r = await req('/documents:listCollectionIds', 'POST', { pageSize: 100 });
  console.log('Collections:', JSON.stringify(r.collectionIds || r.error));
  for (const col of (r.collectionIds || [])) {
    if (/order/i.test(col)) {
      const d = await req(`/documents/${col}?pageSize=3`);
      console.log(`\n=== ${col}: ${(d.documents || []).length} docs`);
      (d.documents || []).forEach(doc => {
        console.log('--- id:', doc.name.split('/').pop());
        console.log(JSON.stringify(doc.fields, null, 1).slice(0, 1500));
      });
    }
  }
})();
