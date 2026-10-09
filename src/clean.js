// Análise e limpeza de metadados em JPEG (sem recompressão) e PNG.
import { readTiff, summarizeExif, buildOrientationSegment, findXmpGps, decodeText } from './exif.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_REMOVE = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
// Blocos auxiliares que afetam a exibição (cor, transparência, animação) e não identificam ninguém.
const PNG_KEEP = new Set([
  'iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS', 'bKGD', 'sBIT', 'hIST', 'sPLT',
  'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT',
]);
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_ID = 'http://ns.adobe.com/xmp/extension/\0';
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const latin1 = new TextDecoder('latin1');
const utf8Loose = new TextDecoder('utf-8');

export function detectFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'PNG';
  return null;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function startsWithAscii(bytes, start, end, id) {
  if (end - start < id.length) return false;
  for (let i = 0; i < id.length; i++) {
    if (bytes[start + i] !== id.charCodeAt(i)) return false;
  }
  return true;
}

function newReport(format) {
  return {
    format,
    width: null,
    height: null,
    exif: null, // resumo de summarizeExif()
    exifError: null,
    gps: null, // { latitude, longitude, altitude, source }
    gpsWithoutCoordinates: false,
    comments: [],
    texts: [], // PNG: [{ keyword, text, compressed }]
    xmp: false,
    iptc: false,
    icc: false,
    mpf: false,
    thumbnail: false,
    modified: null, // PNG tIME
    orientation: null,
    orientationKept: null,
    removed: [], // [{ label, bytes }]
    trailingBytes: 0,
    output: null,
  };
}

function absorbExif(report, bytes, start, end) {
  if (report.exif) return;
  try {
    const summary = summarizeExif(readTiff(bytes, start, end));
    report.exif = summary;
    report.orientation = summary.orientation;
    if (summary.gps) {
      if (summary.gps.hasCoordinates) {
        const { latitude, longitude, altitude } = summary.gps;
        report.gps = { latitude, longitude, altitude, source: 'EXIF' };
      } else {
        report.gpsWithoutCoordinates = true;
      }
    }
    if (summary.thumbnailBytes) report.thumbnail = true;
    if (summary.userComment) report.comments.push(summary.userComment);
  } catch (err) {
    report.exifError = err.message;
  }
}

function absorbXmp(report, xmp) {
  report.xmp = true;
  if (report.gps) return;
  const found = findXmpGps(xmp);
  if (found) report.gps = { ...found, altitude: null, source: 'XMP' };
}

// Percorre os segmentos do JPEG. O segmento SOS inclui os dados comprimidos que o seguem.
export function parseJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Arquivo JPEG inválido.');
  const len = bytes.length;
  const segments = [];
  let pos = 2;
  while (pos < len) {
    if (bytes[pos] !== 0xff) {
      throw new Error(`Estrutura JPEG inesperada na posição ${pos}. O arquivo pode estar corrompido.`);
    }
    const start = pos;
    while (pos < len && bytes[pos] === 0xff) pos++;
    if (pos >= len) break;
    const marker = bytes[pos++];
    if (marker === 0xd9) {
      segments.push({ marker, start, dataStart: pos, end: pos });
      return { segments, end: pos, complete: true };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, dataStart: pos, end: pos });
      continue;
    }
    if (marker === 0x00 || marker === 0xd8) {
      throw new Error(`Estrutura JPEG inesperada na posição ${start}. O arquivo pode estar corrompido.`);
    }
    if (pos + 2 > len) throw new Error('Arquivo JPEG incompleto.');
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > len) throw new Error('Arquivo JPEG incompleto ou corrompido.');
    const segment = { marker, start, dataStart: pos + 2, end: pos + length };
    pos += length;
    if (marker === 0xda) {
      pos = scanDataEnd(bytes, pos);
      segment.end = pos;
    }
    segments.push(segment);
  }
  return { segments, end: len, complete: false };
}

