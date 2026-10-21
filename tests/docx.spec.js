import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

async function signedDocx(page, docName) {
  await page.goto('./');
  await page.locator('#docx-input').setInputFiles(fixture(docName));
  await expect(page.locator('#doc-panel')).toBeVisible();
  await page.locator('#camera').setInputFiles(fixture('signature-photo.jpg'));
  await expect(page.getByRole('button', { name: 'Descargar Word firmado' })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar Word firmado' }).click();
  const download = await downloadPromise;
  const files = unzipSync(new Uint8Array(await readFile(await download.path())));
  return { name: download.suggestedFilename(), files, xml: strFromU8(files['word/document.xml']) };
}

function paragraphs(xml) {
  return xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g);
}

test('places the signature over the signature line of a Word document', async ({ page }) => {
  await page.goto('./');
  await page.locator('#docx-input').setInputFiles(fixture('contract.docx'));
  // The fill-in "Nombre: ____" line is also offered, but the signature line is preselected.
  const spot = page.getByLabel('¿Dónde va la firma?');
  await expect(spot.locator('option')).toHaveText(['Nombre:', 'Firma del cliente']);
  await expect(spot).toHaveValue('1');

  const { name, files, xml } = await signedDocx(page, 'contract.docx');
  expect(name).toBe('contract_firmado.docx');
  expect(strFromU8(files['word/media/signature.png'].subarray(1, 4))).toBe('PNG');
  expect(strFromU8(files['[Content_Types].xml'])).toMatch(/Extension="png"/);
  const rels = strFromU8(files['word/_rels/document.xml.rels']);
  const relId = rels.match(/Id="(rIdSignature\d+)"[^>]*Target="media\/signature\.png"/)[1];

  const signed = paragraphs(xml).filter((p) => p.includes('<wp:anchor'));
  expect(signed).toHaveLength(1);
  // The floating signature sits right before the underscores, in front of the text.
  expect(signed[0]).toMatch(/<\/w:drawing><\/w:r><w:r>(<w:rPr\/>)?<w:t[^>]*>_{8,}/);
  expect(signed[0]).toContain(`r:embed="${relId}"`);
  expect(signed[0]).toContain('behindDoc="0"');
  expect(signed[0]).toContain('<wp:wrapNone/>');
  expect(paragraphs(xml)).toHaveLength(paragraphs(strFromU8(unzipSync(new Uint8Array(await readFile(fixture('contract.docx'))))['word/document.xml'])).length);
});

test('without a drawn line, puts the signature above the signature label', async ({ page }) => {
  const { xml } = await signedDocx(page, 'label-only.docx');
  const ps = paragraphs(xml);
  const label = ps.findIndex((p) => p.includes('Firma del responsable'));
  expect(ps[label - 1]).toContain('<wp:inline');
});

test('rejects a file that is not a Word document', async ({ page }) => {
  await page.goto('./');
  await page.locator('#docx-input').setInputFiles(fixture('signature-photo.jpg'));
  await expect(page.locator('#toast')).toHaveText('Ese archivo no es un Word .docx.');
  await expect(page.locator('#doc-panel')).toBeHidden();
});
