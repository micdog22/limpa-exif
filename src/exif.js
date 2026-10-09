// Leitor mínimo de EXIF/TIFF (ordens de bytes II e MM): IFD0, IFD Exif, IFD GPS e IFD1.

const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export const TAG = {
  IMAGE_DESCRIPTION: 0x010e,
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  SOFTWARE: 0x0131,
  DATE_TIME: 0x0132,
  ARTIST: 0x013b,
  THUMBNAIL_OFFSET: 0x0201,
  THUMBNAIL_LENGTH: 0x0202,
  COPYRIGHT: 0x8298,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  DATE_TIME_ORIGINAL: 0x9003,
  DATE_TIME_DIGITIZED: 0x9004,
  OFFSET_TIME_ORIGINAL: 0x9011,
  USER_COMMENT: 0x9286,
  CAMERA_OWNER_NAME: 0xa430,
  BODY_SERIAL_NUMBER: 0xa431,
  LENS_MAKE: 0xa433,
  LENS_MODEL: 0xa434,
};

export const GPS_TAG = {
  LATITUDE_REF: 0x0001,
  LATITUDE: 0x0002,
  LONGITUDE_REF: 0x0003,
  LONGITUDE: 0x0004,
  ALTITUDE_REF: 0x0005,
  ALTITUDE: 0x0006,
  TIME_STAMP: 0x0007,
  DATE_STAMP: 0x001d,
};

// O que fazer para exibir a foto corretamente, conforme o valor de Orientation.
export const ORIENTATION_LABELS = {
  1: 'normal',
  2: 'espelhar na horizontal',
  3: 'girar 180°',
  4: 'espelhar na vertical',
  5: 'espelhar na horizontal e girar 270° no sentido horário',
  6: 'girar 90° no sentido horário',
  7: 'espelhar na horizontal e girar 90° no sentido horário',
  8: 'girar 270° no sentido horário',
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

// Texto de um campo ASCII: corta no primeiro NUL; tenta UTF-8 e cai para Latin-1.
export function decodeText(bytes) {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  const slice = bytes.subarray(0, end);
  let text;
  try {
    text = utf8.decode(slice);
  } catch {
    text = latin1.decode(slice);
  }
  return text.trim();
}

function pick(count, read) {
  if (count === 1) return read(0);
  return Array.from({ length: count }, (_, i) => read(i));
}

// Lê um bloco TIFF (o conteúdo do EXIF depois de "Exif\0\0").
// Retorna Maps tag → valor. `gps` é null quando a foto não tem IFD de GPS.
export function readTiff(bytes, start = 0, end = bytes.length) {
  const len = end - start;
  if (len < 8) throw new Error('Bloco EXIF curto demais.');
  const order = String.fromCharCode(bytes[start], bytes[start + 1]);
  if (order !== 'II' && order !== 'MM') throw new Error('Bloco EXIF com ordem de bytes inválida.');
  const le = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, len);
  if (view.getUint16(2, le) !== 42) throw new Error('Cabeçalho TIFF inválido no bloco EXIF.');
  const visited = new Set();

  const readValue = (type, count, at) => {
    switch (type) {
      case 2:
        return decodeText(bytes.subarray(start + at, start + at + count));
      case 3:
        return pick(count, (i) => view.getUint16(at + i * 2, le));
      case 4:
      case 13:
        return pick(count, (i) => view.getUint32(at + i * 4, le));
      case 8:
        return pick(count, (i) => view.getInt16(at + i * 2, le));
      case 9:
        return pick(count, (i) => view.getInt32(at + i * 4, le));
      case 11:
        return pick(count, (i) => view.getFloat32(at + i * 4, le));
      case 12:
        return pick(count, (i) => view.getFloat64(at + i * 8, le));
      case 5:
        return Array.from({ length: count }, (_, i) => [view.getUint32(at + i * 8, le), view.getUint32(at + i * 8 + 4, le)]);
      case 10:
        return Array.from({ length: count }, (_, i) => [view.getInt32(at + i * 8, le), view.getInt32(at + i * 8 + 4, le)]);
      default:
        return bytes.slice(start + at, start + at + count);
    }
  };

  const readIfd = (offset) => {
    if (!Number.isInteger(offset) || offset < 8 || offset + 2 > len || visited.has(offset)) return null;
    visited.add(offset);
    const count = view.getUint16(offset, le);
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > len) break;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const n = view.getUint32(entry + 4, le);
      const size = TYPE_SIZES[type];
      if (!size || n === 0) continue;
      const total = size * n;
      if (total > len) continue;
      const at = total <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
      if (at + total > len) continue;
      tags.set(tag, readValue(type, n, at));
    }
    const nextAt = offset + 2 + count * 12;
    const next = nextAt + 4 <= len ? view.getUint32(nextAt, le) : 0;
    return { tags, next };
  };

  const ifd0 = readIfd(view.getUint32(4, le));
  if (!ifd0) return { byteOrder: order, ifd0: new Map(), exif: new Map(), gps: null, ifd1: new Map() };
  const sub = (tag) => {
    const pointer = ifd0.tags.get(tag);
    return typeof pointer === 'number' ? readIfd(pointer) : null;
  };
  const exif = sub(TAG.EXIF_IFD);
  const gps = sub(TAG.GPS_IFD);
  const ifd1 = ifd0.next ? readIfd(ifd0.next) : null;
  return {
    byteOrder: order,
    ifd0: ifd0.tags,
    exif: exif ? exif.tags : new Map(),
    gps: gps ? gps.tags : null,
    ifd1: ifd1 ? ifd1.tags : new Map(),
  };
}

