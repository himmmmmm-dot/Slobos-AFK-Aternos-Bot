# Known issues

As of Milestone 1 (2026-11-10). Nothing here blocks the milestone, but every item under "Before release" blocks submission.

## Not yet verified

- **No human has played this build.** Combat feel, mouse sensitivity, difficulty, pacing and readability have only been exercised by automated input and a scripted player.
- **The audio has never been heard.** Every sound is synthesised and the code paths run without errors, but the mix, loudness and character of the sounds need a listening pass.
- **No real GPU.** All rendering ran on Chrome's software rasteriser at about 5 frames per second. Frame time, GPU memory and the 60 FPS target are unmeasured.
- **Chrome only.** Edge, Firefox and Safari are untested.
- **Not on the platform.** Nothing has run on crazygames.com or in the Developer Portal preview tool. The SDK was exercised only in its `local` environment.
- **No gameplay recording.** At 5 frames per second a recording would misrepresent the game. Screenshots are in `docs/media/`.

## Before release

- **Graybox art.** The level, the security unit and the pistol are built from boxes. This is the intended state for Milestone 1 and is replaced from Milestone 2.
- **No checkpoint.** Dying restarts the encounter. Checkpoints arrive with Milestone 2.
- **Characters do not block each other.** The player can walk through a security unit.
- **The encounter is too easy for a skilled player.** A unit needs roughly 1.5 to 2.3 seconds from first sight to first shot and does not lead a moving target. The expert scripted player finishes without taking damage; the casual one takes 9 to 45 damage and dies about one run in six. There are no difficulty settings yet.
- **Anti-aliasing is always multisampled.** The Low preset lowers resolution and drops the shadowed light but cannot turn multisampling off. A post-process option is planned with the Milestone 2 effects chain.
- **Each security unit costs about 17 draw calls.** Acceptable for five units; needs merging or instancing before larger fights.
- **No environment reflections.** Metals rely on direct light only.

## Behaviour to be aware of

- **Below 12 frames per second the game runs in slow motion.** The simulation catches up at most five ticks per frame so a stall cannot spiral.
- **Losing window focus pauses the game** and therefore reports a gameplay stop. CrazyGames says not to send a stop for focus changes alone; here the browser has released the mouse, so the pause is real. To be confirmed with their QA.
- **A setting changed in the last second before the tab closes may not be saved on CrazyGames.** Their data module batches writes for about a second.
- **Enemies cannot follow through the entry tunnel.** Navigation covers walking, ramps and stairs, not the jump and the crouch.
- **The comms log is per run** and is cleared when a mission restarts.
- **`?debug`, `?nolock` and `?autopilot` work in production builds.** They change no rules, but should be removed or gated before release.
- **No gamepad support and no touch support.** Touch-only devices see a "keyboard and mouse required" screen.
