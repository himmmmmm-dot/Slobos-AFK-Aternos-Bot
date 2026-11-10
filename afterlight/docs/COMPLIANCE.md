# CrazyGames compliance matrix

- **Documentation checked:** 2026-11-10, <https://docs.crazygames.com/> and the pages linked in the Source column.
- **Integration channel:** HTML5 SDK **v3**, loaded at runtime from `https://sdk.crazygames.com/crazygames-sdk-v3.js`. No v1/v2 SDK, engine wrapper or other platform SDK is present.
- **Live script checked:** `node scripts/sdk-probe.mjs` loads that script on 127.0.0.1 and lists what it exposes. Every member this game calls was present on 2026-11-10.
- **Status words:** *Verified* means an executed test or measurement in this repository. *Local SDK* means verified against the real SDK script in its `local` environment, which is not the CrazyGames site. *Unverified* means implemented but not yet exercised where it matters. *Planned* means not implemented.

Nothing in this matrix has been tested on crazygames.com or in the Developer Portal preview tool. That needs a developer account and is listed under external dependencies in `MILESTONES.md`.

## Mandatory for any launch (Basic requirements)

| Requirement | Official source | Applicability | Implementation | Verification |
|---|---|---|---|---|
| Initial download ≤ 50 MB, measured until the first gameplay start (≤ 20 MB for mobile homepage) | requirements/technical | Mandatory | Vite build; `scripts/package.mjs` fails the package above the limit | Verified: see size in `MILESTONES.md` (well under 1 MB) |
| Total size ≤ 250 MB, ≤ 1,500 files | requirements/technical | Mandatory | `scripts/package.mjs` | Verified by the package script |
| Relative paths only inside the bundle | requirements/technical | Mandatory | `base: './'` in `vite.config.ts`; package script scans for absolute paths | Verified: smoke test serves the build from `/embedded/afterlight/` |
| Works on Chrome and Edge (Safari is disabled if it runs poorly) | requirements/technical | Mandatory | WebGL 2 baseline, no newer graphics API required | Verified on Chrome for Testing 157 (headless, software GL) only. Edge, Safari, Firefox and real GPUs: unverified |
| Runs smoothly on a 4 GB Chromebook to stay enabled on ChromeOS | requirements/technical | Mandatory for ChromeOS | Low preset (0.75 render scale, no shadow pass) | Unverified: no device |
| Mouse and keyboard on desktop, landscape | requirements/technical | Mandatory | `src/client/input.ts` | Verified with real key and mouse events in `scripts/smoke.mjs` |
| Mobile and touch | requirements/technical | Not in scope for this release | `App.boot` shows "Keyboard and mouse required" on touch-only devices | Unverified on a real device. Submission must be desktop-only |
| PEGI 12 | requirements/gameplay | Mandatory | Enemies are machines; no blood, gore, profanity, gambling or drugs | Self-assessed. The rating decision is CrazyGames QA's |
| Text legible at device pixel ratio 1 on the listed 16:9 frame sizes | requirements/gameplay | Mandatory | UI font scales with frame height (`styles.css`), HUD size setting | Verified at 821×462, 907×510, 1077×606, 1216×684, 1366×768, 1920×1080 (smoke test; minimum 12 px text, nothing off screen) |
| Physics consistent across refresh rates | requirements/gameplay | Mandatory | Fixed 60 Hz simulation tick (`src/shared/loop.ts`); nothing in gameplay reads frame time | Verified: unit tests at 30 to 240 Hz |
| English localisation | requirements/gameplay | Mandatory | All text is English | Verified by inspection. No translations yet |
| No custom fullscreen button | requirements/gameplay | Mandatory | None exists | Verified by inspection |
| No cross-promotion or external links | requirements/gameplay | Mandatory | None exist | Verified: package script reports the only external host is `sdk.crazygames.com` |
| Original names, assets and content | requirements/gameplay, requirements/quality | Mandatory | Original setting and characters; all art and audio generated at runtime | See `ASSETS.md` |
| First-person games lock the mouse and offer a key to release it | resources/mouse-control | Mandatory for this genre | Pointer lock on Start and Resume; `P` (rebindable) and Escape release it | Verified in headless Chrome 157 with real pointer lock (`scripts/lock-probe.mjs`): Start locks and plays, losing the lock pauses, Resume locks again, `P` releases. Unverified inside the CrazyGames frame and with a physical Escape press |
| Avoid keys with browser behaviour (Escape closes fullscreen, Ctrl+W closes the tab) | requirements/quality#restricted-keys | Mandatory | No default uses Ctrl; Escape, Ctrl, Alt, Meta and function keys cannot be bound; `P` pauses without leaving fullscreen | Verified: unit tests |
| Bindings follow the player's keyboard layout | requirements/quality#restricted-keys | Recommended | Physical key codes, labels from the keyboard layout map where the browser offers it | Verified for label logic (unit test). No test on a physical AZERTY keyboard |
| Onboarding inside gameplay, visual, skippable | requirements/quality | Recommended | Tunnel prompts with key caps, controls strip on the menu; nothing blocks play | Verified by screenshots `02`–`04` |
| No ads or analytics outside the SDK; privacy notice only if extra personal data is collected | requirements/ads, requirements/technical#user-consent | Mandatory | No analytics, no third-party requests, no personal data collected by the client | Verified by the package script's host scan |

