// Finds signature spots in a .docx and places the signature PNG on one of them.
import { strFromU8, strToU8, unzipSync, zipSync } from './vendor/fflate.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU_PER_PT = 12700;
const SIGNATURE_LINE = /_{8,}/;
const SIGNATURE_WORD = /\b(firma|firmas|firmado|signature|sign)\b/i;

export async function readDocx(file) {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!files['word/document.xml']) throw new Error('This file is not a Word document');
  const spots = findSpots(parseXml(files['word/document.xml'])).map(({ kind, label }) => ({ kind, label }));
  return { name: file.name, files, spots, defaultSpot: pickDefault(spots) };
}

export function signDocx(pkg, spotIndex, png) {
  const files = { ...pkg.files };
  const doc = parseXml(files['word/document.xml']);
  const spot = findSpots(doc)[spotIndex];

  const media = uniquePath(files, 'word/media/signature', '.png');
  files[media] = png.bytes;
  const relId = addImageRelationship(files, media.slice('word/'.length));
  ensurePngContentType(files);

  const fontPt = defaultFontPt(files);
  const id = nextDrawingId(doc);
  if (spot.kind === 'line') placeOnLine(doc, spot.node, { relId, id, png, fontPt });
  else placeAbove(doc, spot.node, { relId, id, png });

  files['word/document.xml'] = serialize(doc);
  return new Blob([zipSync(files, { level: 6 })], { type: DOCX_MIME });
}

export function signedName(name) {
  return `${name.replace(/\.docx$/i, '')}_firmado.docx`;
}

function findSpots(doc) {
  const spots = [];
  for (const t of doc.getElementsByTagNameNS(NS.w, 't')) {
    if (SIGNATURE_LINE.test(t.textContent)) spots.push({ kind: 'line', node: t, label: lineLabel(t) });
  }
  if (spots.length) return spots;

  // No drawn line: fall back to paragraphs that name a signature, like "Firma del cliente".
  for (const p of doc.getElementsByTagNameNS(NS.w, 'p')) {
    const text = paragraphText(p).trim();
    if (text && text.length < 120 && SIGNATURE_WORD.test(text)) spots.push({ kind: 'label', node: p, label: text });
  }
  spots.push({ kind: 'end', node: null, label: 'Al final del documento' });
  return spots;
}

function pickDefault(spots) {
  // Signature blocks are usually the last ones that mention a signature.
  for (let i = spots.length - 1; i >= 0; i--) if (SIGNATURE_WORD.test(spots[i].label)) return i;
  return spots.length - 1;
}

function lineLabel(t) {
  const p = ancestor(t, 'p');
  const own = paragraphText(p).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const next = siblingParagraph(p, 'nextElementSibling');
  const prev = siblingParagraph(p, 'previousElementSibling');
  const label = [own, next && paragraphText(next).trim(), prev && paragraphText(prev).trim()].find(Boolean) || 'Línea de firma';
  return label.length > 90 ? `${label.slice(0, 87)}…` : label;
}

function placeOnLine(doc, t, { relId, id, png, fontPt }) {
  const run = t.parentNode;
  const runFontPt = halfPoints(run.getElementsByTagNameNS(NS.w, 'sz')[0]) ?? fontPt;
  const text = t.textContent;
  const at = text.search(SIGNATURE_LINE);
  const underscores = text.slice(at).match(/^_+/)[0].length;

  // An underscore is about half an em wide in common fonts; enough to center the signature.
  const lineWidthPt = underscores * runFontPt * 0.5;
  const size = fitSize(png, Math.min(160, Math.max(100, lineWidthPt * 0.8)), 60);
  const x = Math.max(0, (lineWidthPt - size.w) / 2);
  // Offset is from the top of the text line: drop the signature so its lower part crosses the line.
  const y = runFontPt * 1.05 - size.h * 0.85;

  const children = [...run.childNodes];
  const index = children.indexOf(t);
  const before = run.cloneNode(true);
  [...before.childNodes].slice(index + 1).forEach((n) => n.remove());
  const beforeT = before.childNodes[index];
  if (at > 0) beforeT.textContent = text.slice(0, at);
  else beforeT.remove();

  const after = run.cloneNode(true);
  [...after.childNodes].slice(0, index).forEach((n) => { if (n.localName !== 'rPr') n.remove(); });
  [...after.getElementsByTagNameNS(NS.w, 't')][0].textContent = text.slice(at);

  const drawing = drawingRun(doc, run, { anchor: true, relId, id, size, x, y });
  const hasContent = [...before.childNodes].some((n) => n.localName !== 'rPr');
  if (hasContent) run.parentNode.insertBefore(before, run);
  run.parentNode.insertBefore(drawing, run);
  run.parentNode.replaceChild(after, run);
}

function placeAbove(doc, p, { relId, id, png }) {
  const paragraph = doc.createElementNS(NS.w, 'w:p');
  paragraph.appendChild(drawingRun(doc, null, { anchor: false, relId, id, size: fitSize(png, 150, 60) }));
  if (p) {
    p.parentNode.insertBefore(paragraph, p);
    return;
  }
  const body = doc.getElementsByTagNameNS(NS.w, 'body')[0];
  const sectPr = [...body.childNodes].find((n) => n.localName === 'sectPr');
  body.insertBefore(paragraph, sectPr ?? null);
}

