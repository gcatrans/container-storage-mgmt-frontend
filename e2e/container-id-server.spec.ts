import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

// Narrower than container-markings-server.spec.ts: only checks that the server OCR mode reads the
// full, checksum-valid container ID directly - not any of the other structured fields. The check
// digit must be read by OCR itself, not inferred/computed: expectContainerId asserts there is no
// "Inferred container ID check digit" input and that the unit column shows the "check digit
// valid" state, not the "inferred" one.
async function useServerOcr(page: Page): Promise<void> {
  await page.locator('select').filter({ has: page.locator('option[value="server"]') }).selectOption('server');
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

async function expectContainerIdFullyRead(page: Page, imageFile: string, containerId: string): Promise<void> {
  await page.goto('/');
  await useServerOcr(page);
  await page.locator('input[type="file"]').setInputFiles(path.resolve('images', imageFile));

  const status = page.locator('.status');
  await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });

  const row = page.locator('tr.container-id');
  await expect(row).toHaveCount(1);
  await expectContainerId(row, containerId);
}

test.describe('server OCR - container ID read in full (no inferred check digit)', () => {
  test('extracts the frontal ISO tank container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'iso-tank_frontal.jpg', 'LASU 210040 0');
  });

  test('extracts the front-right oblique ISO tank container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'iso-tank_front-right-oblique.jpg', 'MEBU 126347 6');
  });

  test('extracts the frontal 4ft general-purpose container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'general-purpose_4ft_frontal.webp', 'SDNU 920459 4');
  });

  test('extracts the front-left oblique 4ft general-purpose container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'general-purpose_4ft_front-left-oblique.webp', 'HCSU 799790 9');
  });

  test('extracts the frontal 20ft general-purpose container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'general-purpose_20ft_frontal.jpg', 'AGZU 111135 5');
  });

  test('extracts the UN tank 3 container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'un-tank_3.JPG', 'EUXU 700755 3');
  });

  test('extracts the UN tank 2 container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'un-tank_2.JPG', 'EUXU 700686 0');
  });

  test('extracts the small UN tank container ID', async ({ page }) => {
    test.setTimeout(180_000);
    await expectContainerIdFullyRead(page, 'un-tank_small.jpg', 'EUXU 700756 9');
  });
});
