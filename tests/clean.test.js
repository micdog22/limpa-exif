import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanImage, cleanJpeg, cleanPng, detectFormat, parseJpeg, cleanFileName } from '../src/clean.js';
import { readTiff, buildOrientationSegment } from '../src/exif.js';
import {
  bytes, sampleJpeg, sampleTiff, jpegMarkers, SOI, EOI, SCAN, jfif, exifSegment, xmpSegment, comment, dqt, sof0, dht, sos,
  segment, pngChunk, ihdr, listPngChunks, PNG_SIGNATURE, buildTiff, SAMPLE_XMP,
} from './helpers.js';

const scanPart = (data) => {
  const sosIndex = jpegMarkers(data).find((m) => m.marker === 0xda);
  return data.subarray(sosIndex.start);
};

for (const order of ['II', 'MM']) {
  test(`JPEG ${order}: encontra GPS, câmera, XMP, IPTC, comentários e miniatura`, () => {
    const report = cleanImage(sampleJpeg(order));
    assert.equal(report.format, 'JPEG');
    assert.equal(report.width, 640);
    assert.equal(report.height, 480);
    assert.equal(report.exif.make, 'Canon');
    assert.equal(report.exif.model, 'Canon EOS Exemplo');
    assert.equal(report.exif.dateTimeOriginal, '2024:05:01 14:29:58');
    assert.equal(report.exif.software, 'Editor Exemplo 2.1');
    assert.equal(report.orientation, 6);
    assert.equal(report.gps.source, 'EXIF');
    assert.ok(Math.abs(report.gps.latitude - -23.5534278) < 1e-6);
    assert.ok(Math.abs(report.gps.longitude - -46.6361111) < 1e-6);
    assert.equal(report.gps.altitude, 760);
    assert.equal(report.xmp, true);
    assert.equal(report.iptc, true);
    assert.equal(report.icc, true);
    assert.equal(report.mpf, true);
    assert.equal(report.thumbnail, true);
    assert.deepEqual(report.comments, ['Viagem de teste', 'Foto de teste']);
    assert.equal(report.trailingBytes, 'dados extras depois do fim'.length);
  });

  test(`JPEG ${order}: a cópia limpa tem só o EXIF mínimo de orientação e o scan idêntico`, () => {
    const original = sampleJpeg(order);
    const report = cleanJpeg(original);
    const out = report.output;
    const markers = jpegMarkers(out).map((m) => m.marker);
    assert.deepEqual(markers, [0xe0, 0xe1, 0xe2, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
    assert.deepEqual([...out.subarray(0, 2)], SOI);

    const app1 = jpegMarkers(out).find((m) => m.marker === 0xe1);
    assert.deepEqual(out.subarray(app1.start, app1.end), buildOrientationSegment(6));
    const tiff = readTiff(out, app1.start + 10, app1.end);
    assert.deepEqual([...tiff.ifd0.keys()], [0x0112]);
    assert.equal(tiff.ifd0.get(0x0112), 6);
    assert.equal(report.orientationKept, 6);

    // O EXIF mínimo vem logo depois do APP0
    const app0 = jpegMarkers(out)[0];
    assert.equal(app1.start, app0.end);

    // Dados da imagem byte a byte iguais, e nada depois do EOI
    const expectedScan = bytes(sos(), SCAN, EOI);
    assert.deepEqual(scanPart(out), expectedScan);
    assert.deepEqual(scanPart(original).subarray(0, expectedScan.length), expectedScan);
    assert.deepEqual([...out.subarray(-2)], EOI);

    const labels = report.removed.map((r) => r.label);
    assert.deepEqual(labels, [
      'APP1 (Exif)', 'APP1 (XMP)', 'APP2 (MPF, imagens adicionais)', 'APP13 (IPTC/Photoshop)',
      'Comentário (COM)', 'Dados depois do fim da imagem',
    ]);
    const removedBytes = report.removed.reduce((n, r) => n + r.bytes, 0);
    assert.equal(out.length, original.length - removedBytes + 36);
  });
}

test('limpar de novo a cópia limpa não muda nada', () => {
  const once = cleanJpeg(sampleJpeg('II')).output;
  const twice = cleanJpeg(once);
  assert.deepEqual(twice.output, once);
  assert.equal(twice.orientationKept, 6);
  assert.deepEqual(twice.removed.map((r) => r.label), ['APP1 (Exif)']);
});

test('orientação 1 ou ausente não gera APP1', () => {
  for (const orientation of [1, null]) {
    const report = cleanJpeg(sampleJpeg('MM', { orientation }));
    assert.equal(report.orientationKept, null);
    assert.ok(!jpegMarkers(report.output).some((m) => m.marker === 0xe1));
  }
});

test('sem APP0, o EXIF mínimo vai logo depois do SOI', () => {
  const original = bytes(SOI, exifSegment(sampleTiff('II', { orientation: 8 })), dqt(), sof0(10, 20), dht(), sos(), SCAN, EOI);
  const report = cleanJpeg(original);
  assert.deepEqual(report.output, bytes(SOI, buildOrientationSegment(8), dqt(), sof0(10, 20), dht(), sos(), SCAN, EOI));
  assert.equal(report.width, 10);
  assert.equal(report.height, 20);
});

test('JPEG sem metadados sai idêntico', () => {
  const original = bytes(SOI, jfif(), dqt(), sof0(8, 8), dht(), sos(), SCAN, EOI);
  const report = cleanJpeg(original);
  assert.deepEqual(report.output, original);
  assert.deepEqual(report.removed, []);
  assert.equal(report.gps, null);
});

test('mantém APP14 Adobe e ICC; remove FPXR, JFXX, APPn e comentários entre scans progressivos', () => {
  const adobe = segment(0xee, bytes('Adobe', [0, 100, 0, 0, 0, 0, 1]));
  const fpxr = segment(0xe2, bytes('FPXR\0', [0, 1, 2]));
  const jfxx = segment(0xe0, bytes('JFXX\0', [0x10, 1, 2, 3]));
  const app11 = segment(0xeb, bytes('JP', [0, 0, 1]));
  const original = bytes(
    SOI, jfif(), jfxx, adobe, fpxr, app11, dqt(), segment(0xc2, bytes([8, 0, 4, 0, 4, 1, 1, 0x11, 0])),
    dht(), sos(), SCAN, comment('entre scans'), dht(), sos(), Uint8Array.from([0xaa, 0xff, 0x00, 0xbb]), EOI,
  );
  const report = cleanJpeg(original);
  assert.deepEqual(report.removed.map((r) => r.label), ['APP0 (JFXX, miniatura)', 'APP2 (FPXR)', 'APP11', 'Comentário (COM)']);
  assert.deepEqual(
    report.output,
    bytes(SOI, jfif(), adobe, dqt(), segment(0xc2, bytes([8, 0, 4, 0, 4, 1, 1, 0x11, 0])), dht(), sos(), SCAN, dht(), sos(),
      Uint8Array.from([0xaa, 0xff, 0x00, 0xbb]), EOI),
  );
  assert.equal(report.width, 4);
});

test('GPS só no XMP também é detectado', () => {
  const original = bytes(SOI, jfif(), xmpSegment(SAMPLE_XMP), dqt(), sof0(8, 8), sos(), SCAN, EOI);
  const report = cleanJpeg(original);
  assert.equal(report.gps.source, 'XMP');
  assert.ok(Math.abs(report.gps.latitude - -(15 + 47.6 / 60)) < 1e-9);
  assert.equal(report.xmp, true);
});

test('EXIF com GPS sem coordenadas sinaliza gpsWithoutCoordinates', () => {
  const tiff = buildTiff('II', { gps: [{ tag: 0x1d, type: 2, value: '2024:01:02' }] });
  const report = cleanJpeg(bytes(SOI, exifSegment(tiff), sos(), SCAN, EOI));
  assert.equal(report.gps, null);
  assert.equal(report.gpsWithoutCoordinates, true);
});

test('EXIF corrompido não impede a limpeza', () => {
  const report = cleanJpeg(bytes(SOI, segment(0xe1, bytes('Exif\0\0', 'XX', [0, 0])), sos(), SCAN, EOI));
  assert.match(report.exifError, /ordem de bytes|curto/);
  assert.deepEqual(report.output, bytes(SOI, sos(), SCAN, EOI));
});

test('JPEG sem EOI (cortado no meio do scan) é copiado até o fim', () => {
  const original = bytes(SOI, comment('x'), sos(), SCAN);
  const report = cleanJpeg(original);
  assert.deepEqual(report.output, bytes(SOI, sos(), SCAN));
  assert.equal(report.trailingBytes, 0);
});

test('JPEG truncado ou malformado gera erro amigável', () => {
  assert.throws(() => cleanJpeg(bytes(SOI, [0xff, 0xe1, 0x00, 0x40, 1, 2])), /incompleto/);
  assert.throws(() => cleanJpeg(bytes(SOI, [0x12, 0x34])), /Estrutura JPEG inesperada/);
  assert.throws(() => parseJpeg(bytes([0x00, 0x01])), /JPEG inválido/);
});

test('detectFormat e cleanImage recusam formatos desconhecidos', () => {
  assert.equal(detectFormat(bytes(SOI, [0xff])), 'JPEG');
  assert.equal(detectFormat(Uint8Array.from(PNG_SIGNATURE)), 'PNG');
  assert.equal(detectFormat(bytes('GIF89a')), null);
  assert.throws(() => cleanImage(bytes('RIFF....WEBP')), /Formato não suportado/);
  assert.throws(() => cleanImage(new Uint8Array(0)), /Formato não suportado/);
});

function samplePng() {
  const exif = buildTiff('II', {
    ifd0: [{ tag: 0x0110, type: 2, value: 'Celular Exemplo' }, { tag: 0x0112, type: 3, value: 8 }],
    gps: [
      { tag: 1, type: 2, value: 'S' },
      { tag: 2, type: 5, value: [[3, 1], [43, 1], [0, 1]] },
      { tag: 3, type: 2, value: 'W' },
      { tag: 4, type: 5, value: [[38, 1], [32, 1], [0, 1]] },
    ],
  });
  return bytes(
    PNG_SIGNATURE,
    ihdr(2, 3),
    pngChunk('iCCP', bytes('perfil\0', [0], [1, 2, 3])),
    pngChunk('sRGB', [0]),
    pngChunk('gAMA', [0, 0, 0xb1, 0x8f]),
    pngChunk('cHRM', new Uint8Array(32)),
    pngChunk('pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]),
    pngChunk('tEXt', bytes('Author\0Maria Exemplo')),
    pngChunk('tEXt', bytes('Software\0Editor Exemplo')),
    pngChunk('zTXt', bytes('Comment\0', [0], [0x78, 0x9c, 0x03, 0x00])),
    pngChunk('iTXt', bytes('XML:com.adobe.xmp\0', [0, 0], '\0\0', SAMPLE_XMP)),
    pngChunk('iTXt', bytes('Description\0', [0, 0], 'pt-BR\0Descrição\0', 'Praia à tarde')),
    pngChunk('eXIf', exif),
    pngChunk('tIME', [0x07, 0xe8, 5, 1, 17, 29, 58]),
    pngChunk('tRNS', [0, 0]),
    pngChunk('prVt', bytes('privado')),
    pngChunk('IDAT', [0x78, 0x9c, 1, 2, 3, 4]),
    pngChunk('IDAT', [5, 6, 7]),
    pngChunk('IEND', []),
    'lixo no fim',
  );
}

test('PNG: lê eXIf, textos e tIME e remove só os blocos de metadados', () => {
  const original = samplePng();
  const report = cleanPng(original);
  assert.equal(report.format, 'PNG');
  assert.equal(report.width, 2);
  assert.equal(report.height, 3);
  assert.equal(report.exif.model, 'Celular Exemplo');
  assert.equal(report.orientation, 8);
  assert.equal(report.orientationKept, null);
  assert.equal(report.gps.source, 'EXIF');
  assert.ok(Math.abs(report.gps.latitude - -(3 + 43 / 60)) < 1e-9);
  assert.ok(Math.abs(report.gps.longitude - -(38 + 32 / 60)) < 1e-9);
  assert.equal(report.xmp, true);
  assert.equal(report.icc, true);
  assert.equal(report.modified, '01/05/2024 17:29:58 (UTC)');
  assert.deepEqual(report.texts, [
    { keyword: 'Author', text: 'Maria Exemplo', compressed: false },
    { keyword: 'Software', text: 'Editor Exemplo', compressed: false },
    { keyword: 'Comment', text: null, compressed: true },
    { keyword: 'Description', text: 'Praia à tarde', compressed: false },
  ]);

  const chunks = listPngChunks(report.output);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS', 'IDAT', 'IDAT', 'IEND']);
  assert.ok(chunks.every((c) => c.crcOk));
  assert.deepEqual([...report.output.subarray(0, 8)], PNG_SIGNATURE);
  const idat = (data) => listPngChunks(data).filter((c) => c.type === 'IDAT').map((c) => [...c.data]);
  assert.deepEqual(idat(report.output), idat(original));
  assert.deepEqual(report.removed.map((r) => r.label), [
    'tEXt (texto «Author»)', 'tEXt (texto «Software»)', 'zTXt (texto «Comment»)', 'iTXt (XMP)',
    'iTXt (texto «Description»)', 'eXIf (Exif)', 'tIME (data de modificação)', 'prVt (bloco auxiliar)',
    'Dados depois do fim da imagem',
  ]);
});

test('PNG sem metadados sai idêntico', () => {
  const original = bytes(PNG_SIGNATURE, ihdr(1, 1), pngChunk('IDAT', [1, 2]), pngChunk('IEND', []));
  const report = cleanPng(original);
  assert.deepEqual(report.output, original);
  assert.deepEqual(report.removed, []);
});

test('PNG incompleto ou corrompido gera erro amigável', () => {
  const noEnd = bytes(PNG_SIGNATURE, ihdr(1, 1), pngChunk('IDAT', [1, 2]));
  assert.throws(() => cleanPng(noEnd), /IEND/);
  const cut = bytes(PNG_SIGNATURE, ihdr(1, 1)).subarray(0, 20);
  assert.throws(() => cleanPng(cut), /incompleto/);
  const badType = bytes(PNG_SIGNATURE, [0, 0, 0, 0], '1234', [0, 0, 0, 0]);
  assert.throws(() => cleanPng(badType), /corrompido/);
});

test('cleanFileName acrescenta "-limpa" antes da extensão', () => {
  assert.equal(cleanFileName('ferias.jpg', 'JPEG'), 'ferias-limpa.jpg');
  assert.equal(cleanFileName('IMG.2024.JPEG', 'JPEG'), 'IMG.2024-limpa.JPEG');
  assert.equal(cleanFileName('captura', 'PNG'), 'captura-limpa.png');
  assert.equal(cleanFileName('', 'JPEG'), 'foto-limpa.jpg');
  assert.equal(cleanFileName('a/b.png', 'PNG'), 'a_b-limpa.png');
});
