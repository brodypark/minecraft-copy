export const CHUNK_SIZE = 16;          // x and z footprint
export const WORLD_HEIGHT = 64;        // y range 0..63
export const SEA_LEVEL = 22;
export const RENDER_DISTANCE = 6;      // radius in chunks that get meshed
export const GEN_DISTANCE = RENDER_DISTANCE + 1;   // radius that gets block data (needed so border faces can be culled)
export const UNLOAD_DISTANCE = RENDER_DISTANCE + 3;
export const CHUNK_GEN_PER_FRAME = 2;
export const CHUNK_MESH_PER_FRAME = 2;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const GRAVITY = 32;             // blocks/s^2
export const JUMP_SPEED = 9.0;         // ~1.27 block jump
export const WALK_SPEED = 4.3;
export const SPRINT_SPEED = 5.6;
export const FLY_SPEED = 12;
export const REACH = 5;
export const FOV = 75;
export const MOUSE_SENSITIVITY = 0.0022;
export const DAY_LENGTH_SECONDS = 600;
export const TILE_SIZE = 16;           // px per texture tile
export const ATLAS_TILES = 16;         // tiles per row/column (256x256 atlas)

// Physics tuning (used by src/player/physics.js)
export const MAX_DT = 0.05;              // s, largest dt honored per call
export const MAX_SUBSTEP = 1 / 60;       // s, largest integration step
export const COLLISION_EPS = 1e-4;       // blocks, gap left between the AABB and a block face
export const SKIN_TOL = 0.01;            // blocks, penetration that gets pushed back out
export const GROUND_ACCEL = 20;          // 1/s, horizontal approach rate on the ground
export const AIR_ACCEL = 4;              // 1/s, horizontal approach rate in the air
export const WATER_ACCEL = 8;            // 1/s, horizontal approach rate in water
export const FLY_ACCEL = 10;             // 1/s, approach rate (all axes) in fly mode
export const MAX_FALL_SPEED = 60;        // blocks/s, terminal speed in air
export const WATER_SAMPLE_HEIGHT = 0.4;  // blocks above the feet that decide inWater
export const WATER_GRAVITY_SCALE = 0.3;  // fraction of GRAVITY applied in water
export const WATER_SPEED_SCALE = 0.5;    // horizontal speed multiplier in water
export const WATER_SINK_SPEED = 2;       // blocks/s, terminal sink speed in water
export const WATER_DRAG = 10;            // 1/s, how fast a faster fall is slowed to sink speed
export const SWIM_UP_SPEED = 3.5;        // blocks/s, rise speed while holding jump in water
export const SWIM_ACCEL = 40;            // blocks/s^2, acceleration toward SWIM_UP_SPEED
export const WATER_EXIT_SPEED = 9;       // blocks/s, shoreline boost (same as a jump)
export const LANDING_ENDS_FLIGHT = true; // touching ground while flying turns flying off

// Terrain tuning (used by src/world/terrain.js). Height:
// h = SEA_LEVEL + BASE + DETAIL_AMP * fbm(x/DETAIL_SCALE) + HILL_AMP * max(0, fbm2(x/HILL_SCALE))^2
// fbm is normalized to [-1, 1] and rarely leaves +-0.6, so the spec's starting values (2, 14, 10) only
// reach y ~35. Tuned (measured over 2048x2048 blocks, 3 seeds): the highest point of each 256x256 area
// is y ~46 (median), ~20% of columns are under water, neighbor columns never differ by more than 3.
export const TERRAIN_BASE = 3;
export const TERRAIN_DETAIL_SCALE = 90;
export const TERRAIN_DETAIL_AMP = 18;
export const TERRAIN_HILL_SCALE = 220;
export const TERRAIN_HILL_AMP = 40;
export const TERRAIN_MIN_HEIGHT = 4;
export const TERRAIN_MAX_HEIGHT = WORLD_HEIGHT - 8;
export const FBM_OCTAVES = 4;
export const FBM_PERSISTENCE = 0.5;
export const FBM_LACUNARITY = 2;
export const TREE_CHANCE = 110;          // about 1 in 110 qualifying grass columns grows a tree

// Rendering (used by src/render/renderer.js and src/render/sky.js)
export const MAX_PIXEL_RATIO = 2;        // a devicePixelRatio of 3 tanks FPS on laptops
export const CAMERA_NEAR = 0.1;
export const DAY_SKY_COLOR = 0x87b8ff;
export const FOG_NEAR_FACTOR = 0.55;     // fog near = factor * RENDER_DISTANCE * CHUNK_SIZE
export const FOG_FAR_FACTOR = 0.95;      // fog far  = factor * RENDER_DISTANCE * CHUNK_SIZE