// Fim dos dados comprimidos: o primeiro marcador que não seja FF00 (byte de enchimento) nem RSTn.
function scanDataEnd(bytes, from) {
  const len = bytes.length;
  let pos = from;
  for (;;) {
    const ff = bytes.indexOf(0xff, pos);
    if (ff === -1 || ff + 1 >= len) return len;
    const next = bytes[ff + 1];
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
      pos = ff + 1;
      continue;
    }
    return ff;
  }
}

function inspectJpegSegment(bytes, seg, report) {
  const { marker, dataStart, end } = seg;
  const has = (id) => startsWithAscii(bytes, dataStart, end, id);
  const drop = (label) => ({ keep: false, label });
  const keep = { keep: true };

  if (SOF_MARKERS.has(marker)) {
    if (report.width === null && end - dataStart >= 5) {
      report.height = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
      report.width = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
    }
    return keep;
  }
  switch (marker) {
    case 0xe0:
      if (has('JFIF\0')) return keep;
      return drop(has('JFXX\0') ? 'APP0 (JFXX, miniatura)' : 'APP0');
    case 0xe1:
      if (has('Exif\0')) {
        absorbExif(report, bytes, dataStart + 6, end);
        return drop('APP1 (Exif)');
      }
      if (has(XMP_ID)) {
        absorbXmp(report, utf8Loose.decode(bytes.subarray(dataStart + XMP_ID.length, end)));
        return drop('APP1 (XMP)');
      }
      if (has(XMP_EXTENSION_ID)) {
        report.xmp = true;
        return drop('APP1 (XMP estendido)');
      }
      return drop('APP1');
    case 0xe2:
      if (has('ICC_PROFILE\0')) {
        report.icc = true;
        return keep;
      }
      if (has('MPF\0')) {
        report.mpf = true;
        return drop('APP2 (MPF, imagens adicionais)');
      }
      return drop(has('FPXR\0') ? 'APP2 (FPXR)' : 'APP2');
    case 0xed:
      if (has('Photoshop 3.0\0')) {
        report.iptc = true;
        return drop('APP13 (IPTC/Photoshop)');
      }
      return drop('APP13');
    case 0xee:
      return has('Adobe') ? keep : drop('APP14');
    case 0xfe: {
      const comment = decodeText(bytes.subarray(dataStart, end));
      if (comment) report.comments.push(comment);
      return drop('Comentário (COM)');
    }
    default:
      if (marker >= 0xe3 && marker <= 0xef) return drop(`APP${marker - 0xe0}`);
      return keep;
  }
}

export function cleanJpeg(bytes) {
  const report = newReport('JPEG');
  const { segments, end } = parseJpeg(bytes);
  const kept = [];
  for (const seg of segments) {
    const decision = inspectJpegSegment(bytes, seg, report);
    if (decision.keep) kept.push(seg);
    else report.removed.push({ label: decision.label, bytes: seg.end - seg.start });
  }
  report.trailingBytes = bytes.length - end;
  if (report.trailingBytes > 0) {
    report.removed.push({ label: 'Dados depois do fim da imagem', bytes: report.trailingBytes });
  }

  // Orientação diferente de 1: grava um EXIF mínimo logo depois do APP0 para a foto não aparecer girada.
  const { orientation } = report;
  const extra = Number.isInteger(orientation) && orientation >= 2 && orientation <= 8
    ? buildOrientationSegment(orientation)
    : null;
  report.orientationKept = extra ? orientation : null;

  const parts = [bytes.subarray(0, 2)];
  let pending = extra;
  for (const seg of kept) {
    if (pending && seg.marker !== 0xe0) {
      parts.push(pending);
      pending = null;
    }
    parts.push(bytes.subarray(seg.start, seg.end));
  }
  if (pending) parts.push(pending);
  report.output = concat(parts);
  return report;
}

export function parsePng(bytes) {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('Arquivo PNG inválido.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new Error('Arquivo PNG incompleto.');
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff) throw new Error('Arquivo PNG corrompido.');
    const end = pos + 12 + length;
    if (end > bytes.length) throw new Error('Arquivo PNG incompleto.');
    chunks.push({ type, start: pos, dataStart: pos + 8, dataEnd: pos + 8 + length, end });
    pos = end;
    if (type === 'IEND') return { chunks, end: pos };
  }
  throw new Error('Arquivo PNG incompleto (falta o bloco IEND).');
}

