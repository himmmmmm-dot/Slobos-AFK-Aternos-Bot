import { describe, expect, it } from 'vitest';
import type { AiState, SimEvent } from '../src/game/events';
import { BOT_CASUAL, BotController } from '../src/game/bot';
import { GRAYBOX } from '../src/game/levels/graybox';
import { Simulation } from '../src/game/sim';
import { SERVICE_PISTOL } from '../src/shared/weapons';
import { distanceXZ, vec3 } from '../src/shared/math';
import { box, FLOOR, run, teleport, testLevel } from './helpers';

const has = (sim: Simulation, type: SimEvent['type']): boolean => sim.events.some((e) => e.type === type);
const states = (sim: Simulation, id = 0): AiState[] =>
  sim.events.flatMap((e) => (e.type === 'enemyState' && e.id === id ? [e.state] : []));

/** One unit at z = -5 facing the player, who spawns at z = 10. */
const facing = (over = {}) =>
  testLevel({ enemies: [{ kind: 'security', pos: vec3(0, 0, -5), yaw: Math.PI, patrol: [vec3(0, 0, -5)] }], ...over });

describe('enemy perception', () => {
  it('spots a player in plain view, telegraphs, then fires', () => {
    const sim = new Simulation(facing());
    run(sim, 600);
    const order = sim.events.filter((e) => e.type === 'enemyWindup' || e.type === 'enemyFire').map((e) => e.type);
    expect(states(sim)).toContain('combat');
    expect(order[0]).toBe('enemyWindup');
    expect(order).toContain('enemyFire');
    expect(sim.stats.damageTaken).toBeGreaterThan(0);
  });

  it('takes longer to notice a crouched player', () => {
    const noticeTick = (crouch: boolean): number => {
      const sim = new Simulation(facing());
      let at = -1;
      run(sim, 600, { crouch }, (s) => {
        if (s.enemies[0].state === 'combat') at = s.tick;
        return at >= 0;
      });
      return at;
    };
    const standing = noticeTick(false);
    const crouched = noticeTick(true);
    expect(standing).toBeGreaterThan(10);
    expect(crouched).toBeGreaterThan(standing);
  });

  it('cannot see or shoot through a wall', () => {
    const sim = new Simulation(facing({ solids: [FLOOR, box(-30, 0, 2, 30, 6, 3)] }));
    run(sim, 900);
    expect(sim.enemies[0].state).toBe('patrol');
    expect(sim.enemies[0].awareness).toBe(0);
    expect(sim.stats.damageTaken).toBe(0);
    expect(has(sim, 'enemyFire')).toBe(false);
  });

  it('ignores a player behind it until it hears gunfire, then investigates', () => {
    const level = testLevel({ enemies: [{ kind: 'security', pos: vec3(0, 0, -5), yaw: 0, patrol: [vec3(0, 0, -5)] }] });
    const sim = new Simulation(level);
    run(sim, 300);
    expect(sim.enemies[0].state).toBe('patrol');
    // Fire away from the unit so the round itself is not what alerts it.
    run(sim, 2, (t) => ({ yaw: Math.PI / 2, fire: t === 0 }));
    expect(has(sim, 'shot')).toBe(true);
    expect(states(sim)).toEqual(['investigate']);
  });

  it('does not hear gunfire from beyond its range', () => {
    const level = testLevel({
      spawn: { pos: vec3(0, 0, 28), yaw: 0 },
      enemies: [{ kind: 'security', pos: vec3(0, 0, -5), yaw: 0, patrol: [vec3(0, 0, -5)] }],
    });
    expect(SERVICE_PISTOL.noiseRadius).toBeLessThan(33);
    const sim = new Simulation(level);
    run(sim, 40, (t) => ({ yaw: Math.PI / 2, fire: t === 30 }));
    expect(has(sim, 'shot')).toBe(true);
    expect(sim.enemies[0].state).toBe('patrol');
  });
});