// Converte graus/minutos/segundos (RATIONAL × 3) em graus decimais com sinal.
export function toDegrees(rationals, ref, allowedRefs, limit) {
  if (!Array.isArray(rationals) || rationals.length === 0) return null;
  const hemisphere = typeof ref === 'string' ? ref.trim().toUpperCase() : '';
  if (!allowedRefs.includes(hemisphere)) return null;
  const divisors = [1, 60, 3600];
  let value = 0;
  for (let i = 0; i < Math.min(3, rationals.length); i++) {
    const [num, den] = rationals[i];
    if (den === 0) {
      if (num === 0) continue;
      return null;
    }
    value += num / den / divisors[i];
  }
  if (!Number.isFinite(value) || value < 0 || value > limit) return null;
  return hemisphere === allowedRefs[1] ? -value : value;
}

function firstNumber(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Uint8Array || Array.isArray(value)) return typeof value[0] === 'number' ? value[0] : null;
  return null;
}

function rationalValue(value) {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null;
  const [num, den] = value[0];
  return den ? num / den : null;
}

function text(map, tag) {
  const value = map ? map.get(tag) : undefined;
  return typeof value === 'string' && value ? value : null;
}

export function readGps(map) {
  const latitude = toDegrees(map.get(GPS_TAG.LATITUDE), map.get(GPS_TAG.LATITUDE_REF), ['N', 'S'], 90);
  const longitude = toDegrees(map.get(GPS_TAG.LONGITUDE), map.get(GPS_TAG.LONGITUDE_REF), ['E', 'W'], 180);
  let altitude = rationalValue(map.get(GPS_TAG.ALTITUDE));
  if (altitude !== null && firstNumber(map.get(GPS_TAG.ALTITUDE_REF)) === 1) altitude = -altitude;
  let time = null;
  const stamp = map.get(GPS_TAG.TIME_STAMP);
  if (Array.isArray(stamp) && stamp.length === 3 && stamp.every(([, den]) => den)) {
    time = stamp.map(([num, den]) => String(Math.floor(num / den)).padStart(2, '0')).join(':');
  }
  return {
    latitude,
    longitude,
    altitude,
    date: text(map, GPS_TAG.DATE_STAMP),
    time,
    hasCoordinates: latitude !== null && longitude !== null,
  };
}

// UserComment: 8 bytes de código de caracteres + texto.
export function decodeUserComment(value, byteOrder) {
  if (!(value instanceof Uint8Array) || value.length <= 8) return null;
  const head = String.fromCharCode(...value.subarray(0, 8));
  const body = value.subarray(8);
  let result;
  if (head.startsWith('UNICODE')) {
    result = new TextDecoder(byteOrder === 'II' ? 'utf-16le' : 'utf-16be').decode(body).replace(/\0+$/, '');
  } else if (head.startsWith('JIS')) {
    return '(texto em codificação JIS)';
  } else {
    result = decodeText(body);
  }
  result = result.trim();
  return result || null;
}

