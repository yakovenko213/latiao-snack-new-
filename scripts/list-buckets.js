const fs = require('fs');
const path = require('path');
const os = require('os');

const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

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

async function main() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: readRefreshToken(),
      grant_type: 'refresh_token',
    }),
  });
  const { access_token } = await res.json();
  const r = await fetch('https://storage.googleapis.com/storage/v1/b?project=latiao-snack', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await r.json();
  if (data.items) data.items.forEach(b => console.log(b.name, '| CORS entries:', (b.cors || []).length));
  else console.log(JSON.stringify(data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
