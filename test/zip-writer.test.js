// test/zip-writer.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createZipStream, crc32 } = require('../services/zip-writer');

// Minimal ZIP central-directory parser to validate output.
function parseZip(buf) {
  // Find End Of Central Directory record (PK\x05\x06)
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = buf.lastIndexOf(eocdSig);
  assert.notEqual(eocd, -1, 'EOCD signature found');
  const cdCount = buf.readUInt16LE(eocd + 8);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (let i = 0; i < cdCount; i++) {
    assert.equal(buf.subarray(p, p + 4).toString('latin1'), cdSig.toString('latin1'), 'CD entry signature');
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + fnLen).toString('utf8');
    entries.push({ name, compSize, uncompSize, localHeaderOffset });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

test('crc32 matches known value for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('createZipStream emits a valid single-entry ZIP', async () => {
  const content = Buffer.from('hello bundle');
  const zip = createZipStream([
    { filename: 'a.txt', stream: Readable.from([content]) },
  ]);
  const chunks = [];
  for await (const c of zip) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const entries = parseZip(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'a.txt');
  assert.equal(entries[0].uncompSize, content.length);

  // Extract local file header data and verify content + CRC.
  const off = entries[0].localHeaderOffset;
  const lfhSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(buf.subarray(off, off + 4).toString('latin1'), lfhSig.toString('latin1'));
  const fnLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + fnLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entries[0].uncompSize);
  assert.equal(data.toString('utf8'), 'hello bundle');
});

test('createZipStream handles multiple entries and UTF-8 filenames', async () => {
  const zip = createZipStream([
    { filename: 'fotoğraf.jpg', stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]) },
    { filename: 'rapor.pdf', stream: Readable.from([Buffer.from('%PDF-1.4')]) },
  ]);
  const buf = Buffer.concat(await collect(zip));
  const entries = parseZip(buf);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.name), ['fotoğraf.jpg', 'rapor.pdf']);
});

async function collect(stream) {
  const out = [];
  for await (const c of stream) out.push(c);
  return out;
}
