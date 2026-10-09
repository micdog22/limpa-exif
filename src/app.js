import { cleanImage, cleanFileName } from './clean.js';
import { ORIENTATION_LABELS, formatExifDate, osmUrl, cameraName } from './exif.js';
import { createZip, uniqueName } from './zip.js';

const input = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const list = document.getElementById('results');
const statusEl = document.getElementById('status');
const btnZip = document.getElementById('download-all');
const btnClear = document.getElementById('clear');

const items = []; // { name, data, url }
const urls = [];
let busy = false;

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const coord = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const integer = new Intl.NumberFormat('pt-BR');

function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n;
  let i = -1;
  do {
    value /= 1000;
    i++;
  } while (value >= 1000 && i < units.length - 1);
  return `${decimal.format(value)} ${units[i]}`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function refreshButtons() {
  btnZip.disabled = busy || items.length === 0;
  btnClear.disabled = busy || list.querySelector('.result') === null;
}

function renderEmpty() {
  list.replaceChildren(el('li', { class: 'empty' }, 'Nenhuma foto ainda. As fotos que você escolher aparecem aqui, com o que foi encontrado em cada uma.'));
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function factsFor(report) {
  const rows = [];
  const add = (label, value) => {
    if (value) rows.push([label, value]);
  };
  const exif = report.exif || {};
  add('Câmera', cameraName(exif.make, exif.model));
  add('Lente', cameraName(exif.lensMake, exif.lensModel));
  const date = formatExifDate(exif.dateTimeOriginal) || formatExifDate(exif.dateTime);
  add('Data e hora', date && exif.offsetTimeOriginal ? `${date} (fuso ${exif.offsetTimeOriginal})` : date);
  if (exif.gps && exif.gps.date) {
    const gpsDate = formatExifDate(exif.gps.date);
    add('Data e hora do GPS', gpsDate && `${gpsDate}${exif.gps.time ? ` ${exif.gps.time}` : ''} (UTC)`);
  }
  add('Modificada em', report.modified);
  add('Programa', exif.software);
  if (report.orientation) {
    const label = ORIENTATION_LABELS[report.orientation];
    add('Orientação', label ? `${report.orientation} (para exibir: ${label})` : String(report.orientation));
  }
  add('Autor', exif.artist);
  add('Direitos autorais', exif.copyright);
  add('Descrição', exif.description);
  add('Dono da câmera', exif.ownerName);
  add('Número de série', exif.serialNumber);
  if (report.comments.length) add('Comentários', listOf(report.comments.map((c) => truncate(c))));
  const texts = report.texts.map((t) => (t.text ? `${t.keyword}: ${truncate(t.text)}` : `${t.keyword} (texto compactado)`));
  if (texts.length) add('Textos no PNG', listOf(texts));
  add('XMP', report.xmp && 'presente');
  add('IPTC/Photoshop', report.iptc && 'presente');
  add('Miniatura embutida', report.thumbnail && 'presente (pode mostrar a foto antes de um corte)');
  add('Imagens adicionais', report.mpf && 'índice MPF presente');
  if (report.trailingBytes) add('Dados no fim do arquivo', formatBytes(report.trailingBytes));
  if (report.exifError) add('Bloco Exif', `ilegível (${report.exifError})`);
  return rows;
}

function listOf(values) {
  return el('ul', {}, ...values.map((v) => el('li', {}, v)));
}

function gpsAlert(report) {
  if (report.gps) {
    const { latitude, longitude, altitude, source } = report.gps;
    let where = `Latitude ${coord.format(latitude)}, longitude ${coord.format(longitude)}`;
    if (altitude !== null && altitude !== undefined) where += `, altitude ${integer.format(Math.round(altitude))} m`;
    return el('div', { class: 'alert', role: 'note' },
      el('strong', { class: 'alert-title' }, 'Esta foto revela onde foi tirada'),
      el('p', {}, `${where} (gravado no ${source}).`),
      el('p', {},
        el('a', { href: osmUrl(latitude, longitude), target: '_blank', rel: 'noopener noreferrer' }, 'Ver o local no mapa (OpenStreetMap)'),
        '. O link só abre se você clicar; nada é enviado automaticamente.'),
    );
  }
  if (report.gpsWithoutCoordinates) {
    return el('div', { class: 'alert', role: 'note' },
      el('strong', { class: 'alert-title' }, 'Esta foto tem dados de GPS'),
      el('p', {}, 'Há um bloco de GPS, mas sem coordenadas completas. Ele também é removido na cópia limpa.'));
  }
  return null;
}

function renderResult(file, report) {
  const cleanName = cleanFileName(file.name, report.format);
  const blob = new Blob([report.output], { type: report.format === 'PNG' ? 'image/png' : 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  urls.push(url);
  items.push({ name: cleanName, data: report.output });

  const removedBytes = file.size - report.output.length;
  const dims = report.width && report.height ? `${report.width} × ${report.height} px · ` : '';
  const sizes = `${formatBytes(file.size)} → ${formatBytes(report.output.length)}`;

  const facts = factsFor(report);
  const factList = facts.length
    ? el('dl', { class: 'facts' }, ...facts.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]))
    : el('p', { class: 'note' }, 'Nenhum metadado de identificação encontrado.');

  let removedInfo;
  if (report.removed.length) {
    removedInfo = el('details', { class: 'removed' },
      el('summary', {}, `Removido: ${report.removed.length} ${report.removed.length === 1 ? 'item' : 'itens'} (${formatBytes(Math.max(removedBytes, 0))} a menos)`),
      listOf(report.removed.map((r) => `${r.label}: ${formatBytes(r.bytes)}`)));
  } else {
    removedInfo = el('p', { class: 'note' }, 'Nada a remover: a cópia é igual ao original.');
  }

  const orientationNote = report.orientationKept
    ? el('p', { class: 'note' }, `Mantivemos só a orientação (valor ${report.orientationKept}) para a foto não aparecer girada.`)
    : report.format === 'PNG' && report.orientation && report.orientation !== 1
      ? el('p', { class: 'note' }, `A orientação gravada no eXIf (valor ${report.orientation}) foi removida junto com ele.`)
      : null;

  const li = el('li', { class: 'result' },
    el('div', { class: 'result-head' },
      el('img', { class: 'thumb', src: url, alt: `Prévia de ${file.name}`, loading: 'lazy', decoding: 'async' }),
      el('div', {},
        el('h3', { class: 'result-title' }, file.name),
        el('p', { class: 'result-meta' }, `${report.format} · ${dims}${sizes}`),
        el('p', { class: 'result-meta' }, report.removed.length
          ? el('span', { class: 'ok-text' }, 'Cópia limpa pronta')
          : 'Já estava sem metadados'))),
    gpsAlert(report),
    factList,
    removedInfo,
    orientationNote,
    el('div', { class: 'actions' },
      el('a', { class: 'btn', href: url, download: cleanName, 'aria-label': `Baixar ${cleanName}` }, 'Baixar cópia limpa')),
  );
  list.append(li);
}

function renderError(file, message) {
  list.append(el('li', { class: 'result error' },
    el('h3', { class: 'result-title' }, file.name || 'Arquivo sem nome'),
    el('p', { class: 'result-meta' }, message)));
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length || busy) return;
  busy = true;
  refreshButtons();
  if (!list.querySelector('.result')) list.replaceChildren();
  let withGps = 0;
  let failures = 0;
  for (const [index, file] of files.entries()) {
    setStatus(`Lendo ${index + 1} de ${files.length}: ${file.name}…`);
    try {
      const report = cleanImage(new Uint8Array(await file.arrayBuffer()));
      if (report.gps || report.gpsWithoutCoordinates) withGps++;
      renderResult(file, report);
    } catch (err) {
      failures++;
      renderError(file, err instanceof Error ? err.message : 'Não foi possível ler este arquivo.');
    }
  }
  busy = false;
  const done = files.length - failures;
  const parts = [`${done} ${done === 1 ? 'foto pronta' : 'fotos prontas'}`];
  if (withGps) parts.push(`${withGps} com localização`);
  if (failures) parts.push(`${failures} com erro`);
  setStatus(`${parts.join(' · ')}.`);
  refreshButtons();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

btnZip.addEventListener('click', () => {
  try {
    const used = new Set();
    const zip = createZip(items.map((item) => ({ name: uniqueName(item.name, used), data: item.data })));
    downloadBlob(new Blob([zip], { type: 'application/zip' }), 'fotos-limpas.zip');
    setStatus(`ZIP com ${items.length} ${items.length === 1 ? 'foto' : 'fotos'} gerado.`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Não foi possível montar o ZIP.');
  }
});

btnClear.addEventListener('click', () => {
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  items.length = 0;
  renderEmpty();
  setStatus('Lista limpa.');
  refreshButtons();
});

input.addEventListener('change', () => {
  handleFiles(input.files);
  input.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('dragging');
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

renderEmpty();
setStatus('Pronto. Escolha ou arraste as fotos para começar.');
refreshButtons();
