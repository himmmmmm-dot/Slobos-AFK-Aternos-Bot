# AFTERLIGHT: BLACKOUT

An original browser first-person shooter being built for CrazyGames. The city of Veyra has gone dark, its security machines are enforcing orders that contradict each other, and Mara Venn has come back to find her brother.

**Status: Milestone 1 of 6 (foundation).** This build is one graybox encounter with one weapon and one enemy type. The six-mission campaign, the other four weapons and three enemy roles, online multiplayer, advertising and the release art are not in it. It has not been tested on crazygames.com. See [docs/MILESTONES.md](docs/MILESTONES.md) for what is done, measured and outstanding.

## Run it

Node.js 20 or newer.

```bash
cd afterlight
npm ci
npm run dev        # http://localhost:5173, no platform SDK
```

`W A S D` move, mouse looks, left mouse fires, `R` reloads, `Shift` sprints, `C` crouches, `Space` jumps, `E` interacts, `P` pauses and releases the mouse. All keys can be rebound in Settings.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm test` | Unit and simulation tests (Vitest) |
| `npm run typecheck` | TypeScript, strict |
| `npm run build` | Typecheck, then production build into `dist/` with the CrazyGames SDK adapter |
| `npm run preview` | Serve `dist/` on port 4173 |
| `npm run smoke` | Drive `dist/` in headless Chrome with real input, check the critical flows, write screenshots to `docs/media/`, then check the real pointer-lock flow |
| `npm run package` | Check `dist/` against the CrazyGames limits and write `release/*.zip` |
| `node scripts/sdk-probe.mjs` | Print the API the live CrazyGames SDK script exposes today |

`npm run smoke` and the SDK probe need Chrome. Set `CHROME_PATH` if it is not at `/usr/local/bin/google-chrome`.

## Configuration

Copy `.env.example` to `.env.local` to override. There are no secrets: every `VITE_` value is compiled into the public bundle.

| Variable | Values | Default |
|---|---|---|
| `VITE_PLATFORM` | `crazygames` loads the CrazyGames HTML5 SDK v3; `none` runs with no platform SDK | `none` for `npm run dev`, `crazygames` for `npm run build` |

With `VITE_PLATFORM=crazygames` on `localhost` or `127.0.0.1` the SDK runs in its own `local` test environment. On any other non-CrazyGames domain it reports `disabled`, and the game says so on the menu and carries on without it.

URL switches for automation and debugging. None changes the game's rules:

| Switch | Effect |
|---|---|
| `?debug` | Shows a frame-time readout and exposes `window.__afterlight` for reading state |
| `?nolock` | Mouse look without pointer lock, so automated input checks do not depend on lock timing |
| `?autopilot` | A scripted player plays the mission (used for captures; always labelled as automation) |

## Layout

```
src/shared/   deterministic core: maths, collision, movement, weapons, fixed timestep
src/game/     simulation: missions, enemy AI, navigation, levels, scripted player
src/client/   browser only: app shell, input, renderer, audio, UI, persistence, platform adapter
tests/        Vitest suites
scripts/      smoke test, packaging, SDK probe
docs/         compliance matrix, technical decision, assets, known issues, milestone reports, screenshots
```

`src/shared` and `src/game` have no browser dependencies, which is what lets the same code run in tests now and on the multiplayer server in Milestone 4.

## Documents

- [Milestone reports](docs/MILESTONES.md)
- [CrazyGames compliance matrix](docs/COMPLIANCE.md)
- [Technical foundation](docs/TECH_DECISION.md)
- [Asset and licence manifest](docs/ASSETS.md)
- [Known issues](docs/KNOWN_ISSUES.md)
