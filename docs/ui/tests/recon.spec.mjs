import { test } from '@playwright/test';

test('recon - homepage', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'docs/ui/recon-01-home.png', fullPage: true });

  const buttons = await page.locator('button').allTextContents();
  console.log('Buttons:', JSON.stringify(buttons));

  const links = await page.locator('a').allTextContents();
  console.log('Links:', JSON.stringify(links));

  const h1s = await page.locator('h1, h2, h3').allTextContents();
  console.log('Headings:', JSON.stringify(h1s));

  console.log('Title:', await page.title());
});
