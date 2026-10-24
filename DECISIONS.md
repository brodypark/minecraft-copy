# Decisions

The manager's decision log: choices made during the build, with the reason for each.

- **Project files live at the repository root**, not in a `voxel-game/` subfolder as drawn in PROJECT.md section 4. The repo is the project, so the extra folder adds nothing.
- **`blocks.js` ships a registry skeleton in Task 1.** Block flags (`solid`, `transparent`, `placeable`, `breakable`) are filled in now and `tiles` are placeholders that Task 2 assigns, so the parallel Group B tasks share one API (`BLOCKS`, `HOTBAR_BLOCKS`, `getBlockDef`, `isSolid`, `isTransparent`, `isPlaceable`, `isBreakable`) from the start.
- **Block flag helpers use flat `Uint8Array(256)` lookup tables** built once from `BLOCKS` at module load, so the mesher and physics hot loops do one array read per check. Unknown ids read as air (not solid, transparent, not placeable, not breakable). Consequence: `BLOCKS` flags must not be mutated at runtime; edit the source instead.
- **`main.js` uses `THREE.Timer`** for frame delta (clamped to 0.05 s), because `THREE.Clock` is deprecated in current three and logs a warning.
- **`alea` is a CommonJS/UMD package**; import it as a default export (`import alea from 'alea'`). This works in both Vite and vitest.
- **`build.chunkSizeWarningLimit: 1000`** in `vite.config.js`: three.js alone is ~525 kB minified, which would otherwise print a chunk-size warning on every build. Code-splitting three buys nothing for a single-page game.