export function summarizeExif(tiff) {
  const { ifd0, exif, gps, ifd1 } = tiff;
  const orientation = firstNumber(ifd0.get(TAG.ORIENTATION));
  const thumbnail = firstNumber(ifd1.get(TAG.THUMBNAIL_LENGTH));
  return {
    make: text(ifd0, TAG.MAKE),
    model: text(ifd0, TAG.MODEL),
    software: text(ifd0, TAG.SOFTWARE),
    dateTime: text(ifd0, TAG.DATE_TIME),
    dateTimeOriginal: text(exif, TAG.DATE_TIME_ORIGINAL),
    dateTimeDigitized: text(exif, TAG.DATE_TIME_DIGITIZED),
    offsetTimeOriginal: text(exif, TAG.OFFSET_TIME_ORIGINAL),
    artist: text(ifd0, TAG.ARTIST),
    copyright: text(ifd0, TAG.COPYRIGHT),
    description: text(ifd0, TAG.IMAGE_DESCRIPTION),
    ownerName: text(exif, TAG.CAMERA_OWNER_NAME),
    serialNumber: text(exif, TAG.BODY_SERIAL_NUMBER),
    lensMake: text(exif, TAG.LENS_MAKE),
    lensModel: text(exif, TAG.LENS_MODEL),
    userComment: decodeUserComment(exif.get(TAG.USER_COMMENT), tiff.byteOrder),
    orientation: Number.isInteger(orientation) ? orientation : null,
    gps: gps ? readGps(gps) : null,
    thumbnailBytes: thumbnail && thumbnail > 0 ? thumbnail : null,
  };
}

// Junta fabricante e modelo sem repetir ("Canon" + "Canon EOS R6" → "Canon EOS R6").
export function cameraName(make, model) {
  if (make && model) return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
  return model || make || null;
}

// Segmento APP1 completo com um EXIF mínimo: só o IFD0 com Orientation (SHORT).
export function buildOrientationSegment(orientation) {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new Error('Orientação EXIF inválida.');
  }
  const seg = new Uint8Array(36);
  const view = new DataView(seg.buffer);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  view.setUint16(2, 34); // tamanho do segmento, contando estes 2 bytes
  seg.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // "Exif\0\0"
  seg.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 10); // TIFF "MM", 42, IFD0 em 8
  view.setUint16(18, 1); // uma entrada
  view.setUint16(20, TAG.ORIENTATION);
  view.setUint16(22, 3); // SHORT
  view.setUint32(24, 1); // contagem
  view.setUint16(28, orientation); // valor alinhado à esquerda no campo de 4 bytes
  view.setUint32(32, 0); // não há próximo IFD
  return seg;
}

// "2024:05:01 14:30:00" → "01/05/2024 14:30:00"
export function formatExifDate(value) {
  if (typeof value !== 'string' || !/[1-9]/.test(value)) return null;
  const m = /^\s*(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return value.trim() || null;
  let out = `${m[3]}/${m[2]}/${m[1]}`;
  if (m[4]) out += ` ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}`;
  return out;
}

// Coordenada XMP no formato "DDD,MM,SSk" ou "DDD,MM.mmk" (k = N, S, E ou W).
export function parseXmpCoordinate(value, allowedRefs, limit) {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{1,3})\s*,\s*(\d{1,2}(?:\.\d+)?)\s*(?:,\s*(\d{1,2}(?:\.\d+)?)\s*)?([NSEW])\s*$/i.exec(value);
  if (!m) return null;
  const hemisphere = m[4].toUpperCase();
  if (!allowedRefs.includes(hemisphere)) return null;
  const degrees = Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0);
  if (degrees > limit) return null;
  return hemisphere === allowedRefs[1] ? -degrees : degrees;
}

function xmpProperty(xmp, name) {
  const attr = new RegExp(`exif:${name}\\s*=\\s*(["'])(.*?)\\1`).exec(xmp);
  if (attr) return attr[2];
  const element = new RegExp(`<exif:${name}>([^<]*)</exif:${name}>`).exec(xmp);
  return element ? element[1] : null;
}

// Procura a localização gravada no XMP (exif:GPSLatitude / exif:GPSLongitude).
export function findXmpGps(xmp) {
  const latitude = parseXmpCoordinate(xmpProperty(xmp, 'GPSLatitude'), ['N', 'S'], 90);
  const longitude = parseXmpCoordinate(xmpProperty(xmp, 'GPSLongitude'), ['E', 'W'], 180);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

export function osmUrl(latitude, longitude) {
  return `https://www.openstreetmap.org/?mlat=${latitude.toFixed(6)}&mlon=${longitude.toFixed(6)}`;
}
