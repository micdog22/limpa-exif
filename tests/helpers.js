// Construtores de arquivos sintéticos usados pelos testes.
import { crc32 } from '../src/zip.js';

const encoder = new TextEncoder();

export function bytes(...parts) {
  const arrays = parts.map((p) => (typeof p === 'string' ? encoder.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

const UNIT = { 3: 2, 4: 4, 5: 8 };

function encodeValue({ type, value }, le) {
  if (type === 2) {
    const text = encoder.encode(value);
    return bytes(text, [0]);
  }
  if (type === 1 || type === 7) return value instanceof Uint8Array ? value : Uint8Array.from(value);
  const values = type === 5 ? value : [].concat(value);
  const out = new Uint8Array(values.length * UNIT[type]);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    if (type === 3) view.setUint16(i * 2, v, le);
    else if (type === 4) view.setUint32(i * 4, v, le);
    else {
      view.setUint32(i * 8, v[0], le);
      view.setUint32(i * 8 + 4, v[1], le);
    }
  });
  return out;
}

function countOf(entry, encoded) {
  if (entry.type === 3) return encoded.length / 2;
  if (entry.type === 4) return encoded.length / 4;
  if (entry.type === 5) return encoded.length / 8;
  return encoded.length;
}

function ifdSize(entries, le) {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) {
    const n = encodeValue(e, le).length;
    if (n > 4) size += n + (n % 2);
  }
  return size;
}

function writeIfd(out, view, offset, entries, le, next) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  view.setUint16(offset, sorted.length, le);
  let data = offset + 2 + sorted.length * 12 + 4;
  sorted.forEach((entry, i) => {
    const p = offset + 2 + i * 12;
    const encoded = encodeValue(entry, le);
    view.setUint16(p, entry.tag, le);
    view.setUint16(p + 2, entry.type, le);
    view.setUint32(p + 4, countOf(entry, encoded), le);
    if (encoded.length <= 4) out.set(encoded, p + 8);
    else {
      view.setUint32(p + 8, data, le);
      out.set(encoded, data);
      data += encoded.length + (encoded.length % 2);
    }
  });
  view.setUint32(offset + 2 + sorted.length * 12, next, le);
}

// Bloco TIFF com IFD0 e, se pedidos, IFD Exif, IFD GPS e IFD1.
export function buildTiff(order, { ifd0 = [], exif = null, gps = null, ifd1 = null } = {}) {
  const le = order === 'II';
  const main = [...ifd0];
  const exifPointer = { tag: 0x8769, type: 4, value: 0 };
  const gpsPointer = { tag: 0x8825, type: 4, value: 0 };
  if (exif) main.push(exifPointer);
  if (gps) main.push(gpsPointer);
  const offMain = 8;
  const offExif = offMain + ifdSize(main, le);
  const offGps = offExif + (exif ? ifdSize(exif, le) : 0);
  const offIfd1 = offGps + (gps ? ifdSize(gps, le) : 0);
  const total = offIfd1 + (ifd1 ? ifdSize(ifd1, le) : 0);
  exifPointer.value = offExif;
  gpsPointer.value = offGps;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(encoder.encode(order), 0);
  view.setUint16(2, 42, le);
  view.setUint32(4, offMain, le);
  writeIfd(out, view, offMain, main, le, ifd1 ? offIfd1 : 0);
  if (exif) writeIfd(out, view, offExif, exif, le, 0);
  if (gps) writeIfd(out, view, offGps, gps, le, 0);
  if (ifd1) writeIfd(out, view, offIfd1, ifd1, le, 0);
  return out;
}

export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;

