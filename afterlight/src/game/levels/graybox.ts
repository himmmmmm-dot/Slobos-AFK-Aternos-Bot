import type { Solid } from '../../shared/collision';
import { vec3 } from '../../shared/math';
import type { LevelDef } from '../level';

/**
 * Milestone 1 graybox: the concourse of the powerless transit station from "Dead Signal".
 * A tunnel teaches crouch and jump, the hall is one encounter built around a central kiosk,
 * low cover and a mezzanine reached by a ramp or stairs, and the relay room ends the run.
 */
const solids: Solid[] = [];

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tag: string): void {
  solids.push({ min: vec3(x0, y0, z0), max: vec3(x1, y1, z1), tag });
}

box(-20, -1, -29, 20, 0, 28, 'floor');

// Entry tunnel: interior x -3..3, z 15..26.
box(-4, 0, 15, -3, 3.5, 27, 'wall');
box(3, 0, 15, 4, 3.5, 27, 'wall');
box(-3, 0, 26, 3, 3.5, 27, 'wall');
box(-4, 3.5, 15, 4, 4.5, 27, 'ceiling');
box(-3, 1.3, 20.6, 3, 3.5, 21.2, 'hazard'); // collapsed beam: crouch under
box(-3, 0, 17.4, 3, 0.9, 18, 'cover'); // barricade: jump over

// Concourse hall: interior x -16..16, z -14..14, 7 m high.
box(-17, 0, 14, -3, 7, 15, 'wall');
box(3, 0, 14, 17, 7, 15, 'wall');
box(-3, 3.5, 14, 3, 7, 15, 'wall');
box(-17, 0, -15, -2, 7, -14, 'wall');
box(2, 0, -15, 17, 7, -14, 'wall');
box(-2, 2.6, -15, 2, 7, -14, 'wall');
box(-17, 0, -14, -16, 7, 14, 'wall');
box(16, 0, -14, 17, 7, 14, 'wall');
box(-17, 7, -15, 17, 8, 15, 'ceiling');

// Mezzanine along the north wall, with gaps in the rail to drop or fire through.
box(-16, 2.6, -14, 16, 3, -9, 'platform');
box(-13.5, 3, -9.15, -5, 3.9, -9, 'rail');
box(-2.5, 3, -9.15, 2.5, 3.9, -9, 'rail');
box(5, 3, -9.15, 13.5, 3.9, -9, 'rail');
box(-5.3, 0, -9.6, -4.7, 2.6, -9, 'pillar');
box(4.7, 0, -9.6, 5.3, 2.6, -9, 'pillar');

// West ramp and east stairs: two routes up.
solids.push({ min: vec3(-16, 0, -9), max: vec3(-13.5, 3, 1), ramp: { axis: 'z', dir: -1 }, tag: 'platform' });
const STEPS = 12;
const TREAD = (9 - 3.2) / STEPS;
for (let i = 0; i < STEPS; i++) {
  const front = -3.2 - i * TREAD;
  box(13.5, 0, front - TREAD, 16, (3 / STEPS) * (i + 1), front, 'platform');
}

// Hall cover.
box(-2.5, 0, -2, 2.5, 3.2, 2, 'kiosk');
for (const px of [-8, 8]) for (const pz of [0, 8]) box(px - 0.45, 0, pz - 0.45, px + 0.45, 7, pz + 0.45, 'pillar');
box(-6.5, 0, 5.4, -3.5, 1.1, 6, 'cover');
box(3.5, 0, 5.4, 6.5, 1.1, 6, 'cover');
box(-11.5, 0, -4, -10.9, 1.1, -1, 'cover');
box(10.4, 0, 2, 11, 1.1, 5, 'cover');
box(-1.5, 0, -7, 1.5, 1.1, -6.4, 'cover');
box(-13, 0, 10.2, -10, 0.45, 11, 'bench');
box(10, 0, 10.2, 13, 0.45, 11, 'bench');
box(5.6, 0, -4.6, 6.8, 1.2, -3.4, 'crate');
box(6.8, 0, -4.6, 7.8, 0.45, -3.6, 'crate');
box(-7.4, 0, 11.4, -6.2, 1.2, 12.6, 'crate');
box(-8, 3, -13, -6.8, 4.1, -11.8, 'crate');
box(6.6, 3, -12.6, 7.8, 4.1, -11.4, 'crate');
box(-0.6, 3, -13.6, 0.6, 3.9, -12.6, 'crate');

// Relay room: interior x -6..6, z -27..-15.
box(-7, 0, -28, -6, 4, -15, 'wall');
box(6, 0, -28, 7, 4, -15, 'wall');
box(-6, 0, -28, 6, 4, -27, 'wall');
box(-7, 4, -28, 7, 5, -15, 'ceiling');
box(-1.3, 0, -26.7, 1.3, 1.05, -25.9, 'console');
box(-4.6, 0, -22, -3.6, 2.2, -19.5, 'rack');
box(3.6, 0, -22, 4.6, 2.2, -19.5, 'rack');

const WARM = 0xffab66;
const CYAN = 0x4fd8ff;