## Full launch (SDK) requirements

| Requirement | Official source | Applicability | Implementation | Verification |
|---|---|---|---|---|
| Load SDK v3 and `await window.CrazyGames.SDK.init()` before using it, once | sdk/intro | Mandatory | `src/client/platform/crazygames.ts` (`init`, shared promise) | Verified: unit tests; Local SDK: initialises in the smoke test |
| Detect the environment with `SDK.environment` (`local`, `crazygames`, `disabled`) | sdk/intro | Mandatory | Same file. `disabled` and any failure make the adapter report `unavailable` | Verified for `disabled`, blocked script, rejected init and timeouts (unit tests, smoke test). Local SDK for `local`. `crazygames`: unverified |
| The game keeps working when the SDK is blocked or fails | requirements/ads (AdBlock) | Mandatory | Adapter never throws; menu shows a notice | Verified: smoke test with the SDK host blocked plays normally |
| `game.gameplayStart()` when play starts or resumes, `game.gameplayStop()` on every break | sdk/game, requirements/technical | Mandatory | `src/client/lifecycle.ts` derives both from application state; adapter drops duplicates | Verified: unit tests over a whole session; Local SDK: the SDK's own log shows start, stop on pause, start on resume |
| Do not send `gameplayStop` just because focus moved | sdk/game | Mandatory | Losing focus releases the mouse, which pauses this game, so a stop is a real pause | By design. Worth confirming with CrazyGames QA |
| `game.loadingStart()` / `game.loadingStop()` | sdk/game | Optional, selected | `lifecycle.ts`: sent once around real loading | Local SDK: SDK log shows one start and one stop |
| `game.settings.muteAudio` and its change listener | sdk/game ("Full Implementation requires muteAudio support") | Mandatory | Adapter exposes it; `AudioEngine` treats it as its own mute reason | Verified: unit tests; Local SDK: `?muteAudio=true` silences the game |
| Land players in gameplay immediately, at most one click | requirements/gameplay | Mandatory | One click on Start (the browser needs a click for pointer lock and audio) | Verified: smoke test |
| Progress saved with the Data module (`data.getItem`/`setItem`/`removeItem`), 1 MB limit, about 1 s debounce | sdk/data, requirements/account-integration | Applicable: settings now, campaign progress in Milestone 3 | Adapter `dataStore`; `SafeStore` wrapper; used alone when present so account data is never mirrored into shared browser storage | Local SDK: settings survive a reload through the data module. Verified: fallback when the module throws `dataModuleDisabled`. Needs the "Progress Save: Data Module" option at submission |
| Video ads: `ad.requestAd('midgame' or 'rewarded', { adStarted, adFinished, adError })`, mute and pause on `adStarted`, resume on `adFinished` or `adError`, reward only on `adFinished` | sdk/video-ads, requirements/ads | Applicable (ads are disabled during Basic Launch) | Planned for Milestone 5. `AudioEngine` already has a separate `ad` mute reason so an advert ending cannot undo the player's mute | Planned |
| Ad placement: natural breaks only, never on navigation buttons, block input while a request is pending, handle `adError` (`unfilled`, `adblock`, `adCooldown`, `adsDisabled`, `other`) | requirements/ads | Applicable | Planned: midgame only after results and before a retry; no ads during a multiplayer match | Planned |
| Rewarded ads: opt-in, clearly labelled, equal-weight decline, no reward on `adError`, not required to progress | requirements/ads | Applicable | Planned, with a non-competitive reward only | Planned |
| `ad.hasAdblock()`; never penalise AdBlock users | sdk/video-ads, requirements/ads | Applicable | Planned (to hide rewarded offers that cannot be filled) | Planned |
| `game.reportGameCompletedPercentage`, `game.setGameContext` / `clearGameContext` | sdk/game | Optional, applicable to the campaign | Planned for Milestones 3 and 5 | Planned |
| `game.happytime()` | sdk/game | Optional; sparing use only | Planned: campaign ending | Planned |
| User module: `isUserAccountAvailable`, `getUser`, `addAuthListener`, `getUserToken` (verify RS256 against the JWKS and check `gameId` on the server) | sdk/user, requirements/account-integration, requirements/multiplayer | Applicable from Milestone 4: show the CrazyGames username in multiplayer, verify identity on the game server, guests always allowed | Planned | Planned |
| Multiplayer room data: `game.updateRoom`, `game.leftRoom`, `inviteParams`, `addJoinRoomListener`, `inviteLink`, `isInstantMultiplayer`; same group stays together across rounds; lobby size declared at submission | requirements/multiplayer, sdk/game | Applicable from Milestone 4 | Planned | Planned |
| Chat must honour `settings.disableChat` and be moderated | requirements/multiplayer | Not applicable: the game will ship predefined pings, no free-text chat | — | — |

