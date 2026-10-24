// Browser smoke test (PROJECT.md section 8): starts the Vite dev server, loads the game in headless
// Chrome, plays for 5 seconds (walk, jump, fly, break/place, F3) and fails if any console
// error/warning or uncaught page error appears.
// Run with `npm run test:smoke`. Uses the locally installed Google Chrome; when none is found the
// test is skipped (exit code 0) so it never blocks machines without a browser.

import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const WATCH_MS = 5000;
const IGNORED = [
  /^\[vite\]/, // Vite's own dev-server chatter (debug level)
  // Headless SwiftShader's compositor reads frames back and logs this driver message even for a bare
  // WebGL page that only clears the screen; it does not come from the game and never appears on a GPU.
  /GL Driver Message .*GPU stall due to ReadPixels/,
];

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    // Software WebGL so the test also runs on machines/CI without a usable GPU.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
} catch (err) {
  console.log(`smoke: SKIPPED (no Chrome available: ${String(err.message).split('\n')[0]})`);
  process.exit(0);
}

const server = await createServer({ logLevel: 'silent', server: { port: 0, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?seed=1337`;

const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    const type = msg.type();
    if ((type === 'error' || type === 'warning') && !IGNORED.some((re) => re.test(msg.text()))) {
      problems.push(`console.${type}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  // Play for the watch window: pointer lock isn't available headless, so the dev-only hook runs the
  // game unpaused. Walk, jump, toggle fly and fly forward (streaming), break and place a block, and
  // open the F3 overlay, so those code paths run while the console is watched.
  await page.evaluate(() => window.__game.setForcePlay(true));
  const click = async (button) => {
    await page.mouse.down({ button });
    await page.waitForTimeout(40);
    await page.mouse.up({ button });
  };
  await page.mouse.move(640, 360);
  await page.keyboard.press('F3');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.keyboard.down('Space');
  await page.waitForTimeout(120);
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');
  // Look down at the ground, break the block, then place the selected block back.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 450 })));
  await page.waitForTimeout(100);
  await click('left');
  await page.waitForTimeout(100);
  await click('right');
  await page.keyboard.press('Digit3');
  await page.mouse.wheel(0, 100);
  // Fly forward fast enough to stream in new chunks.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -450 })));
  await page.keyboard.press('Space');
  await page.waitForTimeout(60);
  await page.keyboard.press('Space');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(Math.max(0, WATCH_MS - 1600));
  await page.keyboard.up('KeyW');

  const state = await page.evaluate(() => ({
    canvas: !!document.querySelector('#app canvas'),
    chunks: window.__game.world.loadedChunkCount(),
    meshes: window.__game.chunkMeshes.chunkCount(),
    edits: Object.keys(window.__game.world.getEdits()).length,
    flying: window.__game.player.state.flying,
    z: window.__game.player.state.z,
  }));
  if (!state.canvas) problems.push('no game canvas found');
  if (state.meshes === 0) problems.push('no chunk meshes were built');
  if (state.edits === 0) problems.push('breaking/placing a block recorded no edit');
  if (!state.flying) problems.push('double-tap Space did not turn on fly mode');
  console.log(`smoke: ${state.chunks} chunks loaded, ${state.meshes} meshed, flew to z=${state.z.toFixed(1)}, ${state.edits} edited chunk(s)`);
} finally {
  await browser.close();
  await server.close();
}

if (problems.length > 0) {
  console.error(`smoke: FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`smoke: OK (no console errors or warnings for ${WATCH_MS / 1000} s)`);