export function sampleTiff(order, { orientation = 6 } = {}) {
  const ifd0 = [
    { tag: 0x010f, type: ASCII, value: 'Canon' },
    { tag: 0x0110, type: ASCII, value: 'Canon EOS Exemplo' },
    { tag: 0x0131, type: ASCII, value: 'Editor Exemplo 2.1' },
    { tag: 0x0132, type: ASCII, value: '2024:05:01 14:30:00' },
    { tag: 0x013b, type: ASCII, value: 'Maria Exemplo' },
  ];
  if (orientation !== null) ifd0.push({ tag: 0x0112, type: SHORT, value: orientation });
  return buildTiff(order, {
    ifd0,
    exif: [
      { tag: 0x9003, type: ASCII, value: '2024:05:01 14:29:58' },
      { tag: 0x9011, type: ASCII, value: '-03:00' },
      { tag: 0x9286, type: UNDEFINED, value: bytes('ASCII\0\0\0', 'Viagem de teste') },
      { tag: 0xa431, type: ASCII, value: '0123456789' },
    ],
    gps: [
      { tag: 0x0001, type: ASCII, value: 'S' },
      { tag: 0x0002, type: RATIONAL, value: [[23, 1], [33, 1], [1234, 100]] },
      { tag: 0x0003, type: ASCII, value: 'W' },
      { tag: 0x0004, type: RATIONAL, value: [[46, 1], [38, 1], [1000, 100]] },
      { tag: 0x0005, type: 1, value: [0] },
      { tag: 0x0006, type: RATIONAL, value: [[760, 1]] },
      { tag: 0x0007, type: RATIONAL, value: [[17, 1], [29, 1], [58, 1]] },
      { tag: 0x001d, type: ASCII, value: '2024:05:01' },
    ],
    ifd1: [
      { tag: 0x0201, type: LONG, value: 0 },
      { tag: 0x0202, type: LONG, value: 4321 },
    ],
  });
}

export function segment(marker, payload) {
  const length = payload.length + 2;
  return bytes([0xff, marker, length >> 8, length & 0xff], payload);
}

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];
export const jfif = () => segment(0xe0, bytes('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0]));
export const exifSegment = (tiff) => segment(0xe1, bytes('Exif\0\0', tiff));
export const xmpSegment = (xml) => segment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', xml));
export const iccSegment = () => segment(0xe2, bytes('ICC_PROFILE\0', [1, 1], new Uint8Array(40).fill(7)));
export const mpfSegment = () => segment(0xe2, bytes('MPF\0', 'MM', [0, 42, 0, 0, 0, 8]));
export const photoshopSegment = () => segment(0xed, bytes('Photoshop 3.0\0', '8BIM', [4, 4, 0, 0, 0, 0, 0, 0]));
export const comment = (text) => segment(0xfe, bytes(text));
export const dqt = () => segment(0xdb, bytes([0], new Uint8Array(64).fill(1)));
export const sof0 = (width, height) => segment(0xc0, bytes([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
export const dht = () => segment(0xc4, bytes([0x00], new Uint8Array(16).fill(0), [0]));
export const sos = () => segment(0xda, bytes([1, 1, 0x00, 0, 63, 0]));

// Dados comprimidos com bytes de enchimento (FF00) e marcadores de reinício (RSTn).
export const SCAN = Uint8Array.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xff, 0x00, 0xff, 0xd1, 0xbc]);

export const SAMPLE_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="15,47.6S" exif:GPSLongitude="47,52.2W"/>'
  + '</rdf:RDF></x:xmpmeta>';

export function sampleJpeg(order, { orientation = 6 } = {}) {
  return bytes(
    SOI,
    jfif(),
    exifSegment(sampleTiff(order, { orientation })),
    xmpSegment(SAMPLE_XMP),
    iccSegment(),
    mpfSegment(),
    photoshopSegment(),
    comment('Foto de teste'),
    dqt(),
    sof0(640, 480),
    dht(),
    sos(),
    SCAN,
    EOI,
    'dados extras depois do fim',
  );
}

// Lista os segmentos de um JPEG (marcador e bytes), tratando o SOS como cabeçalho + dados.
export function jpegMarkers(data) {
  const markers = [];
  let pos = 2;
  while (pos < data.length) {
    const marker = data[pos + 1];
    if (marker === 0xd9) {
      markers.push({ marker, start: pos, end: pos + 2 });
      break;
    }
    const length = (data[pos + 2] << 8) | data[pos + 3];
    let end = pos + 2 + length;
    if (marker === 0xda) {
      while (end < data.length && !(data[end] === 0xff && data[end + 1] !== 0 && (data[end + 1] < 0xd0 || data[end + 1] > 0xd7))) end++;
    }
    markers.push({ marker, start: pos, end });
    pos = end;
  }
  return markers;
}

export function pngChunk(type, data) {
  const body = bytes(type, data);
  const crc = crc32(body);
  const len = data.length;
  return bytes([len >>> 24, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff], body, [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function ihdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data.set([8, 6, 0, 0, 0], 8);
  return pngChunk('IHDR', data);
}

export function listPngChunks(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos + 12 <= data.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const crc = view.getUint32(pos + 8 + length);
    chunks.push({ type, data: data.subarray(pos + 8, pos + 8 + length), crc, crcOk: crc32(data.subarray(pos + 4, pos + 8 + length)) === crc });
    pos += 12 + length;
  }
  return chunks;
}
