// Turns a photo of ink on paper into an alpha mask of the ink. Mirrors the `firma` CLI.

export const COLORS = { black: [20, 20, 20], blue: [20, 40, 140] };

export function extractInk(imageData, strength = 1) {
  const { width: w, height: h, data } = imageData;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Dividing by the local paper brightness flattens shadows and uneven light.
  const bg = estimateBackground(gray, w, h);
  const norm = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) norm[i] = (gray[i] / Math.max(bg[i], 1)) * 255;

  // Paper normalizes to ~255, so cap the cut-off to avoid picking up paper grain.
  const cut = Math.min(otsu(norm), 235) * strength;
  const lo = cut * 0.55;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Soft ramp instead of a hard threshold keeps anti-aliased stroke edges.
    alpha[i] = Math.min(1, Math.max(0, (cut - norm[i]) / Math.max(cut - lo, 1)));
  }

  const keep = dilate(keptComponents(alpha, w, h), w, h, 2);
  for (let i = 0; i < w * h; i++) if (!keep[i]) alpha[i] = 0;

  return { alpha, bbox: inkBounds(alpha, w, h) };
}

export function renderSignature(imageData, alpha, bbox, color, maxWidth = 1600) {
  const { x, y, w: bw, h: bh } = bbox;
  const src = imageData.data;
  const out = new ImageData(bw, bh);
  const fixed = COLORS[color];
  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      const s = (y + row) * imageData.width + (x + col);
      const o = (row * bw + col) * 4;
      if (fixed) {
        out.data.set(fixed, o);
      } else {
        // Darken the real ink so faint pen strokes still read as ink.
        out.data[o] = src[s * 4] * 0.6;
        out.data[o + 1] = src[s * 4 + 1] * 0.6;
        out.data[o + 2] = src[s * 4 + 2] * 0.6;
      }
      out.data[o + 3] = alpha[s] * 255;
    }
  }

  const full = new OffscreenCanvas(bw, bh);
  full.getContext('2d').putImageData(out, 0, 0);
  if (bw <= maxWidth) return full;
  const scale = maxWidth / bw;
  const small = new OffscreenCanvas(maxWidth, Math.round(bh * scale));
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, small.width, small.height);
  return small;
}

function estimateBackground(gray, w, h) {
  // Ink strokes are thin, so a bright percentile of each block is the paper under them.
  const block = Math.max(16, Math.round(Math.max(w, h) / 40));
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const grid = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          hist[gray[y * w + x] | 0]++;
          n++;
        }
      }
      let acc = 0;
      let v = 255;
      while (v > 0 && (acc += hist[v]) < n * 0.25) v--;
      grid[by * bw + bx] = v;
    }
  }

  const smooth = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { sum += grid[yy * bw + xx]; n++; }
        }
      }
      smooth[y * bw + x] = sum / n;
    }
  }

  // Bilinear upsample from block centers.
  const bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(Math.max((y + 0.5) / block - 0.5, 0), bh - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(y0 + 1, bh - 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(Math.max((x + 0.5) / block - 0.5, 0), bw - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(x0 + 1, bw - 1);
      const fx = gx - x0;
      const top = smooth[y0 * bw + x0] * (1 - fx) + smooth[y0 * bw + x1] * fx;
      const bottom = smooth[y1 * bw + x0] * (1 - fx) + smooth[y1 * bw + x1] * fx;
      bg[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return bg;
}

function otsu(values) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const diff = sumB / wB - (sumAll - sumB) / wF;
    const between = wB * wF * diff * diff;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

function keptComponents(alpha, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const keep = new Uint8Array(w * h);
  const minArea = Math.max(8, Math.round(w * h * 0.00002));
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || alpha[start] <= 0.35) continue;
    label++;
    let top = 0;
    let area = 0;
    let touchesBorder = false;
    const pixels = [];
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const p = stack[--top];
      pixels.push(p);
      area++;
      const px = p % w;
      const py = (p / w) | 0;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (!labels[q] && alpha[q] > 0.35) { labels[q] = label; stack[top++] = q; }
        }
      }
    }
    // Blobs on the border are usually the table or the paper edge, not ink.
    if (area >= minArea && !touchesBorder) for (const p of pixels) keep[p] = 1;
  }
  return keep;
}

function dilate(mask, w, h, r) {
  // Grows the kept mask so the soft edges around strokes survive.
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) tmp[y * w + k] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) out[k * w + x] = 1;
    }
  }
  return out;
}

function inkBounds(alpha, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.1) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(w, h) * 0.01) + 4;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
