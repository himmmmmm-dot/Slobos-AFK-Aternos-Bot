# Milestone reports

## Milestone 1 — Foundation (2026-11-10)

**State: locally complete.** Not tested in the platform environment, not ready for submission, not approved by CrazyGames.

### Implemented

- **Engine setup.** TypeScript, three.js on WebGL 2, Vite. Explicit application states (boot, loading, menu, playing, paused, results, failed, error). Fixed 60 Hz simulation separate from rendering. Reasons for each choice are in [TECH_DECISION.md](TECH_DECISION.md).
- **Movement.** First-person controller with walk, sprint, crouch, jump (with a short grace period after leaving a ledge and a buffered press before landing), step-up, slopes and stairs, wall sliding, and camera smoothing over steps.
- **One weapon.** VP-9 service pistol: semi-automatic with a fixed fire interval, a 12-round magazine that never runs dry, automatic and manual reload, first-shot accuracy with spread that opens under rapid fire, recoil that recovers on its own, range falloff and critical hits to the sensor head. First-person model with recoil, reload and sprint poses; tracers, sparks, scorch marks, muzzle flash; a charge strip on the weapon that shows remaining ammunition.
- **One enemy.** Security Unit with patrol, investigate, combat, search and return states; sight limited by range, field of view and solid geometry; slower detection of a crouched player; hearing that walls dampen; a telegraphed three-bolt burst; repositioning after each burst; allies told where to look; recovery when stuck. Bolts are swept against the world every tick.
- **Graybox encounter.** The concourse from mission one, "Dead Signal": an entry tunnel that teaches crouch and jump, a hall with cover, a mezzanine reached by a ramp or stairs, five units, a relay room. Three objectives, radio lines with subtitles and a comms log, health pickups, win and fail screens with retry.
- **Interface.** Menu, loading screen with real step progress, HUD (health, ammunition, objective, world marker, crosshair that opens with spread, hit, critical and kill markers that differ in shape, damage direction), pause, settings (sensitivity, invert, field of view, quality, brightness, HUD size, subtitles, four volumes, mute, view bob, screen shake, key rebinding), results, error and unsupported-device screens. Visible keyboard focus throughout.
- **Audio.** Synthesised weapon, impact, enemy, movement, interface and objective sounds; positional audio for enemy sounds; ambience; an exploration pad with a combat layer. Mute reasons tracked separately (player, focus, advert, platform).
- **Persistence.** Versioned settings with validation, migration, and recovery from missing, corrupt or newer saves. Falls back to memory when storage is blocked and tells the player.
- **Platform adapter.** CrazyGames HTML5 SDK v3: initialisation with timeouts, environment detection, loading and gameplay signals without duplicates, the platform mute setting, the data module as save storage. A separate null adapter for builds without a platform.
- **Build and tooling.** `dev`, `build`, `test`, `typecheck`, `smoke`, `package` scripts; lockfile; environment template; CrazyGames package check and zip.
- **Compliance matrix.** [COMPLIANCE.md](COMPLIANCE.md), from the official documentation as read on 2026-11-10.

### Tested

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | Clean |
| Unit and simulation tests | `npm test` | 83 passed, 0 failed, 4 files, about 2 s |
| Production build | `npm run build` | Succeeds |
| Real build in headless Chrome, real key and mouse events | `node scripts/smoke.mjs` | 40 of 40 checks passed on Chrome for Testing 157.0.8103.38 |
| Real pointer-lock flow | `node scripts/lock-probe.mjs` | 5 of 5 passed |
| Package limits | `npm run package` | No problems found |
| Live SDK surface | `node scripts/sdk-probe.mjs` | Every member the adapter calls exists; `local` environment |

What the tests cover: weapon cadence, ammunition, reload, spread and falloff; identical tick counts and fire rate at 30 to 240 Hz; walls, steps, ramps, jumps, crouch clearance, ledges, thin walls at sprint speed; ray casts; path-finding across ramps and stacked floors; detection through and around walls, hearing, damage, death, search and return, stuck recovery; objective order, interaction hold and release, failure and restart, pickups and regeneration; adapter states including blocked, slow, disabled and failing SDKs; lifecycle signal order over a whole session; storage failure; settings validation and migration; key rebinding.