describe('enemy combat and recovery', () => {
  it('enters combat when shot and is removed from play when destroyed', () => {
    const level = testLevel({ enemies: [{ kind: 'security', pos: vec3(0, 0, -5), yaw: 0, patrol: [vec3(0, 0, -5)] }] });
    const sim = new Simulation(level);
    run(sim, 30);
    expect(sim.damageEnemyById(0, 30)).toBe(false);
    expect(sim.enemies[0].state).toBe('combat');
    expect(has(sim, 'enemyHurt')).toBe(true);
    expect(sim.damageEnemyById(0, 500)).toBe(true);
    expect(sim.enemies[0].state).toBe('dead');
    expect(sim.stats.kills).toBe(1);
    expect(sim.damageEnemyById(0, 500)).toBe(false);
    expect(sim.stats.kills).toBe(1);
    // A round through the wreck now passes on; nothing is hit.
    sim.events = [];
    run(sim, 2, (t) => ({ fire: t === 0, pitch: 0 }));
    const shot = sim.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hits[0].enemyId).toBeNull();
  });

  it('kills with body shots and faster with critical hits, through the real weapon', () => {
    const shotsToKill = (pitch: number): number => {
      const sim = new Simulation(facing({ spawn: { pos: vec3(0, 0, 3), yaw: 0 } }));
      run(sim, 40);
      run(sim, 400, (t) => ({ fire: t % 2 === 0, pitch }), (s) => s.enemies[0].state === 'dead');
      expect(sim.enemies[0].state).toBe('dead');
      return sim.stats.shots;
    };
    // Eye height 1.62; the unit is 8 m away. Level aim strikes the head zone, a low aim the body.
    const body = shotsToKill(-0.12);
    const head = shotsToKill(0.01);
    expect(body).toBe(Math.ceil(90 / SERVICE_PISTOL.damage));
    expect(head).toBe(Math.ceil(90 / (SERVICE_PISTOL.damage * SERVICE_PISTOL.critMultiplier)));
  });

  it('stops a bolt at cover instead of letting it through', () => {
    const sim = new Simulation(testLevel({ solids: [FLOOR, box(-3, 0, 4, 3, 3, 5)] }));
    sim.spawnBolt(vec3(0, 1.2, -5), vec3(0, 0, 1), 30, 9);
    run(sim, 120);
    const impact = sim.events.find((e) => e.type === 'boltImpact');
    expect(impact && impact.type === 'boltImpact' && impact.hitPlayer).toBe(false);
    expect(impact && impact.type === 'boltImpact' && impact.point.z).toBeCloseTo(4, 3);
    expect(sim.stats.damageTaken).toBe(0);
    expect(sim.bolts.length).toBe(0);
    // The same bolt with nothing in the way does connect.
    const open = new Simulation(testLevel());
    open.spawnBolt(vec3(0, 1.2, -5), vec3(0, 0, 1), 30, 9);
    run(open, 120);
    expect(open.stats.damageTaken).toBe(9);
  });

  it('searches, gives up and returns to its post when the target disappears', () => {
    const level = facing({ solids: [FLOOR, box(-30, 0, 14, 30, 6, 15)] });
    const sim = new Simulation(level);
    run(sim, 400, {}, (s) => s.enemies[0].state === 'combat');
    expect(sim.enemies[0].state).toBe('combat');
    // The player vanishes behind a sealed wall.
    teleport(sim, 0, 0, 22);
    run(sim, 60 * 40, {}, (s) => s.enemies[0].state === 'patrol');
    const seen = states(sim);
    expect(seen.indexOf('search')).toBeGreaterThan(seen.indexOf('combat'));
    expect(seen.indexOf('return')).toBeGreaterThan(seen.indexOf('search'));
    expect(sim.enemies[0].state).toBe('patrol');
    run(sim, 60 * 6);
    expect(distanceXZ(sim.enemies[0].body.pos, vec3(0, 0, -5))).toBeLessThan(1.5);
    expect(sim.enemies[0].awareness).toBe(0);
  });

  it('stands down when the player is dead', () => {
    const sim = new Simulation(facing());
    run(sim, 300, {}, (s) => s.enemies[0].state === 'combat');
    sim.hurtPlayer(1000, null);
    run(sim, 120);
    expect(sim.enemies[0].state).not.toBe('combat');
    const fired = sim.events.filter((e) => e.type === 'enemyFire').length;
    run(sim, 600);
    expect(sim.events.filter((e) => e.type === 'enemyFire').length).toBe(fired);
  });

  it('recovers when it is wedged somewhere the navigation grid cannot reach', () => {
    const pit = [box(-0.8, 0, -0.8, -0.6, 0.7, 0.8), box(0.6, 0, -0.8, 0.8, 0.7, 0.8), box(-0.8, 0, -0.8, 0.8, 0.7, -0.6), box(-0.8, 0, 0.6, 0.8, 0.7, 0.8)];
    const level = testLevel({
      solids: [FLOOR, ...pit, box(-30, 0, 5, 30, 6, 6)],
      enemies: [{ kind: 'security', pos: vec3(0, 0, 0), patrol: [vec3(8, 0, 0), vec3(8, 0, -6)] }],
    });
    const sim = new Simulation(level);
    run(sim, 60 * 20);
    expect(sim.stats.navRecoveries).toBeGreaterThanOrEqual(1);
    const p = sim.enemies[0].body.pos;
    expect(Math.abs(p.x) > 0.8 || Math.abs(p.z) > 0.8).toBe(true);
    expect(p.x).toBeGreaterThan(5);
  });
});

