// services/zip-writer.js
// Minimal streaming ZIP writer (STORE method — no compression). Media is already
// compressed, so STORE avoids CPU cost and lets us stream without buffering.
// CRC32 is required by the ZIP format and is computed in a single pass over each
// entry's bytes as they flow through. Because CRC/size aren't known until after
// the data, we use a data descriptor (general-purpose bit 3) after each entry's
// bytes, and write the real values in the central directory.

const { Readable } = require('stream');

// CRC32 table (polynomial 0xEDB88320, standard ZIP CRC).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

// Update a running CRC state (un-finalized form: NOT yet XORed with 0xFFFFFFFF).
// Chaining: pass the previous state back in to continue across chunks.
function crc32Update(state, buf) {
  let c = state >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return c >>> 0;
}

// Finalize: XOR with 0xFFFFFFFF to get the standard CRC32 value.
function crc32Final(state) { return ((state >>> 0) ^ 0xFFFFFFFF) >>> 0; }

// One-shot CRC32 (for testing / small buffers).
function crc32(buf) {
  return crc32Final(crc32Update(0xFFFFFFFF >>> 0, buf));
}

const SIG_LFH = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // local file header
const SIG_CD = Buffer.from([0x50, 0x4b, 0x01, 0x02]);  // central directory
const SIG_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // end of central directory
const SIG_DD = Buffer.from([0x50, 0x4b, 0x07, 0x08]);  // data descriptor

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// GP flag: bit 11 = UTF-8 filename, bit 3 = sizes/crc in data descriptor.
const GP_FLAG = 0x0808;

/**
 * Build a ZIP file as a Readable stream from entries.
 * Each entry's content is streamed; crc + size are accumulated on the fly and
 * emitted in a data descriptor after the data, plus recorded in the central
 * directory. The central directory + EOCD are appended after all entries.
 *
 * @param {Array<{filename: string, stream: NodeJS.ReadableStream}>} entries
 * @returns {NodeJS.ReadableStream}
 */
function createZipStream(entries) {
  const cdRecords = [];
  const entryOffsets = []; // LFH start offset per entry
  let offset = 0;

  async function* gen() {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.filename, 'utf8');
      const entryIndex = entryOffsets.length;
      entryOffsets.push(offset); // record where this entry's LFH begins

      // Local file header (30 bytes + name). crc/sizes are 0 here (in descriptor).
      const lfh = Buffer.concat([
        SIG_LFH, u16(20), u16(GP_FLAG), u16(0), // version, flags, method=STORE
        u16(0), u16(0),                          // mod time, mod date
        u32(0), u32(0), u32(0),                  // crc, comp, uncomp (in descriptor)
        u16(nameBuf.length), u16(0),             // name len, extra len
        nameBuf,
      ]);
      yield lfh; offset += lfh.length;

      // Stream the data, accumulating crc state + size.
      let state = 0xFFFFFFFF >>> 0;
      let size = 0;
      for await (const chunk of entry.stream) {
        const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        state = crc32Update(state, c);
        size += c.length;
        yield c; offset += c.length;
      }
      const crc = crc32Final(state);

      // Data descriptor (with signature) — real crc + sizes. STORE: comp == uncomp.
      const dd = Buffer.concat([SIG_DD, u32(crc), u32(size), u32(size)]);
      yield dd; offset += dd.length;

      // Central directory record (real values + LFH offset).
      cdRecords.push(Buffer.concat([
        SIG_CD, u16(20), u16(20), u16(GP_FLAG), u16(0), // made-by, needed, flags, method
        u16(0), u16(0),                                  // time, date
        u32(crc), u32(size), u32(size),                  // crc, comp, uncomp
        u16(nameBuf.length), u16(0),                     // name len, extra len
        u16(0), u16(0),                                  // comment len, disk start
        u16(0), u32(0),                                  // internal attrs, external attrs
        u32(entryOffsets[entryIndex]),                   // local header offset
        nameBuf,
      ]));
    }

    // Central directory + EOCD.
    const cdStart = offset;
    let cdSize = 0;
    for (const cd of cdRecords) { yield cd; offset += cd.length; cdSize += cd.length; }

    const eocd = Buffer.concat([
      SIG_EOCD, u16(0), u16(0),
      u16(cdRecords.length), u16(cdRecords.length), // entries on this disk / total
      u32(cdSize), u32(cdStart),                     // cd size, cd offset
      u16(0),                                        // comment length
    ]);
    yield eocd;
  }

  return Readable.from(gen());
}

module.exports = { createZipStream, crc32, crc32Update, crc32Final };
