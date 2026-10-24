# Manual checks

These need a human to verify by running the game; they are not covered by automated tests.

- [ ] `npm run dev`: a spinning test cube appears and resizes with the window (Task 1)
- [ ] Inspect the texture atlas (Task 2): with `npm run dev` open, paste into the browser console:
  `import('/src/render/atlas.js').then(m=>{const c=m.createAtlasCanvas();c.style.cssText='position:fixed;top:0;left:0;width:1024px;image-rendering:pixelated;background:repeating-conic-gradient(#888 0 25%,#ccc 0 50%) 0 0/16px 16px;z-index:9999';document.body.appendChild(c)})`
  All 13 tiles in the top row should be recognizable (grass top, grass side, dirt, stone, cobblestone, sand, bark, log rings, planks, leaves, glass, water, bedrock), and the checker background should show through the holes in leaves and glass. (The manager checked this once from a headless screenshot; a human should still look at it.)
- [ ] Movement feel: walking and sprinting respond quickly and stopping isn't slippery; air control isn't too floaty; running along walls and into corners never snags or jitters (Task 4).
- [ ] Jumping onto a 1-block step feels natural; walking into one stops you (there is no auto-step by design) (Task 4).
- [ ] Water: swimming at the surface bobs gently, holding Space swims up, and swimming to a 1-block shore while holding Space lifts you out (Task 4).
- [ ] Fly mode: double-tap Space toggles flight; Space rises, Shift descends; flying down onto the ground ends flight cleanly (Task 4).
- [ ] Terrain renders: no missing faces, grass sides show green at the top, no colored seams between textures, water is translucent with the lake bed visible, leaves show holes (Task 5; the manager confirmed this from headless screenshots, so a human pass on a real GPU is still needed).
- [ ] Pointer lock: clicking locks the mouse; Esc releases it and shows the pause screen; clicking again resumes. Chrome refuses a re-lock for about 1 s after Esc, so an immediate click may need repeating (Task 6).
- [ ] Mouse look direction and sensitivity feel right; looking straight up or down stops at the limit without flipping (Task 6).
- [ ] Tab switch / alt-tab while holding W: on return the player isn't still walking and there is no big jump in position (Task 6).
- [ ] Fog hides chunks popping in at the edge of the view while walking or flying (Task 6).
- [ ] Walking and flying fast across chunk borders never stutters, falls through the ground, or shows holes along borders (Task 6).
- [ ] Block editing: left click breaks the targeted block instantly; right click places the selected block on the targeted face; you can't place a block inside yourself; bedrock can't be broken; the outline hugs the targeted block and disappears when nothing is in reach; edits at chunk borders leave no holes (Task 7).
- [ ] Hotbar: all 9 icons are recognizable, crisp and seam-free (including leaves and glass); 1-9 and the mouse wheel change the selection; the selected slot is clearly highlighted and the block name fades out (Task 8).
- [ ] Crosshair stays visible against bright sky and in dark places (Task 8).
- [ ] Pause menu: Esc shows it; "Click to play" resumes; "New World" asks for confirmation; "Cancel" backs out; "Yes, new world" starts a different world (Task 8).
- [ ] F3 overlay: toggles on and off; FPS, XYZ, chunk, facing, time, chunk counts, triangles and seed look plausible and update while moving (Task 8).
- [ ] Layout holds in narrow and short windows (the hotbar scales down; the pause menu scrolls if needed) (Task 8).
- [ ] Day/night (a full cycle takes 10 minutes; to skip ahead in dev, run `__game.setTimeOfDay(0.74)` in the console): the sun rises in the east and sets in the west with an orange-pink sky (judge whether the sunset tint is too strong); night is dark blue with stars and a cratered moon; terrain dims at night; hills hide the sun and moon (Task 9).
- [ ] Underwater: blue-green, short fog under water that clears when surfacing (Task 9).
