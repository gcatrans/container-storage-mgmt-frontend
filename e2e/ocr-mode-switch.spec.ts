import { expect, test } from '@playwright/test';
import path from 'node:path';

// Changing the OCR engine mid-session must re-run analysis on the already-loaded photo, without
// the user having to re-select it (click "Existing" again) to see the new engine's result.
test('re-analyzes the loaded photo when the OCR mode changes, without re-selecting it', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');

  await page.locator('input[type="file"]').setInputFiles(path.resolve('images', 'iso-tank_frontal.jpg'));
  const status = page.locator('.status');
  await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });

  const row = page.locator('tr.container-id');
  await expect(row).toHaveCount(1);
  await expect(row.locator('input[aria-label="Container ID"]')).toHaveValue(/LASU/);

  // Switch engine without touching the file input again.
  await page.locator('select').filter({ has: page.locator('option[value="server-fast"]') }).selectOption('server-fast');

  await expect(status).toHaveClass(/busy/, { timeout: 5_000 });
  await expect(status).not.toHaveClass(/busy/, { timeout: 150_000 });

  await expect(row).toHaveCount(1);
  await expect(row.locator('input[aria-label="Container ID"]')).toHaveValue(/LASU/);
});
