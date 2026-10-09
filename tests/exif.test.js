import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTiff, summarizeExif, toDegrees, decodeUserComment, buildOrientationSegment, formatExifDate,
  parseXmpCoordinate, findXmpGps, osmUrl, cameraName, decodeText,
} from '../src/exif.js';
import { buildTiff, sampleTiff, bytes, ASCII, SHORT, LONG, RATIONAL, SAMPLE_XMP } from './helpers.js';

for (const order of ['II', 'MM']) {
  test(`lê IFD0, Exif, GPS e IFD1 na ordem ${order}`, () => {
    const tiff = readTiff(sampleTiff(order));
    assert.equal(tiff.byteOrder, order);
    const s = summarizeExif(tiff);
    assert.equal(s.make, 'Canon');
    assert.equal(s.model, 'Canon EOS Exemplo');
    assert.equal(s.software, 'Editor Exemplo 2.1');
    assert.equal(s.dateTime, '2024:05:01 14:30:00');
    assert.equal(s.dateTimeOriginal, '2024:05:01 14:29:58');
    assert.equal(s.offsetTimeOriginal, '-03:00');
    assert.equal(s.artist, 'Maria Exemplo');
    assert.equal(s.serialNumber, '0123456789');
    assert.equal(s.userComment, 'Viagem de teste');
    assert.equal(s.orientation, 6);
    assert.equal(s.thumbnailBytes, 4321);
    assert.ok(s.gps.hasCoordinates);
    assert.ok(Math.abs(s.gps.latitude - -(23 + 33 / 60 + 12.34 / 3600)) < 1e-9);
    assert.ok(Math.abs(s.gps.longitude - -(46 + 38 / 60 + 10 / 3600)) < 1e-9);
    assert.equal(s.gps.altitude, 760);
    assert.equal(s.gps.date, '2024:05:01');
    assert.equal(s.gps.time, '17:29:58');
  });
}

test('hemisférios norte e leste ficam positivos; altitude abaixo do mar fica negativa', () => {
  const tiff = buildTiff('MM', {
    ifd0: [],
    gps: [
      { tag: 1, type: ASCII, value: 'N' },
      { tag: 2, type: RATIONAL, value: [[48, 1], [51, 1], [2952, 100]] },
      { tag: 3, type: ASCII, value: 'E' },
      { tag: 4, type: RATIONAL, value: [[2, 1], [17, 1], [4020, 100]] },
      { tag: 5, type: 1, value: [1] },
      { tag: 6, type: RATIONAL, value: [[15, 2]] },
    ],
  });
  const { gps } = summarizeExif(readTiff(tiff));
  assert.ok(Math.abs(gps.latitude - (48 + 51 / 60 + 29.52 / 3600)) < 1e-9);
  assert.ok(Math.abs(gps.longitude - (2 + 17 / 60 + 40.2 / 3600)) < 1e-9);
  assert.equal(gps.altitude, -7.5);
});

test('toDegrees rejeita denominador zero, referência ausente e valores fora da faixa', () => {
  assert.equal(toDegrees([[10, 1], [0, 0], [0, 0]], 'S', ['N', 'S'], 90), -10);
  assert.equal(toDegrees([[10, 0]], 'S', ['N', 'S'], 90), null);
  assert.equal(toDegrees([[10, 1]], undefined, ['N', 'S'], 90), null);
  assert.equal(toDegrees([[10, 1]], 'E', ['N', 'S'], 90), null);
  assert.equal(toDegrees([[91, 1]], 'N', ['N', 'S'], 90), null);
  assert.equal(toDegrees([[179, 1], [59, 1]], 'w', ['E', 'W'], 180), -(179 + 59 / 60));
  assert.equal(toDegrees('lixo', 'N', ['N', 'S'], 90), null);
});

test('GPS sem coordenadas é marcado como incompleto', () => {
  const tiff = buildTiff('II', { gps: [{ tag: 0x1d, type: ASCII, value: '2024:01:02' }] });
  const { gps } = summarizeExif(readTiff(tiff));
  assert.equal(gps.hasCoordinates, false);
  assert.equal(gps.date, '2024:01:02');
});

test('foto sem IFD de GPS retorna gps null', () => {
  const tiff = buildTiff('II', { ifd0: [{ tag: 0x0112, type: SHORT, value: 1 }] });
  const s = summarizeExif(readTiff(tiff));
  assert.equal(s.gps, null);
  assert.equal(s.orientation, 1);
  assert.equal(s.make, null);
});

test('valores curtos ficam dentro da entrada e textos UTF-8 são decodificados', () => {
  const tiff = buildTiff('II', {
    ifd0: [
      { tag: 0x010f, type: ASCII, value: 'ABC' },
      { tag: 0x013b, type: ASCII, value: 'João Ação' },
    ],
  });
  const s = summarizeExif(readTiff(tiff));
  assert.equal(s.make, 'ABC');
  assert.equal(s.artist, 'João Ação');
});

test('readTiff rejeita cabeçalhos inválidos', () => {
  assert.throws(() => readTiff(bytes('XX', [0, 42, 0, 0, 0, 8])), /ordem de bytes/);
  assert.throws(() => readTiff(bytes('II', [43, 0, 8, 0, 0, 0])), /Cabeçalho TIFF/);
  assert.throws(() => readTiff(bytes('II')), /curto/);
});

