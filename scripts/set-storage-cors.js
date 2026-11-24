// Applies storage.cors.json to the Firebase Storage bucket via the GCS JSON API.
// Uses the refresh token stored by firebase-tools to get an access token.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUCKET = 'latiao-snack.firebasestorage.app';
const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const SCOPES = 'https://www.googleapis.com/auth/devstorage.full_control https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase';

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
  throw new Error('No firebase-tools refresh token found. Run "firebase login" first.');
}

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + (await res.text()));
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const cors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'storage.cors.json'), 'utf8'));
  const token = await getAccessToken(readRefreshToken());

  // Read current bucket config, merge cors, PATCH back
  const getUrl = `https://storage.googleapis.com/storage/v1/b/${BUCKET}`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!getRes.ok) throw new Error('Get bucket failed: ' + (await getRes.text()));
  const bucket = await getRes.json();

  const patchRes = await fetch(getUrl, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cors }),
  });
  if (!patchRes.ok) throw new Error('Patch bucket failed: ' + (await patchRes.text()));
  const updated = await patchRes.json();
  console.log('CORS updated successfully for bucket:', BUCKET);
  console.log(JSON.stringify(updated.cors, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