What the browser pass covers: one click from menu to play; walking, crouching under the beam, vaulting the barricade, mouse look, firing and reloading with real input; pause and resume; settings changes, a rebind through the interface, and persistence across a reload; the whole mission played to the results screen; death, retry, replay and quit; six restarts without growth in GPU objects; six CrazyGames frame sizes; a blocked SDK, a slow SDK, the platform mute switch, blocked storage and a corrupt save.

Three real defects were found and fixed by this pass: key taps shorter than a frame were dropped, the recoil spring became unstable at very low frame rates, and bolt hits spawned sparks at the camera.

### Measured results

| Measure | Result |
|---|---|
| Build | 5 files, 641.7 KB, 169.7 KB gzipped; zip 175.6 KB. Limits: 1,500 files, 50 MB initial download |
| Before the menu can paint | 52.3 KB script and 8.5 KB styles; the 575 KB engine chunk loads behind the loading screen |
| Cold start to menu | 1.1 to 1.7 s in the sandbox, including the SDK script from the CrazyGames CDN |
| Scene cost at 1280×720, Medium, in combat | 154 draw calls, 3,656 triangles, 27 geometries, 8 textures |
| Low and High at 1280×720 | 118 draw calls and 2,694 triangles at 0.75 render scale; 149 draw calls and 3,480 triangles |
| Frame time | Not measurable here. Chrome ran on a software rasteriser at roughly 5 frames per second. No GPU was available |
| Simulation speed | About 500 simulated seconds in 1.1 s of test time on 2 vCPUs |
| Scripted player, expert | Completes on seeds 1 to 3 in 14.4 to 15.2 s of game time, no damage taken |
| Scripted player, casual | Completes 5 of 6 seeds in 22.6 to 27.2 s taking 9 to 45 damage; dies once |
| Scripted player in the browser build | Completed in 28.8 s: 34 shots, 20 hits, 54 damage taken |
| CrazyGames lifecycle, from the SDK's own log | Loading start and stop once; gameplay start on Start; stop on pause; start on resume |
| Text size across frame sizes | 12 px at 821×462 up to 18 px at 1920×1080, nothing off screen |

Test environment: Modal sandbox, 2 vCPU, 8 GB, Linux, Node 24.22.2, Chrome for Testing 157 headless with SwiftShader. This is not a supported player device and none of the numbers above is a performance claim.

Screenshots from the actual build are in [`media/`](media/): menu, tunnel, concourse, combat, pause, settings, Low and High presets, results, and the smallest and largest frame sizes.

### Known issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md). The ones that matter most: no human has played or heard this build, nothing has run on a real GPU or on the platform, and the art is graybox.

### External dependencies and approvals

None of these has been bought, requested or assumed.

| Need | For | Blocks |
|---|---|---|
| CrazyGames developer account and Developer Portal access | Preview tool testing, game ID, submission options (Progress Save, lobby size) | Milestone 5 |
| Test hardware: a mid-range laptop with integrated graphics, a 4 GB Chromebook, Edge and Safari | Performance budgets and browser support | Milestone 2 |
| People to play it | Feel, difficulty, pacing, audio mix | Milestone 2 onward |
| A decision on art and audio production | Whether release assets stay code-built or are commissioned or bought. Any purchase is a cost and a licence to record | Milestone 2 |
| A host for the multiplayer server with TLS and a domain | Online play. CrazyGames hosts game files only. A small instance for testing is typically a few dollars a month; a real estimate comes with load tests | Milestone 4 |
| A repository decision | The game currently lives in `afterlight/` inside a repository named for another project | None, but worth settling early |

### Next: Milestone 2 — Visual vertical slice

One polished segment of "Dead Signal" with final-direction lighting and materials, a modelled weapon and security unit, environment reflections, a post-processing chain with bloom and a non-multisampled anti-aliasing option, a checkpoint, character collision, a first difficulty pass, and frame time, draw calls and memory measured on named hardware. The visual direction is validated there before the other five missions are built.