export const GRAYBOX: LevelDef = {
  id: 'graybox-concourse',
  name: 'Dead Signal',
  subtitle: 'Concourse graybox',
  solids,
  bounds: { minX: -18, maxX: 18, minZ: -28, maxZ: 27 },
  killY: -12,
  spawn: { pos: vec3(0, 0, 24.5), yaw: 0 },
  enemies: [
    { kind: 'security', pos: vec3(-10, 0, 7), patrol: [vec3(-10, 0, 7), vec3(-10, 0, -6), vec3(-5, 0, -5), vec3(-5, 0, 9)] },
    { kind: 'security', pos: vec3(10, 0, -6), patrol: [vec3(10, 0, -6), vec3(10, 0, 8), vec3(4.5, 0, 8.5), vec3(4.5, 0, -4)] },
    { kind: 'security', pos: vec3(-9, 3, -11.3), patrol: [vec3(-11, 3, -11.3), vec3(11, 3, -11.3)] },
    { kind: 'security', pos: vec3(0, 0, -11), yaw: Math.PI, patrol: [vec3(0, 0, -11)] },
    { kind: 'security', pos: vec3(-3, 0, -17.5), patrol: [vec3(-3, 0, -17.5), vec3(3, 0, -17.5)] },
  ],
  triggers: [
    { id: 'h_move', min: vec3(-3, 0, 22.8), max: vec3(3, 3, 26) },
    { id: 'h_crouch', min: vec3(-3, 0, 21.3), max: vec3(3, 3, 22.8) },
    { id: 'h_jump', min: vec3(-3, 0, 18.1), max: vec3(3, 3, 20.5) },
    { id: 'h_fire', min: vec3(-3, 0, 15), max: vec3(3, 3, 17.3) },
    { id: 't_concourse', min: vec3(-3, 0, 12), max: vec3(3, 3, 14.6) },
  ],
  interactables: [
    { id: 'relay', pos: vec3(0, 1.1, -25.7), radius: 2.4, holdTicks: 90, prompt: 'Hold {interact} to restore the relay' },
  ],
  pickups: [
    { id: 'med_sw', kind: 'health', pos: vec3(-14.5, 0, 12.5), amount: 40 },
    { id: 'med_se', kind: 'health', pos: vec3(14.5, 0, 12.5), amount: 40 },
    { id: 'med_mezz', kind: 'health', pos: vec3(2.4, 3, -12.4), amount: 40 },
  ],
  objectives: [
    { id: 'enter', kind: 'reach', trigger: 't_concourse', text: 'Reach the concourse' },
    { id: 'clear', kind: 'eliminate', text: 'Clear the security detail' },
    { id: 'relay', kind: 'interact', target: 'relay', text: 'Restore the signal relay' },
  ],
  hints: [
    { trigger: 'h_move', text: '{forward}{left}{back}{right} move · mouse looks' },
    { trigger: 'h_crouch', text: 'Hold {crouch} to duck under the beam' },
    { trigger: 'h_jump', text: '{jump} to vault the barricade' },
    { trigger: 'h_fire', text: '{fire} fire · {reload} reload · {sprint} sprint' },
  ],
  radio: [
    {
      on: 'start',
      lines: [
        { speaker: 'Kestrel', text: 'Mara. Station power is gone and the security net is not answering me. Go carefully.' },
        { speaker: 'Mara', text: "I'm not here for the station. I'm here for Ilan." },
      ],
    },
    {
      on: 'objective:enter:done',
      lines: [
        {
          speaker: 'Kestrel',
          text: 'Security units on the concourse. Their evacuation orders contradict each other. They will treat you as the error.',
        },
      ],
    },
    {
      on: 'objective:clear:done',
      lines: [{ speaker: 'Kestrel', text: 'The concourse is quiet. The relay room is north, under the mezzanine.' }],
    },
    {
      on: 'complete',
      lines: [
        { speaker: 'Ilan (recording)', text: "If anyone is receiving this: the blackout isn't an attack. Don't let them turn it back on." },
        { speaker: 'Mara', text: 'Ilan.' },
      ],
    },
  ],
  lights: [
    { pos: vec3(0, 3.1, 23.5), color: WARM, intensity: 26, distance: 12 },
    { pos: vec3(0, 3.1, 16.4), color: WARM, intensity: 26, distance: 12 },
    { pos: vec3(-11, 5.6, 9), color: WARM, intensity: 80, distance: 22 },
    { pos: vec3(11, 5.6, 9), color: WARM, intensity: 80, distance: 22 },
    { pos: vec3(-11, 5.6, -4), color: WARM, intensity: 70, distance: 22 },
    { pos: vec3(11, 5.6, -4), color: WARM, intensity: 70, distance: 22 },
    { pos: vec3(0, 2.2, -12), color: CYAN, intensity: 22, distance: 14 },
    { pos: vec3(0, 3.2, -24), color: CYAN, intensity: 40, distance: 16 },
  ],
  spot: { pos: vec3(0, 6.9, 4), target: vec3(0, 0, 0), color: 0xa9c8ff, intensity: 420, angle: 0.75 },
  accents: [
    { min: vec3(-2, 2.62, -14.03), max: vec3(2, 2.78, -13.97), color: CYAN, intensity: 2.4 },
    { min: vec3(-2.53, 2.7, -2.03), max: vec3(2.53, 2.86, 2.03), color: CYAN, intensity: 1.6 },
    { min: vec3(-1.1, 1.05, -26.62), max: vec3(1.1, 1.6, -26.56), color: CYAN, intensity: 2.6 },
    { min: vec3(-3.02, 1.3, 20.58), max: vec3(3.02, 1.38, 21.22), color: WARM, intensity: 1.2 },
  ],
  // The cool fill keeps the architecture blue-grey; the warm lamps only pool around their fixtures.
  ambient: { fog: 0x0a1018, fogDensity: 0.02, sky: 0x8fa9cc, ground: 0x2a2620, hemi: 1.9 },
};
