const fs = require('fs');
const path = require('path');
const os = require('os');

const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const PROJECT = 'latiao-snack';
const BUCKET = 'latiao-snack.appspot.com';

function readRefreshToken() {
  const candidates = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'configstore', 'firebase-tools.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.tokens && cfg.tokens.refresh_token) return cfg.tokens.refresh_token;
      if (cfg.refresh_token) return cfg.refresh_token;
    }
  }
  throw new Error('No refresh token found');
}

async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: readRefreshToken(), grant_type: 'refresh_token',
    }),
  });
  return (await res.json()).access_token;
}

async function main() {
  const t = await token();
  const cors = JSON.parse(fs.readFileSync('storage.cors.json', 'utf8'));
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${PROJECT}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET, location: 'US', storageClass: 'STANDARD', cors }),
  });
  console.log(r.status, await r.text());
}
main().catch(e => { console.error(e); process.exit(1); });
