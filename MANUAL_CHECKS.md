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
