'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('three');
const Avatar = require('../client/avatar.js');

const STEP = 1 / 60;

function settle(av, state, seconds = 1.5) {
  for (let t = 0; t < seconds; t += STEP) av.update(STEP, state);
  av.root.updateMatrixWorld(true);
}

function world(obj, local = [0, 0, 0]) {
  obj.updateWorldMatrix(true, false);
  return obj.localToWorld(new T.Vector3(...local));
}

// Distance from each gloved fist to its rifle grip.
function gripError(av) {
  const B = av.bones;
  const fistR = world(B.foreR, [0, -Avatar.dims.fore, 0]);
  const fistL = world(B.foreL, [0, -Avatar.dims.fore, 0]);
  return Math.max(fistR.distanceTo(world(B.rifle, Avatar.grips.right)), fistL.distanceTo(world(B.rifle, Avatar.grips.left)));
}

function bounds(av) {
  av.root.updateMatrixWorld(true);
  return new T.Box3().setFromObject(av.root);
}

test('builds a compact, finite, vertex-coloured mesh set', () => {
  const av = Avatar.create(T, { seed: 'abc', team: 0x4fc3f7 });
  const meshes = [];
  av.root.traverse((o) => o.isMesh && meshes.push(o));
  assert.ok(meshes.length <= 30, `draw calls per avatar: ${meshes.length}`);
  let verts = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position.array;
    verts += pos.length / 3;
    assert.ok(pos.every(Number.isFinite), `non-finite vertex in ${m.parent.name}`);
  }
  assert.ok(verts > 5000 && verts < 30000, `vertex count ${verts}`);
  av.dispose();
});

test('standing proportions match the 1.80 m first-person player', () => {
  const av = Avatar.create(T, { seed: 'p' });
  settle(av, {});
  const b = bounds(av);
  assert.ok(b.max.y > 1.78 && b.max.y < 1.88, `helmet top at ${b.max.y.toFixed(3)}`);
  assert.ok(Math.abs(b.min.y) < 0.01, `boot soles at ${b.min.y.toFixed(3)}`);
  const eyes = world(av.bones.head, [0, 0.1, -0.09]);
  assert.ok(Math.abs(eyes.y - 1.68) < 0.05, `eye height ${eyes.y.toFixed(3)}`);
  const shoulders = world(av.bones.upperR).distanceTo(world(av.bones.upperL));
  assert.ok(shoulders > 0.36 && shoulders < 0.44, `shoulder joint span ${shoulders.toFixed(3)}`);
  av.dispose();
});

test('hands stay on the rifle grips across carries, pitch and gait', () => {
  const av = Avatar.create(T, { seed: 'grip' });
  const states = [
    {}, { ads: 1 }, { ads: 1, pitch: 0.9 }, { ads: 1, pitch: -0.9 }, { pitch: 1.1 },
    { crouch: true }, { crouch: true, ads: 1 }, { sprint: true, vz: -6.4 }, { vx: 3.8 }, { vz: 2 }, { alive: false },
  ];
  for (const s of states) {
    settle(av, s);
    for (let i = 0; i < 40; i++) {
      av.update(STEP, s);
      assert.ok(gripError(av) < 0.015, `hands off grips (${(gripError(av) * 100).toFixed(1)} cm) in ${JSON.stringify(s)}`);
    }
  }
  av.dispose();
});

test('aiming points the muzzle along the view and fire() triggers recoil and flash', () => {
  const av = Avatar.create(T, { seed: 'aim' });
  settle(av, { ads: 1, pitch: 0.4 });
  const butt = world(av.bones.rifle), muzzle = av.muzzleWorld(new T.Vector3());
  const dir = muzzle.clone().sub(butt).normalize();
  assert.ok(muzzle.z < -0.6, 'muzzle in front of the body');
  assert.ok(Math.abs(Math.asin(dir.y) - 0.4) < 0.08, `muzzle pitch ${Math.asin(dir.y).toFixed(3)} for view pitch 0.4`);
  av.fire();
  assert.equal(av.state.aim, 1, 'firing snaps the rifle to the shoulder');
  assert.ok(gripError(av) < 0.015, 'hands stay on grips after the snap');
  av.update(STEP, {});
  assert.ok(av.state.recoil > 0.5 && av.state.aimHold > 1);
  const flash = av.bones.rifle.children.find((o) => o.renderOrder === 11);
  assert.ok(flash.visible);
  av.dispose();
});

test('feet plant on the ground when still and never sink while running', () => {
  const av = Avatar.create(T, { seed: 'feet' });
  settle(av, {});
  for (const sd of ['L', 'R']) assert.ok(Math.abs(world(av.bones['foot' + sd]).y - Avatar.dims.ankle) < 0.01, `${sd} ankle planted`);
  let lifted = 0;
  for (let i = 0; i < 240; i++) {
    av.update(STEP, { vz: -3.8 });
    for (const sd of ['L', 'R']) {
      const y = world(av.bones['foot' + sd]).y;
      assert.ok(y > Avatar.dims.ankle - 0.012, `ankle below ground: ${y.toFixed(3)}`);
      lifted = Math.max(lifted, y - Avatar.dims.ankle);
    }
  }
  assert.ok(lifted > 0.08, `feet lift while running (${lifted.toFixed(3)} m)`);
  av.dispose();
});

test('crouching and going down lower the body', () => {
  const av = Avatar.create(T, { seed: 'pose' });
  settle(av, {});
  const stand = world(av.bones.head).y;
  settle(av, { crouch: true });
  const crouch = world(av.bones.head).y;
  assert.ok(stand - crouch > 0.35, `crouch drops the head ${(stand - crouch).toFixed(3)} m`);
  settle(av, { alive: false }, 3);
  assert.ok(world(av.bones.head).y < 0.45, 'downed operator lies on the ground');
  assert.ok(bounds(av).min.y > -0.08, 'downed body does not sink into the floor');
  av.dispose();
});

test('appearance is stable per player and varies across players', () => {
  assert.deepEqual(Avatar.lookFor('abc', 1), Avatar.lookFor('abc', 1));
  const skins = new Set(Array.from({ length: 40 }, (_, i) => Avatar.lookFor('player' + i).skin));
  assert.ok(skins.size >= 4, `skin tones used: ${skins.size}`);
});
