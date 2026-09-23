const encoder = new TextEncoder();

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(date.getFullYear(), 2107));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  };
}

function zipName(entry, index) {
  const original = String(entry.name || `photo-${index + 1}.jpg`)
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || `photo-${index + 1}.jpg`;
  return `photos/${String(index + 1).padStart(3, '0')}_${original}`;
}

export async function createPhotoZip(entries, fetcher = fetch, onProgress = () => {}) {
  if (!entries.length) throw new Error('保存する写真がありません。');
  if (entries.length > 65535) throw new Error('一度に保存できる写真の枚数を超えています。');
  const parts = [];
  const directory = [];
  let offset = 0;
  const { date, time } = dosDateTime(new Date());

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    onProgress(index + 1, entries.length);
    const response = await fetcher(entry.url);
    if (!response.ok) throw new Error(`${entry.name} の取得に失敗しました（${response.status}）。公開反映後に再度お試しください。`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const name = encoder.encode(zipName(entry, index));
    if (name.length > 65535 || bytes.length > 0xffffffff || offset + bytes.length + name.length + 76 > 0xffffffff) {
      throw new Error('ZIP の容量上限を超えています。写真を分けて保存してください。');
    }
    const checksum = crc32(bytes);
    const local = new Uint8Array(30);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, checksum, true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, name.length, true);
    parts.push(local, name, bytes);

    const central = new Uint8Array(46);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, checksum, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }

  const centralSize = directory.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize + 22 > 0xffffffff) throw new Error('ZIP の容量上限を超えています。');
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
