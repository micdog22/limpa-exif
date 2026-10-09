// CRC-32 e gravador de ZIP sem compressão (método "store"), com nomes em UTF-8.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// `previous` permite calcular em partes: crc32(b, crc32(a)) === crc32(a + b).
export function crc32(bytes, previous = 0) {
  let crc = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

export function dosDateTime(date) {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, day: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const MAX_32 = 0xffffffff;

// files: [{ name, data: Uint8Array }]
export function createZip(files, date = new Date()) {
  if (files.length > 0xffff) throw new Error('Arquivos demais para um único ZIP.');
  const { time, day } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const { data } = file;
    if (name.length > 0xffff) throw new Error('Nome de arquivo longo demais.');
    if (offset + 30 + name.length + data.length > MAX_32) {
      throw new Error('O ZIP passaria de 4 GB. Baixe as fotos em grupos menores.');
    }
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true); // versão mínima para extrair: 1.0
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // método 0: armazenado, sem compressão
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // criado por: MS-DOS, versão 2.0
    cv.setUint16(6, 10, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comentário, disco, atributos internos e externos ficam zerados
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0);
  if (offset + centralSize + 22 > MAX_32) throw new Error('O ZIP passaria de 4 GB. Baixe as fotos em grupos menores.');
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// Evita nomes repetidos dentro do ZIP: "foto.jpg", "foto (2).jpg"...
export function uniqueName(name, used) {
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
