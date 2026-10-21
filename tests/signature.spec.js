import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const PHOTO = new URL('./fixtures/signature-photo.jpg', import.meta.url).pathname;

async function inkStats(page) {
  return page.locator('#result').evaluate((canvas) => {
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    let sample = null;
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] > 200) {
        opaque++;
        if (data[i * 4 + 3] === 255) sample ??= [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
      }
    }
    const corners = [0, width - 1, (height - 1) * width, height * width - 1].map((i) => data[i * 4 + 3]);
    return { width, height, opaqueRatio: opaque / (width * height), corners, sample };
  });
}

test('turns a phone photo into a transparent signature PNG', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.locator('#gallery').setInputFiles(PHOTO);
  await expect(page.locator('#download')).toBeEnabled();

  const stats = await inkStats(page);
  // The table at the bottom of the photo and the paper edges must be gone, only the strokes remain.
  expect(stats.width).toBeGreaterThan(stats.height * 2);
  expect(stats.corners).toEqual([0, 0, 0, 0]);
  expect(stats.opaqueRatio).toBeGreaterThan(0.02);
  expect(stats.opaqueRatio).toBeLessThan(0.3);
  expect(stats.sample).toEqual([20, 20, 20]);

  await page.getByRole('button', { name: 'Azul' }).click();
  await expect.poll(async () => (await inkStats(page)).sample).toEqual([20, 40, 140]);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar PNG' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('firma.png');
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');

  await page.getByRole('button', { name: 'Tomar otra foto' }).click();
  await expect(page.getByRole('heading', { name: 'Tu última firma' })).toBeVisible();
  await expect(page.locator('#saved-img')).toHaveJSProperty('naturalWidth', stats.width);

  expect(errors).toEqual([]);
});

test('manual crop keeps only the selected part of the signature', async ({ page }) => {
  await page.goto('/');
  await page.locator('#camera').setInputFiles(PHOTO);
  await expect(page.locator('#download')).toBeEnabled();
  const before = await inkStats(page);

  await page.getByRole('button', { name: 'Ajustar recorte' }).click();
  const handle = page.locator('#crop-box i[data-h="se"]');
  const img = await page.locator('#crop-img').boundingBox();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(img.x + img.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Aplicar recorte' }).click();

  await expect.poll(async () => (await inkStats(page)).width).toBeLessThan(before.width * 0.7);
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.locator('#gallery').setInputFiles(PHOTO);
  await expect(page.locator('#download')).toBeEnabled();
});
