import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

// Covers every OCR engine (browser + all three server profiles) against every reference photo.
// Checks ONLY that the full, checksum-valid container ID is read directly by the OCR - not any
// other structured field. The check digit must be read by OCR itself, not inferred/computed:
// expectContainerId asserts there is no "Inferred container ID check digit" input and that the
// unit column shows the "check digit valid" state, not the "inferred" one.
//
// Replaces the former container-id-server.spec.ts (server-fast only): generalized to the full
// OCR_MODES matrix below instead of duplicating a near-identical file per engine.

const OCR_MODES = ['browser', 'server-fast', 'server-accurate', 'server-node'] as const;
type OcrMode = (typeof OCR_MODES)[number];

const IMAGES: ReadonlyArray<{ file: string; containerId: string }> = [
  { file: 'iso-tank_frontal.jpg', containerId: 'LASU 210040 0' },
  { file: 'iso-tank_front-right-oblique.jpg', containerId: 'MEBU 126347 6' },
  { file: 'general-purpose_4ft_frontal.webp', containerId: 'SDNU 920459 4' },
  { file: 'general-purpose_4ft_front-left-oblique.webp', containerId: 'HCSU 799790 9' },
  { file: 'general-purpose_20ft_frontal.jpg', containerId: 'AGZU 111135 5' },
  { file: 'un-tank_3.JPG', containerId: 'EUXU 700755 3' },
  { file: 'un-tank_2.JPG', containerId: 'EUXU 700686 0' },
  { file: 'un-tank_small.jpg', containerId: 'EUXU 700756 9' },
];

async function useOcrMode(page: Page, mode: OcrMode): Promise<void> {
  await page.locator('select').filter({ has: page.locator(`option[value="${mode}"]`) }).selectOption(mode);
}

async function expectContainerId(row: Locator, expected: string): Promise<void> {
  const expectedCanonical = expected.replace(/\s/g, '');
  await expect.poll(async () => {
    const stemInput = row.locator('input[aria-label="Container ID"]');
    const inferredDigitInput = row.locator('input[aria-label="Inferred container ID check digit"]');
    const stem = await stemInput.inputValue();
    const digit = await inferredDigitInput.count() ? await inferredDigitInput.inputValue() : '';
    return `${stem}${digit}`.replace(/\s/g, '');
  }).toBe(expectedCanonical);
  await expect(row.locator('input[aria-label="Inferred container ID check digit"]')).toHaveCount(0);
  await expect(row.locator('.unit span')).toHaveAttribute('aria-label', 'ISO 6346 check digit valid');
}

async function expectContainerIdFullyRead(page: Page, mode: OcrMode, imageFile: string, containerId: string): Promise<void> {
  await page.goto('/');
  await useOcrMode(page, mode);
  const startedAt = Date.now();
  await page.locator('input[type="file"]').setInputFiles(path.resolve('images', imageFile));

  const status = page.locator('.status');
  await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });
  // Logged unconditionally (before the correctness assertions below, which may still throw) so a
  // full timing/error report can be built from the run's console output regardless of pass/fail.
  console.log(`[timing] mode=${mode} file=${imageFile} elapsedMs=${Date.now() - startedAt}`);

  const row = page.locator('tr.container-id');
  await expect(row).toHaveCount(1);
  await expectContainerId(row, containerId);
}

for (const mode of OCR_MODES) {
  test.describe(`${mode} OCR - container ID read in full (no inferred check digit)`, () => {
    for (const { file, containerId } of IMAGES) {
      test(`extracts the container ID from ${file}`, async ({ page }) => {
        test.setTimeout(180_000);
        await expectContainerIdFullyRead(page, mode, file, containerId);
      });
    }
  });
}