test('readTiff resiste a ponteiros em laço e fora do arquivo', () => {
  const tiff = buildTiff('II', { ifd0: [{ tag: 0x0112, type: SHORT, value: 3 }] });
  const view = new DataView(tiff.buffer);
  view.setUint32(8 + 2 + 12, 8, true); // próximo IFD aponta para o próprio IFD0
  const loop = readTiff(tiff);
  assert.equal(loop.ifd0.get(0x0112), 3);
  assert.equal(loop.ifd1.size, 0);

  const broken = buildTiff('MM', {
    ifd0: [
      { tag: 0x8769, type: LONG, value: 999999 },
      { tag: 0x010f, type: ASCII, value: 'Fabricante longo' },
    ],
  });
  const bv = new DataView(broken.buffer);
  bv.setUint32(8 + 2 + 8, 50000); // deslocamento do texto (primeira entrada) fora do bloco
  const s = summarizeExif(readTiff(broken));
  assert.equal(s.make, null);
  assert.equal(s.gps, null);
});

test('decodeUserComment trata ASCII, UNICODE e vazio', () => {
  assert.equal(decodeUserComment(bytes('ASCII\0\0\0', 'Olá'), 'II'), 'Olá');
  const utf16be = bytes('UNICODE\0', [0, 0x4f, 0, 0x69]);
  assert.equal(decodeUserComment(utf16be, 'MM'), 'Oi');
  const utf16le = bytes('UNICODE\0', [0x4f, 0, 0x69, 0]);
  assert.equal(decodeUserComment(utf16le, 'II'), 'Oi');
  assert.equal(decodeUserComment(bytes(new Uint8Array(8), '      '), 'II'), null);
  assert.equal(decodeUserComment(undefined, 'II'), null);
});

test('decodeText corta no NUL e aceita Latin-1', () => {
  assert.equal(decodeText(bytes('Canon\0lixo')), 'Canon');
  assert.equal(decodeText(Uint8Array.from([0x53, 0xe3, 0x6f])), 'São');
});

test('segmento mínimo de orientação tem 36 bytes e só a tag 0x0112', () => {
  const seg = buildOrientationSegment(6);
  assert.equal(seg.length, 36);
  assert.deepEqual([...seg.subarray(0, 4)], [0xff, 0xe1, 0, 34]);
  assert.equal(new TextDecoder().decode(seg.subarray(4, 10)), 'Exif\0\0');
  const tiff = readTiff(seg, 10);
  assert.deepEqual([...tiff.ifd0.entries()], [[0x0112, 6]]);
  assert.equal(tiff.gps, null);
  assert.equal(tiff.exif.size, 0);
  assert.throws(() => buildOrientationSegment(9));
});

test('formatExifDate converte para o padrão brasileiro', () => {
  assert.equal(formatExifDate('2024:05:01 14:30:00'), '01/05/2024 14:30:00');
  assert.equal(formatExifDate('2024:05:01'), '01/05/2024');
  assert.equal(formatExifDate('0000:00:00 00:00:00'), null);
  assert.equal(formatExifDate('    :  :     :  :  '), null);
  assert.equal(formatExifDate(null), null);
  assert.equal(formatExifDate('ontem à tarde 2'), 'ontem à tarde 2');
});

test('coordenadas XMP nos formatos DDD,MM,SSk e DDD,MM.mmk', () => {
  assert.equal(parseXmpCoordinate('23,30S', ['N', 'S'], 90), -23.5);
  assert.ok(Math.abs(parseXmpCoordinate('46,37,48W', ['E', 'W'], 180) - -46.63) < 1e-9);
  assert.equal(parseXmpCoordinate('10,15.5N', ['N', 'S'], 90), 10 + 15.5 / 60);
  assert.equal(parseXmpCoordinate('10,15E', ['N', 'S'], 90), null);
  assert.equal(parseXmpCoordinate('abc', ['N', 'S'], 90), null);
  const gps = findXmpGps(SAMPLE_XMP);
  assert.ok(Math.abs(gps.latitude - -(15 + 47.6 / 60)) < 1e-9);
  assert.ok(Math.abs(gps.longitude - -(47 + 52.2 / 60)) < 1e-9);
  const element = findXmpGps('<exif:GPSLatitude>1,30N</exif:GPSLatitude><exif:GPSLongitude>2,15E</exif:GPSLongitude>');
  assert.deepEqual(element, { latitude: 1.5, longitude: 2.25 });
  assert.equal(findXmpGps('<x:xmpmeta/>'), null);
});

test('link do OpenStreetMap usa ponto decimal e 6 casas', () => {
  assert.equal(osmUrl(-23.5534278, -46.6361111), 'https://www.openstreetmap.org/?mlat=-23.553428&mlon=-46.636111');
});

test('cameraName evita repetir o fabricante', () => {
  assert.equal(cameraName('Canon', 'Canon EOS Exemplo'), 'Canon EOS Exemplo');
  assert.equal(cameraName('Apple', 'iPhone Exemplo'), 'Apple iPhone Exemplo');
  assert.equal(cameraName(null, 'Modelo X'), 'Modelo X');
  assert.equal(cameraName(null, null), null);
});