describe('mission flow', () => {
  const level = () =>
    testLevel({
      enemies: [{ kind: 'security', pos: vec3(-20, 0, -20), yaw: Math.PI / 2, patrol: [vec3(-20, 0, -20)] }],
      triggers: [{ id: 'gate', min: vec3(-1, 0, 4), max: vec3(1, 3, 6) }],
      interactables: [{ id: 'console', pos: vec3(0, 1, -2), radius: 2.4, holdTicks: 30, prompt: 'Hold' }],
      pickups: [{ id: 'med', kind: 'health', pos: vec3(5, 0, 10), amount: 40 }],
      objectives: [
        { id: 'enter', kind: 'reach', trigger: 'gate', text: 'Enter' },
        { id: 'clear', kind: 'eliminate', text: 'Clear' },
        { id: 'use', kind: 'interact', target: 'console', text: 'Use' },
      ],
      hints: [{ trigger: 'gate', text: 'hint' }],
      radio: [
        { on: 'start', lines: [{ speaker: 'A', text: 'start' }] },
        { on: 'objective:clear:done', lines: [{ speaker: 'A', text: 'cleared' }] },
        { on: 'complete', lines: [{ speaker: 'A', text: 'done' }] },
      ],
    });
  const radio = (sim: Simulation): string[] =>
    sim.events.flatMap((e) => (e.type === 'radio' ? e.lines.map((l) => l.text) : []));
  const objectives = (sim: Simulation): string[] =>
    sim.events.flatMap((e) => (e.type === 'objective' ? [`${e.completed}>${e.next}`] : []));

  it('advances objectives in order and completes the mission', () => {
    const sim = new Simulation(level());
    expect(radio(sim)).toEqual(['start']);
    expect(sim.currentObjective()?.id).toBe('enter');
    expect(sim.objectiveMarker()).toEqual({ x: 0, y: 1.2, z: 5 });

    run(sim, 200, { moveZ: 1 }, (s) => s.mission.index > 0);
    expect(objectives(sim)).toEqual(['enter>clear']);
    expect(has(sim, 'hint')).toBe(true);

    run(sim, 10);
    expect(sim.mission).toMatchObject({ status: 'active', index: 1, done: 0, total: 1 });
    sim.damageEnemyById(0, 999);
    run(sim, 1);
    expect(objectives(sim)).toEqual(['enter>clear', 'clear>use']);
    expect(radio(sim)).toContain('cleared');

    // Stand in front of the console, facing it. Yaw 0 looks down -Z.
    teleport(sim, 0, 0, 0);
    run(sim, 1);
    expect(sim.player.interactTarget).toBe('console');
    run(sim, 29, { interact: true });
    expect(sim.player.interactProgress).toBe(29);
    run(sim, 1, { interact: false });
    expect(sim.player.interactProgress).toBe(0);
    expect(sim.mission.status).toBe('active');
    run(sim, 30, { interact: true });
    expect(sim.mission.status).toBe('complete');
    expect(has(sim, 'missionComplete')).toBe(true);
    expect(radio(sim)).toContain('done');
    expect(sim.currentObjective()).toBeNull();
  });

  it('only offers an interaction when the player is close and facing it', () => {
    const sim = new Simulation(level());
    sim.mission.index = 2;
    teleport(sim, 0, 0, 0);
    run(sim, 1, { yaw: Math.PI });
    expect(sim.player.interactTarget).toBeNull();
    teleport(sim, 0, 0, 6);
    run(sim, 1, { yaw: 0 });
    expect(sim.player.interactTarget).toBeNull();
    run(sim, 60, { interact: true });
    expect(sim.mission.status).toBe('active');
  });

  it('fails on death, stops accepting input, and a fresh simulation starts clean', () => {
    const def = level();
    const sim = new Simulation(def);
    sim.hurtPlayer(40, null);
    expect(sim.player.hp).toBe(60);
    sim.hurtPlayer(80, null);
    expect(sim.player.alive).toBe(false);
    expect(sim.mission.status).toBe('failed');
    expect(has(sim, 'playerDead')).toBe(true);
    const z = sim.player.move.body.pos.z;
    run(sim, 60, { moveZ: 1, fire: true });
    expect(sim.player.move.body.pos.z).toBe(z);
    expect(sim.stats.shots).toBe(0);
    sim.hurtPlayer(50, null);
    expect(sim.stats.damageTaken).toBe(120);

    const again = new Simulation(def, sim.nav);
    expect(again.player).toMatchObject({ hp: 100, alive: true });
    expect(again.mission).toMatchObject({ status: 'active', index: 0 });
    expect(again.enemies[0].state).toBe('patrol');
  });

  it('heals from a pickup once, never above the maximum, and regenerates only to the floor', () => {
    const sim = new Simulation(level());
    teleport(sim, 5, 0, 10);
    run(sim, 2);
    expect(sim.pickupsTaken.size).toBe(0);
    sim.hurtPlayer(20, null);
    run(sim, 2);
    expect(sim.player.hp).toBe(100);
    expect(sim.pickupsTaken.has('med')).toBe(true);
    sim.hurtPlayer(80, null);
    run(sim, 60 * 4);
    expect(sim.player.hp).toBe(20);
    run(sim, 60 * 12);
    expect(sim.player.hp).toBe(50);
  });

  it('kills a player who falls out of the level instead of leaving them stuck', () => {
    const sim = new Simulation(testLevel({ solids: [box(-2, -1, 8, 2, 0, 12)], killY: -10 }));
    run(sim, 60 * 6, { moveZ: 1 });
    expect(sim.mission.status).toBe('failed');
  });
});