function drawingRun(doc, styleRun, { anchor, relId, id, size, x = 0, y = 0 }) {
  const cx = Math.round(size.w * EMU_PER_PT);
  const cy = Math.round(size.h * EMU_PER_PT);
  const graphic = `
    <wp:docPr id="${id}" name="Firma ${id}"/>
    <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <pic:pic>
        <pic:nvPicPr><pic:cNvPr id="${id}" name="firma.png"/><pic:cNvPicPr/></pic:nvPicPr>
        <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
        <pic:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </pic:spPr>
      </pic:pic>
    </a:graphicData></a:graphic>`;
  // "In front of text" anchor, positioned relative to the character and line where it sits.
  const body = anchor
    ? `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
        <wp:simplePos x="0" y="0"/>
        <wp:positionH relativeFrom="character"><wp:posOffset>${Math.round(x * EMU_PER_PT)}</wp:posOffset></wp:positionH>
        <wp:positionV relativeFrom="line"><wp:posOffset>${Math.round(y * EMU_PER_PT)}</wp:posOffset></wp:positionV>
        <wp:extent cx="${cx}" cy="${cy}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:wrapNone/>${graphic}
      </wp:anchor>`
    : `<wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${cx}" cy="${cy}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>${graphic}
      </wp:inline>`;
  const xmlns = Object.entries(NS).filter(([k]) => !['rel', 'ct'].includes(k)).map(([k, v]) => `xmlns:${k}="${v}"`).join(' ');
  const fragment = parseXml(`<w:r ${xmlns}><w:drawing>${body}</w:drawing></w:r>`);
  const run = doc.importNode(fragment.documentElement, true);
  const rPr = styleRun && [...styleRun.childNodes].find((n) => n.localName === 'rPr');
  if (rPr) run.insertBefore(rPr.cloneNode(true), run.firstChild);
  return run;
}

function fitSize(png, maxWidthPt, maxHeightPt) {
  let w = maxWidthPt;
  let h = (w * png.height) / png.width;
  if (h > maxHeightPt) {
    w *= maxHeightPt / h;
    h = maxHeightPt;
  }
  return { w, h };
}

function addImageRelationship(files, target) {
  const path = 'word/_rels/document.xml.rels';
  const rels = parseXml(files[path]);
  const taken = new Set([...rels.getElementsByTagNameNS(NS.rel, 'Relationship')].map((r) => r.getAttribute('Id')));
  let n = 1;
  while (taken.has(`rIdSignature${n}`)) n++;
  const rel = rels.createElementNS(NS.rel, 'Relationship');
  rel.setAttribute('Id', `rIdSignature${n}`);
  rel.setAttribute('Type', IMAGE_REL);
  rel.setAttribute('Target', target);
  rels.documentElement.appendChild(rel);
  files[path] = serialize(rels);
  return `rIdSignature${n}`;
}

function ensurePngContentType(files) {
  const types = parseXml(files['[Content_Types].xml']);
  const defaults = [...types.getElementsByTagNameNS(NS.ct, 'Default')];
  if (defaults.some((d) => d.getAttribute('Extension').toLowerCase() === 'png')) return;
  const png = types.createElementNS(NS.ct, 'Default');
  png.setAttribute('Extension', 'png');
  png.setAttribute('ContentType', 'image/png');
  types.documentElement.insertBefore(png, types.documentElement.firstChild);
  files['[Content_Types].xml'] = serialize(types);
}

function defaultFontPt(files) {
  if (!files['word/styles.xml']) return 11;
  const styles = parseXml(files['word/styles.xml']);
  const normal = [...styles.getElementsByTagNameNS(NS.w, 'style')].find((s) => s.getAttributeNS(NS.w, 'styleId') === 'Normal');
  const defaults = styles.getElementsByTagNameNS(NS.w, 'docDefaults')[0];
  return halfPoints(normal?.getElementsByTagNameNS(NS.w, 'sz')[0])
    ?? halfPoints(defaults?.getElementsByTagNameNS(NS.w, 'sz')[0])
    ?? 11;
}

function halfPoints(sz) {
  const v = sz && Number(sz.getAttributeNS(NS.w, 'val'));
  return v ? v / 2 : undefined;
}

function nextDrawingId(doc) {
  let max = 0;
  for (const el of doc.getElementsByTagNameNS(NS.wp, 'docPr')) max = Math.max(max, Number(el.getAttribute('id')) || 0);
  return max + 1;
}

function uniquePath(files, base, ext) {
  let path = `${base}${ext}`;
  for (let n = 2; files[path]; n++) path = `${base}${n}${ext}`;
  return path;
}

function paragraphText(p) {
  return [...p.getElementsByTagNameNS(NS.w, 't')].map((t) => t.textContent).join('');
}

function ancestor(node, localName) {
  let n = node;
  while (n && !(n.namespaceURI === NS.w && n.localName === localName)) n = n.parentNode;
  return n;
}

function siblingParagraph(p, direction) {
  const s = p[direction];
  return s && s.namespaceURI === NS.w && s.localName === 'p' ? s : null;
}

function parseXml(bytesOrText) {
  const text = typeof bytesOrText === 'string' ? bytesOrText : strFromU8(bytesOrText);
  return new DOMParser().parseFromString(text, 'application/xml');
}

function serialize(doc) {
  // Browsers differ on whether the serializer keeps the declaration, so always write exactly one.
  return strToU8(XML_DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, ''));
}
