import { expect, test, type Page } from '@playwright/test';

const editor = (page: Page) => page.locator('textarea');
const status = (page: Page) => page.getByTestId('status');

test('two users edit live, keep their cursors, and converge after offline edits', async ({
  browser,
}) => {
  const docId = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await alice.goto(`/d/${docId}`);
  await bob.goto(`/d/${docId}`);
  await expect(status(alice)).toHaveText('Saved');
  await expect(status(bob)).toHaveText('Saved');

  // Live typing shows up on the other side, with a remote caret.
  await editor(alice).click();
  await alice.keyboard.type('Hello world');
  await expect(editor(bob)).toHaveValue('Hello world');
  await expect(bob.locator('.caret-label')).toHaveCount(1);
  await expect(alice.locator('.avatar')).toHaveCount(1);

  // Bob types at the start. Alice's caret was at the end; it must stay at the end (it is held as
  // a CRDT anchor, not an index), so her next keystroke lands after "world".
  await editor(bob).focus();
  await bob.keyboard.press('Control+Home');
  await bob.keyboard.type('>> ');
  await expect(editor(alice)).toHaveValue('>> Hello world');
  await alice.keyboard.type('!');
  await expect(editor(bob)).toHaveValue('>> Hello world!');

  // Alice goes offline and keeps editing; Bob edits concurrently online.
  await alice.getByRole('button', { name: 'Simulate offline' }).click();
  await expect(status(alice)).toContainText('Offline');
  await editor(alice).focus();
  await alice.keyboard.press('Control+End');
  await alice.keyboard.type(' (offline)');
  await expect(status(alice)).toContainText('unsynced');
  await editor(bob).focus();
  await bob.keyboard.press('Control+Home');
  await bob.keyboard.type('# ');
  await expect(editor(bob)).toHaveValue('# >> Hello world!');

  // Back online: both converge on both edits.
  await alice.getByRole('button', { name: 'Go online' }).click();
  const merged = '# >> Hello world! (offline)';
  await expect(editor(alice)).toHaveValue(merged);
  await expect(editor(bob)).toHaveValue(merged);
  await expect(status(alice)).toHaveText('Saved');
  if (process.env.SCREENSHOT) {
    await editor(bob).focus();
    await bob.keyboard.press('Control+End');
    await bob.keyboard.press('Shift+Control+ArrowLeft');
    await expect(alice.locator('mark')).toHaveCount(1);
    await alice.setViewportSize({ width: 900, height: 360 });
    await alice.screenshot({ path: 'docs/screenshot.png' });
  }

  // A reload restores from IndexedDB + server and still shows the merged text.
  await bob.reload();
  await expect(editor(bob)).toHaveValue(merged);
});