describe('graybox encounter', () => {
  const nav = Simulation.buildNav(GRAYBOX);

  it('connects the hall, both routes to the mezzanine and the relay room', () => {
    const hall = vec3(0, 0, 10);
    for (const goal of [vec3(-10, 3, -11.3), vec3(10, 3, -11.3), vec3(0, 0, -20), vec3(-14.5, 0, 12.5)]) {
      expect(nav.findPath(hall, goal)).not.toBeNull();
    }
    // Each route is short only if its own ramp or stairs is used; the other way round is over 40 m.
    const lengthOf = (path: { x: number; y: number; z: number }[] | null): number => {
      expect(path).not.toBeNull();
      let len = 0;
      for (let i = 1; i < path!.length; i++) len += Math.hypot(path![i].x - path![i - 1].x, path![i].z - path![i - 1].z);
      return len;
    };
    expect(lengthOf(nav.findPath(vec3(-12, 0, 2), vec3(-14.7, 3, -11)))).toBeLessThan(22);
    expect(lengthOf(nav.findPath(vec3(12, 0, -2), vec3(14.7, 3, -11)))).toBeLessThan(22);
  });

  it('can be finished from a fresh start by the scripted player', () => {
    const results: string[] = [];
    for (const seed of [1, 2, 3]) {
      const sim = new Simulation(GRAYBOX, nav, seed);
      const bot = new BotController(sim);
      while (sim.mission.status === 'active' && sim.tick < 60 * 300) sim.step(bot.next());
      results.push(
        `seed ${seed}: ${sim.mission.status} in ${(sim.tick / 60).toFixed(1)}s, shots ${sim.stats.shots}, hits ${sim.stats.hits}, ` +
          `damage taken ${sim.stats.damageTaken}, nav recoveries ${sim.stats.navRecoveries}`,
      );
      expect(sim.mission.status).toBe('complete');
      expect(sim.stats.kills).toBe(GRAYBOX.enemies.length);
      expect(sim.events.filter((e) => e.type === 'objective').length).toBe(GRAYBOX.objectives.length);
    }
    console.log(results.join('\n'));
  });

  it('threatens a slower player: the units land hits before they are destroyed', () => {
    const results: string[] = [];
    let damage = 0;
    let completed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = new Simulation(GRAYBOX, nav, seed);
      const bot = new BotController(sim, BOT_CASUAL);
      while (sim.mission.status === 'active' && sim.tick < 60 * 300) sim.step(bot.next());
      damage += sim.stats.damageTaken;
      if (sim.mission.status === 'complete') completed++;
      results.push(
        `casual seed ${seed}: ${sim.mission.status} in ${(sim.tick / 60).toFixed(1)}s, kills ${sim.stats.kills}/${GRAYBOX.enemies.length}, ` +
          `shots ${sim.stats.shots}, hits ${sim.stats.hits}, damage taken ${sim.stats.damageTaken}, health left ${Math.round(sim.player.hp)}`,
      );
    }
    console.log(results.join('\n'));
    expect(damage).toBeGreaterThan(0);
    expect(completed).toBeGreaterThan(0);
  });

  it('keeps every unit moving: nobody ends a long patrol stuck in geometry', () => {
    const sim = new Simulation(GRAYBOX, nav, 9);
    // The player waits in the tunnel, out of sight, while the units patrol for two minutes.
    const travelled = sim.enemies.map(() => 0);
    run(sim, 60 * 120, {}, (s) => {
      s.enemies.forEach((e, i) => (travelled[i] += e.speed / 60));
    });
    expect(sim.enemies.every((e) => e.state === 'patrol')).toBe(true);
    expect(sim.stats.navRecoveries).toBe(0);
    sim.enemies.forEach((e, i) => {
      if (e.patrol.length > 1) expect(travelled[i]).toBeGreaterThan(20);
    });
  });
});