function readPngText(type, data) {
  const nul = data.indexOf(0);
  if (nul < 1) return null;
  const keyword = latin1.decode(data.subarray(0, nul));
  if (type === 'tEXt') return { keyword, text: latin1.decode(data.subarray(nul + 1)), compressed: false };
  if (type === 'zTXt') return { keyword, text: null, compressed: true };
  const compressed = data[nul + 1] === 1;
  const languageEnd = data.indexOf(0, nul + 3);
  const translatedEnd = languageEnd === -1 ? -1 : data.indexOf(0, languageEnd + 1);
  if (compressed || translatedEnd === -1) return { keyword, text: null, compressed };
  return { keyword, text: utf8Loose.decode(data.subarray(translatedEnd + 1)), compressed: false };
}

function inspectPngChunk(bytes, chunk, report) {
  const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
  switch (chunk.type) {
    case 'eXIf': {
      const skip = startsWithAscii(data, 0, data.length, 'Exif\0\0') ? 6 : 0;
      absorbExif(report, bytes, chunk.dataStart + skip, chunk.dataEnd);
      return 'eXIf (Exif)';
    }
    case 'tIME': {
      if (data.length === 7) {
        const pad = (n) => String(n).padStart(2, '0');
        const year = (data[0] << 8) | data[1];
        report.modified = `${pad(data[3])}/${pad(data[2])}/${year} ${pad(data[4])}:${pad(data[5])}:${pad(data[6])} (UTC)`;
      }
      return 'tIME (data de modificação)';
    }
    default: {
      const entry = readPngText(chunk.type, data);
      if (entry && entry.keyword === 'XML:com.adobe.xmp') {
        report.xmp = true;
        if (entry.text) absorbXmp(report, entry.text);
        return `${chunk.type} (XMP)`;
      }
      if (entry) report.texts.push(entry);
      return `${chunk.type} (texto${entry ? ` «${entry.keyword}»` : ''})`;
    }
  }
}

export function cleanPng(bytes) {
  const report = newReport('PNG');
  const { chunks, end } = parsePng(bytes);
  const parts = [bytes.subarray(0, 8)];
  for (const chunk of chunks) {
    const { type } = chunk;
    if (type === 'IHDR' && chunk.dataEnd - chunk.dataStart >= 8) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + chunk.dataStart, 8);
      report.width = view.getUint32(0);
      report.height = view.getUint32(4);
    }
    if (type === 'iCCP') report.icc = true;
    const critical = (type.charCodeAt(0) & 0x20) === 0;
    if (PNG_REMOVE.has(type)) {
      const label = inspectPngChunk(bytes, chunk, report);
      report.removed.push({ label, bytes: chunk.end - chunk.start });
    } else if (critical || PNG_KEEP.has(type)) {
      parts.push(bytes.subarray(chunk.start, chunk.end));
    } else {
      report.removed.push({ label: `${type} (bloco auxiliar)`, bytes: chunk.end - chunk.start });
    }
  }
  report.trailingBytes = bytes.length - end;
  if (report.trailingBytes > 0) {
    report.removed.push({ label: 'Dados depois do fim da imagem', bytes: report.trailingBytes });
  }
  report.output = concat(parts);
  return report;
}

export function cleanImage(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = detectFormat(bytes);
  if (format === 'JPEG') return cleanJpeg(bytes);
  if (format === 'PNG') return cleanPng(bytes);
  throw new Error('Formato não suportado: use fotos JPEG ou PNG.');
}

// "ferias.jpg" → "ferias-limpa.jpg"
export function cleanFileName(name, format) {
  const fallbackExt = format === 'PNG' ? '.png' : '.jpg';
  const base = String(name || '').replace(/[\\/]/g, '_');
  const m = /^(.*?)(\.[^.]*)?$/.exec(base);
  const stem = m[1] || 'foto';
  const ext = m[2] && m[2].length > 1 ? m[2] : fallbackExt;
  return `${stem}-limpa${ext}`;
}
