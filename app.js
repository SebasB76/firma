import { extractInk, renderSignature } from './signature.js';

// Phone photos are 12+ MP; this keeps processing under a second without losing stroke detail.
const MAX_SIDE = 2000;
const STORE_KEY = 'firma:last';
const FILE_NAME = 'firma.png';

const $ = (id) => document.getElementById(id);
const state = {
  source: null,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  imageData: null,
  ink: null,
  color: 'black',
  strength: 1,
  blob: null,
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (!navigator.canShare) document.querySelectorAll('.share-only').forEach((el) => el.remove());
showSaved();

for (const input of [$('camera'), $('gallery')]) {
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (file) await openPhoto(file);
  });
}

$('colors').addEventListener('click', (e) => {
  const color = e.target.dataset.color;
  if (!color) return;
  state.color = color;
  for (const b of $('colors').children) b.setAttribute('aria-pressed', String(b === e.target));
  render();
});

let strengthTimer;
$('strength').addEventListener('input', (e) => {
  state.strength = Number(e.target.value);
  clearTimeout(strengthTimer);
  strengthTimer = setTimeout(processAndRender, 120);
});

$('crop-toggle').addEventListener('click', () => {
  const open = $('crop').hidden;
  $('crop').hidden = !open;
  $('crop-toggle').textContent = open ? 'Cerrar recorte' : 'Ajustar recorte';
  if (open) layoutCropBox();
});
$('crop-apply').addEventListener('click', () => {
  $('crop').hidden = true;
  $('crop-toggle').textContent = 'Ajustar recorte';
  processAndRender();
});

$('download').addEventListener('click', () => { save(); download(state.blob); });
$('share')?.addEventListener('click', () => { save(); share(state.blob); });
$('copy').addEventListener('click', async () => {
  save();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.blob })]);
    toast('Imagen copiada. Pégala en Word o en tu documento.');
  } catch {
    toast('Tu navegador no permite copiar imágenes. Usa Descargar.');
  }
});
$('restart').addEventListener('click', () => {
  $('editor').hidden = true;
  $('home').hidden = false;
  showSaved();
});

$('saved-download').addEventListener('click', async () => download(await savedBlob()));
$('saved-share')?.addEventListener('click', async () => share(await savedBlob()));

async function openPhoto(file) {
  $('home').hidden = true;
  $('editor').hidden = false;
  $('crop').hidden = true;
  $('crop-toggle').textContent = 'Ajustar recorte';
  setActionsEnabled(false);
  setStatus('Procesando…');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    setStatus('No pude abrir esa imagen.');
    return;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  state.source = canvas;
  state.crop = { x: 0, y: 0, w: 1, h: 1 };
  $('crop-img').src = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  // Let the status paint before the synchronous processing blocks the main thread.
  requestAnimationFrame(() => setTimeout(processAndRender, 0));
}

function processAndRender() {
  const { source, crop } = state;
  const x = Math.round(crop.x * source.width);
  const y = Math.round(crop.y * source.height);
  const w = Math.max(1, Math.round(crop.w * source.width));
  const h = Math.max(1, Math.round(crop.h * source.height));
  state.imageData = source.getContext('2d').getImageData(x, y, w, h);
  state.ink = extractInk(state.imageData, state.strength);
  render();
}

async function render() {
  const canvas = $('result');
  if (!state.ink?.bbox) {
    canvas.width = canvas.height = 0;
    state.blob = null;
    setActionsEnabled(false);
    setStatus('No encontré la firma. Sube la intensidad o ajusta el recorte.');
    return;
  }
  const out = renderSignature(state.imageData, state.ink.alpha, state.ink.bbox, state.color);
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext('2d').drawImage(out, 0, 0);
  setStatus('');
  state.blob = await out.convertToBlob({ type: 'image/png' });
  setActionsEnabled(true);
}

function setActionsEnabled(enabled) {
  for (const id of ['download', 'share', 'copy']) if ($(id)) $(id).disabled = !enabled;
}

function setStatus(text) {
  $('status').textContent = text;
}

function download(blob) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: FILE_NAME });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function share(blob) {
  if (!blob) return;
  const file = new File([blob], FILE_NAME, { type: 'image/png' });
  if (!navigator.canShare?.({ files: [file] })) return download(blob);
  try {
    await navigator.share({ files: [file], title: 'Firma' });
  } catch (err) {
    if (err.name !== 'AbortError') download(blob);
  }
}

function save() {
  if (!state.blob) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      localStorage.setItem(STORE_KEY, reader.result);
    } catch {
      // Storage full or disabled: the download still works, only the shortcut is lost.
    }
  };
  reader.readAsDataURL(state.blob);
}

function showSaved() {
  const dataUrl = localStorage.getItem(STORE_KEY);
  $('saved').hidden = !dataUrl;
  if (dataUrl) $('saved-img').src = dataUrl;
}

async function savedBlob() {
  return (await fetch(localStorage.getItem(STORE_KEY))).blob();
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}

const box = $('crop-box');
const img = $('crop-img');
let drag = null;

img.addEventListener('load', layoutCropBox);
window.addEventListener('resize', layoutCropBox);

function layoutCropBox() {
  const { x, y, w, h } = state.crop;
  Object.assign(box.style, {
    left: `${x * img.clientWidth}px`,
    top: `${y * img.clientHeight}px`,
    width: `${w * img.clientWidth}px`,
    height: `${h * img.clientHeight}px`,
  });
}

box.addEventListener('pointerdown', (e) => {
  drag = { handle: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, start: { ...state.crop } };
  box.setPointerCapture(e.pointerId);
  e.preventDefault();
});

box.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.x) / img.clientWidth;
  const dy = (e.clientY - drag.y) / img.clientHeight;
  const min = 0.05;
  let { x, y, w, h } = drag.start;
  if (drag.handle === 'move') {
    x = clamp(x + dx, 0, 1 - w);
    y = clamp(y + dy, 0, 1 - h);
  } else {
    let right = x + w;
    let bottom = y + h;
    if (drag.handle.includes('w')) x = clamp(x + dx, 0, right - min);
    if (drag.handle.includes('e')) right = clamp(right + dx, x + min, 1);
    if (drag.handle.includes('n')) y = clamp(y + dy, 0, bottom - min);
    if (drag.handle.includes('s')) bottom = clamp(bottom + dy, y + min, 1);
    w = right - x;
    h = bottom - y;
  }
  state.crop = { x, y, w, h };
  layoutCropBox();
});

box.addEventListener('pointerup', () => { drag = null; });
box.addEventListener('pointercancel', () => { drag = null; });

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
