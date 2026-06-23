// test/bundle-service.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub the database 'query' and config before requiring the service.
const queryCalls = [];
const stubQuery = async (sql, params = []) => {
  queryCalls.push({ sql, params });
  // createBundle: INSERT ... RETURNING
  if (/INSERT INTO bundles/.test(sql)) {
    return { rows: [{ id: 'bundle-uuid', password_salt: 'salt123' }] };
  }
  // addFileToBundle: UPDATE files + UPDATE bundles
  if (/UPDATE files SET bundle_id/.test(sql)) return { rowCount: 1 };
  if (/UPDATE bundles SET file_count/.test(sql)) return { rowCount: 1 };
  // getBundle: SELECT bundle + files
  if (/FROM bundles WHERE id/.test(sql)) {
    return { rows: [{ id: 'bundle-uuid', session_id: 's1', title: null, file_count: 1, total_size: 10, expire_at: new Date(Date.now()+3600e3).toISOString(), is_encrypted: false, password_salt: null, created_at: new Date().toISOString() }] };
  }
  if (/FROM files WHERE bundle_id/.test(sql)) {
    return { rows: [{ id: 'f1', filename: 'a.txt', file_size: 10, mime_type: 'text/plain', is_encrypted: false, encryption_salt: 'fsalt' }] };
  }
  return { rows: [] };
};

require.cache[require.resolve('../services/database')] = { exports: { query: stubQuery, connect: async () => {} } };
const { createBundle, selectDecryptSalt, addFileToBundle } = require('../services/bundle-service');

test('createBundle inserts a bundle with expire_at derived from expireHours', async () => {
  queryCalls.length = 0;
  const res = await createBundle('s1', { expireHours: 2, title: 'pics', password: 'pw' });
  assert.equal(res.id, 'bundle-uuid');
  assert.equal(res.passwordSalt, 'salt123');
  const insertCall = queryCalls.find(c => /INSERT INTO bundles/.test(c.sql));
  assert.ok(insertCall, 'INSERT into bundles was issued');
  assert.equal(insertCall.params[0], 's1');           // session_id
  assert.equal(insertCall.params[1], 'pics');          // title
  assert.equal(insertCall.params[2], 2);               // expireHours used to compute expire_at
});

test('selectDecryptSalt prefers bundle.password_salt, falls back to file.encryption_salt', () => {
  assert.equal(selectDecryptSalt({ password_salt: 'bsalt' }, { encryption_salt: 'fsalt' }), 'bsalt');
  assert.equal(selectDecryptSalt({ password_salt: null }, { encryption_salt: 'fsalt' }), 'fsalt');
  assert.equal(selectDecryptSalt({ password_salt: null }, { encryption_salt: null }), null);
});

test('addFileToBundle sets files.bundle_id and bumps bundle counters', async () => {
  queryCalls.length = 0;
  await addFileToBundle('f1', 'bundle-uuid', 10);
  const updateFiles = queryCalls.find(c => /UPDATE files SET bundle_id/.test(c.sql));
  const updateBundle = queryCalls.find(c => /UPDATE bundles SET file_count/.test(c.sql));
  assert.ok(updateFiles, 'files updated with bundle_id');
  assert.ok(updateBundle, 'bundle counters updated');
  assert.equal(updateFiles.params[0], 'bundle-uuid');
  assert.equal(updateFiles.params[1], 'f1');
});
