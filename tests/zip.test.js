import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createZip, dosDateTime, uniqueName } from '../src/zip.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

test('CRC-32 do vetor padrão "123456789" é cbf43926', () => {
  assert.equal(crc32(enc.encode('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')).toString(16), '414fa339');
});

test('CRC-32 pode ser calculado em partes', () => {
  const data = enc.encode('Fotos de exemplo para o teste de CRC em partes');
  for (const cut of [0, 1, 7, 20, data.length]) {
    assert.equal(crc32(data.subarray(cut), crc32(data.subarray(0, cut))), crc32(data));
  }
});

test('data e hora no formato do MS-DOS', () => {
  const { time, day } = dosDateTime(new Date(2026, 9, 8, 14, 35, 51));
  assert.equal(time, (14 << 11) | (35 << 5) | 25);
  assert.equal(day, ((2026 - 1980) << 9) | (10 << 5) | 8);
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1)), { time: 0, day: 33 });
});

function readZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  assert.equal(view.getUint16(eocd + 8, true), count);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd);
  assert.equal(view.getUint16(eocd + 20, true), 0);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // cabeçalho local correspondente
    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    assert.equal(view.getUint16(localOffset + 6, true), flags);
    assert.equal(view.getUint16(localOffset + 8, true), method);
    assert.equal(view.getUint32(localOffset + 14, true), crc);
    assert.equal(view.getUint32(localOffset + 18, true), compSize);
    assert.equal(view.getUint32(localOffset + 22, true), size);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    assert.equal(dec.decode(zip.subarray(localOffset + 30, localOffset + 30 + localNameLen)), name);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const data = zip.subarray(dataStart, dataStart + compSize);
    entries.push({ name, flags, method, crc, compSize, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, eocd);
  return entries;
}

test('ZIP sem compressão com nomes UTF-8 tem estrutura válida', () => {
  const files = [
    { name: 'praia-limpa.jpg', data: Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) },
    { name: 'coração-ção.png', data: enc.encode('conteúdo de teste') },
    { name: 'vazio.txt', data: new Uint8Array(0) },
  ];
  const zip = createZip(files, new Date(2026, 9, 8, 10, 0, 0));
  const entries = readZip(zip);
  assert.equal(entries.length, 3);
  entries.forEach((entry, i) => {
    assert.equal(entry.name, files[i].name);
    assert.equal(entry.flags & 0x0800, 0x0800);
    assert.equal(entry.method, 0);
    assert.equal(entry.size, files[i].data.length);
    assert.equal(entry.compSize, files[i].data.length);
    assert.equal(entry.crc, crc32(files[i].data));
    assert.deepEqual(entry.data, files[i].data);
  });
});

test('ZIP vazio tem só o registro final de 22 bytes', () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(readZip(zip), []);
});

test('uniqueName evita nomes repetidos (sem diferenciar maiúsculas)', () => {
  const used = new Set();
  assert.equal(uniqueName('foto-limpa.jpg', used), 'foto-limpa.jpg');
  assert.equal(uniqueName('foto-limpa.jpg', used), 'foto-limpa (2).jpg');
  assert.equal(uniqueName('FOTO-LIMPA.jpg', used), 'FOTO-LIMPA (3).jpg');
  assert.equal(uniqueName('sem-extensao', used), 'sem-extensao');
  assert.equal(uniqueName('sem-extensao', used), 'sem-extensao (2)');
});
