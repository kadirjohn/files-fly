// test/smoke-bundles.js
// Integration smoke test against a running server (npm start). Run:
//   node test/smoke-bundles.js
// Çalışan bir sunucuya karşı uçtan uca bundle akışını doğrular:
//   session → create bundle → upload into bundle → get metadata → zip download →
//   /files/:id → /b/:bundleId redirect.
// DATABASE_URL / sunucu ayakta olmalı. Hata durumunda non-zero exit.

const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://localhost:9392';
let cookie = '';

async function req(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (body) {
    init.body = body;
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }
  // redirect: 'manual' — 301/302'yi olduğu gibi görelim (takip edip final status'a
  // düşmeyelim), böylece /files/:id → /b/:bundleId redirect'ini assert edebiliriz.
  init.redirect = 'manual';
  const r = await fetch(BASE + path, init);
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return r;
}

async function main() {
  // 1. session
  let r = await req('POST', '/api/session');
  assert.equal(r.status, 200, 'session created');

  // 2. create bundle (unencrypted, 2h)
  r = await req('POST', '/api/bundles', JSON.stringify({ expire: 2, title: 'smoke' }));
  assert.equal(r.status, 201, 'bundle created');
  const bundle = await r.json();
  assert.ok(bundle.bundle_id, 'has bundle_id');

  // 3. upload a small file into the bundle via /api/upload (multipart)
  const form =
    '--b\r\nContent-Disposition: form-data; name="bundle_id"\r\n\r\n' + bundle.bundle_id + '\r\n' +
    '--b\r\nContent-Disposition: form-data; name="expire"\r\n\r\n2\r\n' +
    '--b\r\nContent-Disposition: form-data; name="file"; filename="smoke.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\nhello smoke\r\n' +
    '--b--\r\n';
  r = await req('POST', '/api/upload', form, { 'Content-Type': 'multipart/form-data; boundary=b' });
  // Tek seferde upload başarılıda 201 Created döner (routes/upload.js ile aynı).
  assert.equal(r.status, 201, 'upload ok (201 Created)');
  const up = await r.json();
  assert.ok(up.bundle_id || up.preview_url, 'upload returned bundle link');

  // 4. fetch bundle metadata
  r = await req('GET', '/api/bundles/' + bundle.bundle_id);
  assert.equal(r.status, 200, 'bundle metadata ok');
  const meta = await r.json();
  assert.ok(meta.files.length >= 1, 'bundle has the file');

  // 5. zip download
  r = await req('POST', '/api/bundles/' + bundle.bundle_id + '/download');
  assert.equal(r.status, 200, 'zip ok');
  const zipBuf = Buffer.from(await r.arrayBuffer());
  assert.ok(zipBuf.subarray(0, 2).toString('latin1') === 'PK', 'zip magic bytes');

  // 6. /files/:id redirect to /b/:bundleId (301)
  const fileId = meta.files[0].id;
  r = await req('GET', '/files/' + fileId, null, {});
  assert.ok([301, 302].includes(r.status), 'files/:id redirects');
  assert.match(r.headers.get('location') || '', /\/b\//, 'redirects to /b/');

  console.log('✅ smoke-bundles passed');
}

main().catch((e) => {
  console.error('❌ smoke failed:', e.message);
  process.exit(1);
});