## Evaluated and not used

| Feature | Official source | Decision |
|---|---|---|
| `showInviteButton` / `hideInviteButton` | sdk/game | Deprecated in favour of room data. Not used |
| `game.isInstantJoin` | sdk/game | Deprecated name. `isInstantMultiplayer` will be used |
| `IN_GAME_AUTH_LEGACY` token key | sdk/user | Legacy. `IN_GAME_AUTH` with the JWKS will be used |
| In-game banners (`banner.requestBanner`, `requestResponsiveBanner`) | sdk/banners, requirements/ads | Not selected for now: not allowed during gameplay and they cost performance. To be reconsidered for the results screen in Milestone 5 |
| Friends list (`user.listFriends`) | sdk/user | Not selected: join and invite go through room data |
| In-game purchases (Xsolla) | sdk/in-game-purchases | Not applicable: the game sells nothing, and the feature is invite-only |
| Leaderboards | sdk/leaderboards | Invite-only, one per game. Not applicable unless CrazyGames invites the game |
| Sitelock | resources/html5/sitelock | Optional. Not implemented; if added it must allow every CrazyGames origin including the app origins |
| Members of the live SDK that the documentation does not describe (for example `game.dailyEvent`, `game.quality`, `game.getLaunchContext`, `ad.prefetchAd`, `user.submitScore`) | not documented | Not used |

## Needs the platform or a decision outside this repository

- Testing in the Developer Portal preview tool and on crazygames.com (developer account).
- The Progress Save option and lobby size chosen in the submission form.
- Game covers, trailer, description and controls text for the submission (Milestone 6).
- Pages not yet read in detail because nothing in this milestone depends on them: game covers, sitelock, in-game purchases, leaderboards client and API. They will be read before the features above are built.