// Sky / day-night (used by src/render/sky.js). Time of day t is in [0, 1):
// 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset; main.js advances it by dt / DAY_LENGTH_SECONDS.
// "Sun elevation" below means sin(2*pi*(t - 0.25)): -1 at midnight, 0 at sunrise/sunset, 1 at noon.
export const DAY_START_TIME = 0.3;            // the game starts in the morning, shortly after sunrise
export const NIGHT_SKY_COLOR = 0x0b1026;      // sRGB; DAY_SKY_COLOR (above) is the noon sky
export const SUNSET_SKY_COLOR = 0xff8c5f;     // sRGB, orange-pink tint around sunrise and sunset
export const SUNSET_TINT_STRENGTH = 0.75;     // blend toward SUNSET_SKY_COLOR when the sun is on the horizon
export const SUNSET_TINT_WIDTH = 0.3;         // sun elevation (+-) at which the sunset tint has faded out
export const NIGHT_BRIGHTNESS = 0.25;         // chunk material gray level through the night
export const DAY_BRIGHTNESS = 1.0;            // chunk material gray level in full daylight
export const LIGHT_RAMP_LOW = -0.3;           // sun elevation where dawn light starts (and dusk light ends)
export const LIGHT_RAMP_HIGH = 0.5;           // sun elevation where full daylight is reached
export const SUN_ORBIT_TILT = 0.35;           // radians the sun's orbit leans toward +Z, so noon isn't straight up
export const SUN_DISTANCE = 180;              // blocks from the camera (camera far plane is 256)
export const SUN_SIZE = 30;                   // blocks, edge of the sun quad (glow included)
export const MOON_SIZE = 20;                  // blocks, edge of the moon quad (glow included)
export const SKY_BODY_FADE_HIGH = 0.02;       // sun/moon direction y above which they are fully opaque
export const SKY_BODY_FADE_LOW = -0.12;       // sun/moon direction y below which they are hidden
export const STAR_COUNT = 400;
export const STAR_DISTANCE = 190;             // blocks from the camera
export const STAR_SIZE = 2;                   // CSS px (no size attenuation)
export const STAR_MAX_OPACITY = 0.8;
export const STAR_FADE_LOW = -0.25;           // sun elevation below which stars are fully visible
export const STAR_FADE_HIGH = 0;              // sun elevation above which stars are gone
export const UNDERWATER_FOG_COLOR = 0x1a5a6a; // sRGB deep blue-green, multiplied by brightness (dark at night)
export const UNDERWATER_FOG_NEAR = 0.5;       // blocks
export const UNDERWATER_FOG_FAR = 14;         // blocks

// Polish (Task 11). Ambient occlusion is used by src/render/mesher.js, caves by src/world/terrain.js.
// AO level per face vertex = 3 - (side1 + side2 + corner), or 0 when both sides are occluders (classic
// 3-neighbor rule; only opaque blocks occlude). The level picks a brightness factor that multiplies the
// per-face shade. Values are sRGB grays like the face shades (chunkMeshes converts them to linear).
export const AO_FACTORS = [0.5, 0.65, 0.82, 1.0]; // index = AO level 0 (darkest) .. 3 (open)
// Caves: carve AIR where noise3D(x / XZ_SCALE, y / Y_SCALE, z / XZ_SCALE) > CAVE_THRESHOLD, only for
// CAVE_MIN_Y <= y <= min(own surface, 4 neighbor surfaces) - CAVE_SURFACE_GAP. The gap keeps at least
// 4 solid blocks above every cave cell and keeps caves away from water columns at the side, so caves
// never open to the sky and never touch WATER. Within CAVE_TAPER blocks of those limits the threshold
// rises by CAVE_TAPER_STEP per block, which rounds off floors and ceilings instead of cutting them flat.
export const CAVES_ENABLED = true;
export const CAVE_XZ_SCALE = 28;          // blocks per noise unit horizontally
export const CAVE_Y_SCALE = 14;           // blocks per noise unit vertically (flatter, wider caves)
export const CAVE_THRESHOLD = 0.62;       // higher = sparser caves
export const CAVE_MIN_Y = 5;
export const CAVE_SURFACE_GAP = 5;        // cave cells satisfy y <= surface - 5 (own and 4 neighbor columns)
export const CAVE_TAPER = 3;              // blocks
export const CAVE_TAPER_STEP = 0.08;      // threshold increase per block of taper
