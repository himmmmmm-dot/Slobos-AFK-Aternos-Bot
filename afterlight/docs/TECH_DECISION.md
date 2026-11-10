# Technical foundation

Decided 2026-11-10 after inspecting the repository and the current CrazyGames requirements.

## What was in the repository

| Area | Finding |
|---|---|
| Root project | A Node.js Minecraft AFK bot (`mineflayer`, `express`). Unrelated to a browser game |
| `saltline/` | Co-op room relay for a different browser game: Node + `ws`, room codes, rate limits, heartbeats. It relays events between clients and is not authoritative |
| Engine, renderer, asset pipeline | None |
| CrazyGames integration | None |
| Tests | `node --test` suites for `saltline` only |

Nothing could be reused as a game engine, so AFTERLIGHT lives in its own folder, `afterlight/`, next to `saltline/`. The `saltline` server's transport habits (per-socket token bucket, message size cap, heartbeat, short room codes) are the model for the Milestone 4 server, which will be authoritative and written fresh.

## Chosen stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript 7, strict | One language for client, simulation and server; the simulation is shared verbatim |
| Rendering | three.js 0.187, `WebGLRenderer` on WebGL 2 | Mature and small. WebGL 2 is the widely supported baseline; WebGPU stays an optional later enhancement |
| Build | Vite 8 | Fast dev server, code-split production build, relative asset paths |
| Physics | Own kinematic controller over boxes and ramps (`src/shared`) | No WASM download, deterministic, and it runs unchanged on a server. A general physics engine would add over a megabyte for features an FPS controller does not need |
| Simulation | Fixed 60 Hz tick, DOM-free (`src/shared`, `src/game`) | Required by CrazyGames ("consistent physics across refresh rates") and by server authority |
| AI navigation | Grid derived from collision geometry at load, A* | No hand-placed waypoints; handles ramps, stairs and stacked floors |
| UI | DOM and CSS over the canvas | Crisp text at every frame size, real keyboard focus, no font atlas |
| Audio | Web Audio, synthesised at runtime | Nothing to download or license in this milestone |
| Multiplayer (Milestone 4) | Separate Node service, WebSocket (`ws`), authoritative, sharing `src/shared` | CrazyGames hosts only game files, so the backend must be deployable on its own |
| Tests | Vitest for logic; headless Chrome driven by `puppeteer-core` for the real build | Logic tests run in two seconds; the browser pass catches integration bugs |

## Measured against the criteria

| Criterion | Result |
|---|---|
| Build size and initial download | About 650 KB on disk, about 175 KB gzipped, in 5 files. The limit is 50 MB |
| Browser compatibility | WebGL 2 only. Verified on Chrome 157 so far |
| Rendering quality | PBR materials, tone mapping, fog, one shadowed key light. Post-processing arrives with Milestone 2 |
| Physics | Walls, steps, slopes, crouch, jump, ledges covered by tests |
| Asset tooling | None needed yet: everything is procedural. Milestone 2 adds glTF with compressed textures |
| Multiplayer integration | The simulation already runs headless in Node (the test suite does exactly that) |
| Maintainability | Thirteen responsibilities in separate modules, listed below |
| CrazyGames compatibility | SDK v3 behind one adapter; see `COMPLIANCE.md` |

## Module boundaries

| Responsibility | Location |
|---|---|
| Startup and lifecycle | `src/client/app.ts`, `src/client/appState.ts`, `src/client/lifecycle.ts` |
| Input | `src/client/input.ts`, `src/client/bindings.ts` |
| Player movement | `src/shared/movement.ts`, `src/shared/collision.ts` |
| Weapons and damage | `src/shared/weapons.ts`, `src/game/sim.ts` |
| Mission state | `src/game/sim.ts`, `src/game/level.ts`, `src/game/levels/` |
| Enemy AI | `src/game/ai/enemy.ts`, `src/game/nav.ts` |
| Rendering and effects | `src/client/render/` |
| Audio | `src/client/audio/audio.ts` |
| UI | `src/client/ui/` |
| Persistence | `src/client/persistence/` |
| Platform SDK adapter | `src/client/platform/` |
| Multiplayer client | Milestone 4 |
| Authoritative server | Milestone 4 |

`src/shared` and `src/game` import nothing from `src/client`, the DOM or three.js.

## Application states

`boot → loading → menu → playing ⇄ paused`, with `playing → results | failed`, each of which returns to `playing` or `menu`, and `error` reachable from anywhere. Only `playing` counts as gameplay for the platform. Multiplayer adds lobby, match and match-results states in Milestone 4; a paused client will not pause a live match.
