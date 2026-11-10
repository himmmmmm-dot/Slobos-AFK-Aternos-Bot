/* Saltline teammate model: a Port Authority breacher built from primitives at
   runtime, like everything else in the game (nothing is downloaded).
   Proportions follow a ~1.83 m athletic adult (about 7.7 heads tall, shoulders
   roughly 2.5 head-widths). Arms are solved with two-bone IK onto the rifle,
   legs with two-bone IK onto a procedural gait, so hands stay on the grips and
   feet stay planted at any speed, crouch or look pitch.
   Browser: window.SaltlineAvatar. Node (tests): module.exports. */
(function (scope) {
  'use strict';

  const SKIN = [0xf0cba8, 0xe2b48e, 0xc68c62, 0x9e6643, 0x734a2e, 0x4e3020];
  const HAIR = [0x16110d, 0x2b1d14, 0x47311f, 0x6a4a2c, 0x0d0c0b];
  const PAL = {
    shirt: 0x2b3137, pants: 0x373c37, pocket: 0x31362f, gear: 0x363b30, gearHi: 0x40473a,
    strap: 0x2a2e27, black: 0x17191b, sole: 0x2b2521, helmet: 0x3e4348, liner: 0x0f1011,
    polymer: 0x1a1c1e, metal: 0x2a2e32, rust: 0x9a4a22, sclera: 0xb9b1a5, iris: 0x1d1611,
    reflect: 0x8f8c84, lens: 0xc98a32,
  };

  // Joint offsets in metres, each relative to its parent bone.
  const D = {
    hipY: 0.95, hipX: 0.095, hipDrop: 0.03, thigh: 0.44, shin: 0.43, ankle: 0.085,
    spine: 0.1, chest: 0.18, neck: 0.3, head: 0.075,
    shX: 0.195, shY: 0.245, upper: 0.32, fore: 0.31, foreVis: 0.26,
  };

  // Rifle space: origin at the butt pad, barrel down -Z.
  const GRIP_R = [0, -0.065, -0.252];
  const GRIP_L = [-0.004, -0.018, -0.48];
  const MUZZLE = [0, 0.05, -0.94];
  // Butt pad placement in chest space for each carry.
  const BUTT = { aim: [0.125, 0.228, -0.15], ready: [0.13, 0.2, -0.17], sprint: [0.02, 0.15, -0.2], down: [0.06, 0.2, -0.21] };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  // Stable per-player appearance: every client derives the same look from the player id.
  function lookFor(seed, team) {
    const h = hash(String(seed || 'breacher'));
    return { skin: SKIN[h % SKIN.length], hair: HAIR[(h >>> 8) % HAIR.length], beard: ((h >>> 16) & 3) === 0, team: team ?? 0xffb347 };
  }

  // ------------------------------------------------------------ geometry kit

  function kit(T) {
    if (kit.T === T) return kit.K;
    const mats = {
      matte: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 }),
      gloss: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.55 }),
      glow: new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      flash: new T.MeshBasicMaterial({ color: 0xffc977, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }),
    };
    for (const m of Object.values(mats)) m.name = 'saltline-avatar-' + m.type;
    const flashA = new T.PlaneGeometry(0.07, 0.22).rotateX(-Math.PI / 2).translate(0, 0, -0.1);
    const flash = mergeRaw(T, [flashA, flashA.clone().rotateZ(Math.PI / 2)]);
    kit.T = T;
    // Sphere detail scales with the part: silhouettes get more segments than eyes and brows.
    kit.K = { mats, flash, spheres: [new T.SphereGeometry(1, 8, 6), new T.SphereGeometry(1, 12, 8), new T.SphereGeometry(1, 16, 12)] };
    return kit.K;
  }

  function mergeRaw(T, geos) {
    const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
    const pos = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.count * 3; }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.computeVertexNormals();
    return out;
  }

  // Bakes a list of {g, m, c, flip} parts into one indexed, vertex-coloured geometry.
  function merge(T, list) {
    const items = list.map(({ g, m, c, flip }) => {
      const n = g.clone().applyMatrix4(m);
      return { n, c, flip, cnt: n.attributes.position.count };
    });
    let total = 0, totalIdx = 0;
    for (const x of items) { total += x.cnt; totalIdx += x.n.index ? x.n.index.count : x.cnt; }
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    const idx = new (total > 65535 ? Uint32Array : Uint16Array)(totalIdx);
    let o = 0, oi = 0;
    for (const x of items) {
      const q = x.n.attributes.normal.array;
      pos.set(x.n.attributes.position.array, o * 3);
      // Inside-out copies (helmet liner) get inverted normals and reversed winding.
      if (x.flip) for (let i = 0; i < q.length; i++) nor[o * 3 + i] = -q[i];
      else nor.set(q, o * 3);
      for (let v = 0; v < x.cnt; v++) { col[(o + v) * 3] = x.c.r; col[(o + v) * 3 + 1] = x.c.g; col[(o + v) * 3 + 2] = x.c.b; }
      const src = x.n.index && x.n.index.array;
      const count = src ? src.length : x.cnt;
      for (let i = 0; i < count; i += 3) {
        const a = src ? src[i] : i, b = src ? src[i + 1] : i + 1, cc = src ? src[i + 2] : i + 2;
        idx[oi++] = o + a;
        idx[oi++] = o + (x.flip ? cc : b);
        idx[oi++] = o + (x.flip ? b : cc);
      }
      o += x.cnt;
      x.n.dispose();
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nor, 3));
    out.setAttribute('color', new T.BufferAttribute(col, 3));
    out.setIndex(new T.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  function shapes(T) {
    const e = new T.Euler(), q = new T.Quaternion(), p = new T.Vector3(), s = new T.Vector3(), up = new T.Vector3(0, 1, 0);
    const X = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
      new T.Matrix4().compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz));

    // Smooth surface of revolution through [y, radius] keys listed bottom to top.
    function lathe(keys, sx = 1, sz = 1, seg = 18, density = 3) {
      const curve = new T.SplineCurve(keys.map(([y, r]) => new T.Vector2(r, y)));
      const pts = curve.getPoints(Math.round(keys.length * density)).map((v) => new T.Vector2(Math.max(0, v.x), v.y));
      return new T.LatheGeometry(pts, seg).scale(sx, 1, sz);
    }
    // Rounded limb hanging down -Y from its joint; keys are [t (0 joint .. 1 end), radius].
    function limb(len, keys, sx = 1, sz = 1) {
      const r0 = keys[0][1], r1 = keys[keys.length - 1][1];
      const pts = [[-len - r1 * 0.8, 0], [-len - r1 * 0.45, r1 * 0.8]];
      for (let i = keys.length - 1; i >= 0; i--) pts.push([-keys[i][0] * len, keys[i][1]]);
      pts.push([r0 * 0.45, r0 * 0.8], [r0 * 0.8, 0]);
      return lathe(pts, sx, sz, 12, 2.4);
    }
    function rbox(w, h, d, r) {
      r = Math.min(r ?? Math.min(w, h, d) * 0.3, w * 0.45, h * 0.45, d * 0.45);
      const iw = w - 2 * r, ih = h - 2 * r, c = Math.max(1e-4, Math.min(iw, ih) * 0.25);
      const x = -iw / 2, y = -ih / 2, sh = new T.Shape();
      sh.moveTo(x + c, y); sh.lineTo(x + iw - c, y); sh.quadraticCurveTo(x + iw, y, x + iw, y + c);
      sh.lineTo(x + iw, y + ih - c); sh.quadraticCurveTo(x + iw, y + ih, x + iw - c, y + ih);
      sh.lineTo(x + c, y + ih); sh.quadraticCurveTo(x, y + ih, x, y + ih - c);
      sh.lineTo(x, y + c); sh.quadraticCurveTo(x, y, x + c, y);
      const depth = Math.max(1e-4, d - 2 * r);
      const fine = Math.max(w, h, d) > 0.15 ? 2 : 1;
      return new T.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: fine, curveSegments: fine }).translate(0, 0, -depth / 2);
    }
    const cyl = (rt, rb, h, seg = 14, open = false) => new T.CylinderGeometry(rt, rb, h, seg, 1, open);
    // Cylinder between two points.
    function tube(a, b, r0, r1 = r0, seg = 10) {
      const A = new T.Vector3(...a), B = new T.Vector3(...b), dir = B.clone().sub(A), len = dir.length();
      const m = new T.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new T.Quaternion().setFromUnitVectors(up, dir.normalize()), new T.Vector3(1, 1, 1));
      return { g: cyl(r1, r0, len, seg), m };
    }
    return { X, lathe, limb, rbox, cyl, tube };
  }

  // ------------------------------------------------------------ model

  function buildParts(T, look) {
    const K = kit(T), G = shapes(T);
    const c = {};
    for (const k in PAL) c[k] = new T.Color(PAL[k]);
    const skin = new T.Color(look.skin), hair = new T.Color(look.hair), team = new T.Color(look.team);
    const lips = skin.clone().multiplyScalar(0.7), teamDim = team.clone().multiplyScalar(0.72);
    const I = new T.Matrix4();
    const P = {};
    const owned = [];
    const put = (bone, mat, color, g, m = I, flip = false) => {
      if (!K.spheres.includes(g)) owned.push(g);
      ((P[bone] = P[bone] || {})[mat] = P[bone][mat] || []).push({ g, m, c: color, flip });
    };
    const box = (bone, mat, color, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, r) => put(bone, mat, color, G.rbox(w, h, d, r), G.X(x, y, z, rx, ry, rz));
    const ell = (bone, mat, color, ax, ay, az, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const size = Math.max(ax, ay, az);
      put(bone, mat, color, K.spheres[size > 0.06 ? 2 : size > 0.03 ? 1 : 0], G.X(x, y, z, rx, ry, rz, ax, ay, az));
    };
    const tube = (bone, mat, color, a, b, r0, r1) => { const t = G.tube(a, b, r0, r1); put(bone, mat, color, t.g, t.m); };

    // Pelvis, glutes and battle belt.
    put('hips', 'matte', c.pants, G.lathe([[-0.17, 0], [-0.14, 0.085], [-0.08, 0.15], [0, 0.168], [0.07, 0.16], [0.13, 0.15], [0.16, 0]], 1, 0.68));
    put('hips', 'matte', c.gear, G.cyl(1, 1, 0.055, 22, true), G.X(0, 0.085, 0, 0, 0, 0, 0.177, 1, 0.126));
    box('hips', 'matte', c.black, 0.06, 0.04, 0.014, 0, 0.085, -0.13);
    box('hips', 'matte', c.gearHi, 0.12, 0.075, 0.05, 0, 0.075, 0.138);

    for (const s of [-1, 1]) {
      const sd = s < 0 ? 'L' : 'R';
      ell('hips', 'matte', c.pants, 0.085, 0.1, 0.066, s * 0.062, -0.04, 0.06);
      box('hips', 'matte', c.gearHi, 0.05, 0.085, 0.075, s * 0.166, 0.07, 0.02);

      // Legs: quads taper into the knee, calves bulge behind the shin.
      const th = 'thigh' + sd, sh = 'shin' + sd, ft = 'foot' + sd;
      put(th, 'matte', c.pants, G.limb(D.thigh, [[0, 0.088], [0.2, 0.084], [0.55, 0.071], [0.85, 0.056], [1, 0.053]]));
      box(th, 'matte', c.pocket, 0.03, 0.13, 0.09, s * 0.074, -0.25, 0);
      if (s > 0) {
        box(th, 'matte', c.black, 0.045, 0.17, 0.1, 0.083, -0.15, 0.01);
        box(th, 'matte', c.polymer, 0.03, 0.07, 0.035, 0.09, -0.045, 0.035, -0.3);
      } else box(th, 'matte', c.gear, 0.06, 0.12, 0.1, -0.082, -0.11, 0.01);

      put(sh, 'matte', c.pants, G.limb(D.shin, [[0, 0.054], [0.14, 0.06], [0.32, 0.061], [0.62, 0.046], [0.9, 0.037], [1, 0.037]]));
      ell(sh, 'matte', c.pants, 0.048, 0.085, 0.045, 0, -0.13, 0.024);
      box(sh, 'matte', c.black, 0.09, 0.115, 0.05, 0, -0.025, -0.05, 0.12);

      put(ft, 'matte', c.black, G.cyl(0.047, 0.053, 0.15), G.X(0, 0.025, 0.003));
      box(ft, 'matte', c.black, 0.1, 0.075, 0.25, 0, -0.045, -0.055);
      ell(ft, 'matte', c.black, 0.052, 0.038, 0.06, 0, -0.05, -0.165);
      box(ft, 'matte', c.sole, 0.108, 0.022, 0.29, 0, -0.077, -0.06, 0, 0, 0, 0.008);

      // Arms: deltoid cap, biceps, forearm taper, gloved fist.
      const up = 'upper' + sd, fo = 'fore' + sd;
      put(up, 'matte', c.shirt, G.limb(D.upper, [[0, 0.06], [0.22, 0.057], [0.45, 0.053], [0.8, 0.043], [1, 0.04]]));
      ell(up, 'matte', c.shirt, 0.07, 0.085, 0.072, s * 0.012, -0.035, 0);
      ell(up, 'matte', c.shirt, 0.044, 0.07, 0.044, 0, -0.15, -0.016);
      // Team ID armband, readable from any side.
      put(up, 'glow', teamDim, G.cyl(0.062, 0.06, 0.035, 14, true), G.X(0, -0.11, -0.004));

      put(fo, 'matte', c.shirt, G.limb(D.foreVis, [[0, 0.043], [0.2, 0.047], [0.5, 0.04], [0.85, 0.032], [1, 0.031]]));
      put(fo, 'matte', c.black, G.cyl(0.034, 0.036, 0.045, 12), G.X(0, -0.255, 0));
      box(fo, 'matte', c.black, 0.07, 0.1, 0.052, 0, -0.31, -0.004, 0, 0, 0, 0.018);
      ell(fo, 'matte', c.black, 0.017, 0.036, 0.017, -s * 0.036, -0.29, -0.018, 0, 0, s * 0.4);

      // Eyes, cheekbones and brows.
      ell('head', 'matte', c.sclera, 0.011, 0.0062, 0.006, s * 0.031, 0.1, -0.0865);
      ell('head', 'matte', c.iris, 0.0058, 0.0058, 0.003, s * 0.031, 0.1, -0.0912);
      ell('head', 'matte', skin, 0.022, 0.014, 0.018, s * 0.042, 0.083, -0.068);
      box('head', 'matte', hair, 0.03, 0.007, 0.008, s * 0.032, 0.122, -0.1, 0, 0, -s * 0.1, 0.003);
      // Headset cups and helmet rails.
      put('head', 'matte', c.black, G.cyl(0.04, 0.04, 0.035, 16), G.X(s * 0.088, 0.09, 0.008, 0, 0, Math.PI / 2));
      box('head', 'matte', c.black, 0.012, 0.028, 0.12, s * 0.1, 0.14, 0, 0, 0, s * 0.27, 0.004);
      // Plate-carrier shoulder straps.
      box('chest', 'matte', c.strap, 0.07, 0.035, 0.27, s * 0.1, 0.285, 0, 0, 0, -s * 0.32);
      // Bolt-cutter handles strapped to the pack: the breacher silhouette.
      tube('chest', 'gloss', c.metal, [s * 0.05, -0.08, 0.29], [s * 0.015, 0.43, 0.29], 0.01);
      tube('chest', 'matte', c.rust, [s * 0.05, -0.09, 0.29], [s * 0.043, 0.07, 0.29], 0.016);
    }

    // Abdomen and V-tapered torso (chest wider than waist, flattened front to back).
    put('spine', 'matte', c.shirt, G.lathe([[-0.07, 0], [-0.05, 0.15], [0.05, 0.142], [0.14, 0.152], [0.21, 0.16], [0.24, 0]], 1, 0.66));
    put('chest', 'matte', c.shirt, G.lathe([[-0.08, 0], [-0.06, 0.152], [0.03, 0.166], [0.12, 0.184], [0.2, 0.19], [0.255, 0.168], [0.3, 0.105], [0.33, 0]], 1, 0.6));
    ell('chest', 'matte', c.shirt, 0.15, 0.055, 0.075, 0, 0.258, 0.012);
    // Plate carrier: plates, cummerbund, magazine and admin pouches.
    box('chest', 'matte', c.gear, 0.29, 0.32, 0.05, 0, 0.115, -0.138, -0.05);
    box('chest', 'matte', c.gear, 0.29, 0.32, 0.05, 0, 0.115, 0.135, 0.05);
    put('chest', 'matte', c.gear, G.cyl(1, 1, 0.13, 22, true), G.X(0, 0, 0, 0, 0, 0, 0.172, 1, 0.118));
    for (const x of [-0.078, 0, 0.078]) {
      box('chest', 'matte', c.gearHi, 0.07, 0.105, 0.045, x, 0.03, -0.185);
      box('chest', 'matte', c.strap, 0.072, 0.025, 0.05, x, 0.085, -0.187);
    }
    box('chest', 'matte', c.gearHi, 0.2, 0.07, 0.03, 0, 0.165, -0.177);
    box('chest', 'glow', team, 0.1, 0.045, 0.008, 0, 0.165, -0.196, 0, 0, 0, 0.003);
    // Radio and antenna.
    box('chest', 'matte', c.black, 0.045, 0.12, 0.05, -0.175, 0.06, 0.06);
    tube('chest', 'matte', c.black, [-0.18, 0.12, 0.07], [-0.19, 0.4, 0.09], 0.005);
    // Assault pack with a reflective port-authority band, IR strobe and cutter jaws.
    box('chest', 'matte', c.gear, 0.26, 0.3, 0.11, 0, 0.11, 0.215);
    box('chest', 'matte', c.gearHi, 0.2, 0.12, 0.035, 0, 0.05, 0.28);
    box('chest', 'glow', c.reflect, 0.24, 0.026, 0.006, 0, 0.2, 0.2715, 0, 0, 0, 0.002);
    box('chest', 'glow', team, 0.03, 0.022, 0.03, 0.08, 0.27, 0.22);
    box('chest', 'gloss', c.metal, 0.05, 0.09, 0.025, 0, 0.47, 0.29);

    // Neck and collar.
    put('neck', 'matte', skin, G.cyl(0.058, 0.066, 0.15), G.X(0, 0.035, 0.008));
    put('neck', 'matte', c.shirt, G.cyl(0.068, 0.072, 0.035, 14, true), G.X(0, -0.025, 0.008));

    // Head: cranium, jaw, brow ridge, nose, lips, hair; then the high-cut helmet.
    ell('head', 'matte', skin, 0.083, 0.106, 0.098, 0, 0.1, 0.006);
    ell('head', 'matte', skin, 0.067, 0.058, 0.074, 0, 0.036, -0.03);
    ell('head', 'matte', skin, 0.07, 0.016, 0.024, 0, 0.125, -0.08);
    ell('head', 'matte', skin, 0.012, 0.026, 0.016, 0, 0.079, -0.098, 0.22);
    ell('head', 'matte', hair, 0.086, 0.075, 0.09, 0, 0.098, 0.018);
    if (look.beard) ell('head', 'matte', hair, 0.07, 0.05, 0.077, 0, 0.026, -0.032);
    box('head', 'matte', lips, 0.034, 0.007, 0.006, 0, 0.042, look.beard ? -0.107 : -0.104, 0, 0, 0, 0.002);
    const shell = new T.SphereGeometry(1, 20, 9, 0, Math.PI * 2, 0, 1.22);
    put('head', 'matte', c.helmet, shell, G.X(0, 0.108, 0.006, 0, 0, 0, 0.104, 0.118, 0.12));
    put('head', 'matte', c.liner, shell.clone(), G.X(0, 0.108, 0.006, 0, 0, 0, 0.099, 0.113, 0.115), true);
    box('head', 'matte', c.black, 0.05, 0.035, 0.022, 0, 0.19, -0.088, -0.55);
    box('head', 'matte', c.gear, 0.07, 0.05, 0.03, 0, 0.14, 0.123);
    box('head', 'glow', team, 0.035, 0.006, 0.035, 0, 0.225, 0.03, 0, 0, 0, 0.002);
    box('head', 'glow', team, 0.025, 0.03, 0.014, 0, 0.17, 0.112, 0.5, 0, 0, 0.004);
    // Goggles parked on the helmet brim, with the game's amber lens.
    put('head', 'matte', c.black, G.cyl(1, 1, 0.018, 24, true), G.X(0, 0.17, 0.006, 0, 0, 0, 0.091, 1, 0.105));
    box('head', 'matte', c.black, 0.15, 0.042, 0.03, 0, 0.168, -0.106, -0.45);
    box('head', 'glow', c.lens, 0.125, 0.03, 0.006, 0, 0.169, -0.122, -0.45, 0, 0, 0.002);
    // Boom mic.
    tube('head', 'matte', c.black, [-0.1, 0.075, -0.01], [-0.045, 0.04, -0.1], 0.004);
    ell('head', 'matte', c.black, 0.009, 0.009, 0.009, -0.042, 0.04, -0.103);

    // Carbine.
    box('rifle', 'matte', c.polymer, 0.042, 0.078, 0.17, 0, -0.004, -0.085, 0, 0, 0, 0.01);
    tube('rifle', 'gloss', c.metal, [0, 0.022, -0.15], [0, 0.022, -0.25], 0.016);
    box('rifle', 'gloss', c.metal, 0.036, 0.062, 0.15, 0, 0.004, -0.315, 0, 0, 0, 0.006);
    box('rifle', 'gloss', c.metal, 0.042, 0.046, 0.21, 0, 0.055, -0.335, 0, 0, 0, 0.006);
    box('rifle', 'matte', c.polymer, 0.026, 0.155, 0.068, 0, -0.088, -0.36, 0.2, 0, 0, 0.008);
    box('rifle', 'matte', c.polymer, 0.03, 0.085, 0.036, 0, -0.058, -0.255, -0.35, 0, 0, 0.008);
    box('rifle', 'gloss', c.metal, 0.05, 0.054, 0.3, 0, 0.05, -0.585, 0, 0, 0, 0.008);
    box('rifle', 'matte', c.polymer, 0.026, 0.075, 0.032, 0, -0.008, -0.48, 0.25, 0, 0, 0.008);
    tube('rifle', 'gloss', c.metal, [0, 0.05, -0.73], [0, 0.05, -0.875], 0.0095);
    tube('rifle', 'gloss', c.metal, [0, 0.05, -0.865], [0, 0.05, -0.92], 0.015);
    box('rifle', 'matte', c.black, 0.034, 0.03, 0.07, 0, 0.09, -0.335);
    tube('rifle', 'gloss', c.metal, [0, 0.118, -0.3], [0, 0.118, -0.38], 0.019);
    tube('rifle', 'matte', c.black, [0.034, 0.05, -0.62], [0.034, 0.05, -0.7], 0.013);

    return { P, owned };
  }

  const BONES = [
    ['body', null, 0, 0, 0], ['hips', 'body', 0, D.hipY, 0],
    ['thighL', 'hips', -D.hipX, -D.hipDrop, 0], ['shinL', 'thighL', 0, -D.thigh, 0], ['footL', 'shinL', 0, -D.shin, 0],
    ['thighR', 'hips', D.hipX, -D.hipDrop, 0], ['shinR', 'thighR', 0, -D.thigh, 0], ['footR', 'shinR', 0, -D.shin, 0],
    ['spine', 'hips', 0, D.spine, 0], ['chest', 'spine', 0, D.chest, 0], ['neck', 'chest', 0, D.neck, 0], ['head', 'neck', 0, D.head, 0],
    ['upperL', 'chest', -D.shX, D.shY, 0], ['foreL', 'upperL', 0, -D.upper, 0],
    ['upperR', 'chest', D.shX, D.shY, 0], ['foreR', 'upperR', 0, -D.upper, 0],
    ['rifle', 'chest', 0, 0, 0],
  ];

  function create(T, opts = {}) {
    const K = kit(T);
    const look = opts.look || lookFor(opts.seed, opts.team);
    const root = new T.Group();
    root.name = opts.name || 'saltline-avatar';
    const B = {};
    for (const [name, parent, x, y, z] of BONES) {
      const o = new T.Group();
      o.name = name;
      o.position.set(x, y, z);
      o.rotation.order = 'YXZ';
      (parent ? B[parent] : root).add(o);
      B[name] = o;
    }

    const { P, owned } = buildParts(T, look);
    const geos = [];
    for (const bone in P) {
      for (const mat in P[bone]) {
        const g = merge(T, P[bone][mat]);
        const mesh = new T.Mesh(g, K.mats[mat]);
        mesh.castShadow = mat !== 'glow';
        mesh.receiveShadow = mat === 'matte';
        B[bone].add(mesh);
        geos.push(g);
      }
    }
    for (const g of owned) g.dispose();

    const flash = new T.Mesh(K.flash, K.mats.flash);
    flash.position.set(...MUZZLE);
    flash.visible = false;
    flash.renderOrder = 11;
    B.rifle.add(flash);

    const V = () => new T.Vector3();
    const tmp = { a: V(), b: V(), c: V(), d: V(), e: V(), f: V(), g: V(), m: new T.Matrix4(), q: new T.Quaternion(), q2: new T.Quaternion(), q3: new T.Quaternion(), qA: new T.Quaternion(), qR: new T.Quaternion(), qS: new T.Quaternion(), eu: new T.Euler(0, 0, 0, 'YXZ') };
    const DOWN = new T.Vector3(0, -1, 0), XAXIS = new T.Vector3(1, 0, 0);
    const gripR = new T.Vector3(...GRIP_R), gripL = new T.Vector3(...GRIP_L), muzzle = new T.Vector3(...MUZZLE);
    const butt = { aim: new T.Vector3(...BUTT.aim), ready: new T.Vector3(...BUTT.ready), sprint: new T.Vector3(...BUTT.sprint), down: new T.Vector3(...BUTT.down) };
    const poleArm = { L: new T.Vector3(-0.35, -0.9, 0.05).normalize(), R: new T.Vector3(0.75, -0.65, 0.1).normalize() };
    const poleLeg = { L: new T.Vector3(-0.12, 0, -1).normalize(), R: new T.Vector3(0.12, 0, -1).normalize() };
    const downFoot = { L: new T.Vector3(-0.13, 0.42, -0.06), R: new T.Vector3(0.17, 0.09, 0.02) };
    const st = { t: 0, phase: 0, speed: 0, mx: 0, mz: -1, aim: 0, sprint: 0, crouch: 0, down: 0, air: 0, recoil: 0, aimHold: 0, flash: 0, pitch: 0 };

    // Two-bone IK in the parent frame of `upper`; bones hang along -Y at rest.
    function ik(upper, lower, target, a, b, pole) {
      const S = upper.position;
      const d = tmp.a.subVectors(target, S);
      const len = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-4);
      d.normalize();
      const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      const perp = tmp.b.copy(pole).addScaledVector(d, -pole.dot(d));
      if (perp.lengthSq() < 1e-8) perp.set(0, 0, -1).addScaledVector(d, d.z);
      perp.normalize();
      const joint = tmp.c.copy(S).addScaledVector(d, a * cosA).addScaledVector(perp, a * sinA);
      const end = tmp.d.copy(S).addScaledVector(d, len);
      upper.quaternion.setFromUnitVectors(DOWN, tmp.e.subVectors(joint, S).normalize());
      const dl = tmp.e.subVectors(end, joint).normalize().applyQuaternion(tmp.q.copy(upper.quaternion).invert());
      lower.quaternion.setFromUnitVectors(DOWN, dl);
    }

    function update(dt, s = {}) {
      st.last = s;
      dt = clamp(dt || 0, 0, 0.1);
      st.t += dt;
      const k = (rate) => 1 - Math.exp(-rate * dt);
      const alive = s.alive !== false;

      // World velocity into the model frame (model faces -Z, yaw is root.rotation.y).
      const yaw = root.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw);
      const vx = s.vx || 0, vz = s.vz || 0;
      const lx = vx * cy - vz * sy, lz = vx * sy + vz * cy;
      const sp = Math.hypot(lx, lz);
      st.speed += (sp - st.speed) * k(8);
      if (sp > 0.2) { st.mx += (lx / sp - st.mx) * k(10); st.mz += (lz / sp - st.mz) * k(10); }
      const ml = Math.hypot(st.mx, st.mz) || 1, mx = st.mx / ml, mz = st.mz / ml;

      st.aimHold = Math.max(0, st.aimHold - dt);
      const aimT = alive && ((s.ads || 0) > 0.3 || st.aimHold > 0) ? 1 : 0;
      st.aim += (aimT - st.aim) * k(9);
      st.sprint += ((alive && s.sprint && st.speed > 2.6 && !aimT ? 1 : 0) - st.sprint) * k(6);
      st.crouch += ((alive && s.crouch ? 1 : 0) - st.crouch) * k(9);
      st.down += ((alive ? 0 : 1) - st.down) * k(alive ? 6 : 3.5);
      st.air += ((alive && s.onGround === false ? 1 : 0) - st.air) * k(10);
      st.recoil = Math.max(0, st.recoil - dt * 9);
      st.flash = Math.max(0, st.flash - dt);
      st.pitch += (clamp(s.pitch || 0, -1.1, 1.1) * (1 - st.down) - st.pitch) * k(14);

      // Gait: each foot sweeps sinusoidally along the travel direction and lifts while swinging forward.
      // Cadence rises with speed like a real jog/sprint (~3-3.8 steps/s); reach matches foot speed to ground speed.
      const amp = clamp((st.speed - 0.15) / 1.2, 0, 1) * (1 - st.air) * (1 - st.down);
      const cadence = Math.PI * (2.2 + 0.25 * st.speed) * (1 - 0.25 * st.crouch);
      const reach = clamp(0.1 + 0.07 * st.speed, 0.12, 0.55) * (1 - 0.3 * st.crouch);
      if (st.speed > 0.05) st.phase = (st.phase + cadence * dt) % (Math.PI * 2);
      const lift = clamp(0.07 + 0.035 * st.speed, 0.07, 0.3) * (1 - 0.4 * st.crouch);
      const ph = st.phase;

      // Downed: on the back, propped by the pack so heels and pack both touch the ground.
      B.body.rotation.set(st.down * 1.393, 0, 0);
      B.body.position.set(0, 0.06 * st.down, 0);

      const bob = 0.035 * amp * (Math.abs(Math.cos(ph)) - 0.5);
      const sway = 0.12 * amp * Math.sin(ph);
      B.hips.position.set(0, D.hipY - 0.47 * st.crouch - 0.04 * st.sprint * amp + bob, 0.05 * st.crouch);
      B.hips.rotation.set(0, sway, 0);

      // Right-handed shooters blade the torso; spine and chest share the twist, head and rifle cancel it.
      const blade = (0.22 + 0.2 * st.aim) * (1 - st.sprint) * (1 - st.down);
      const lean = -0.33 * st.crouch - 0.18 * st.sprint * amp - 0.05 * amp;
      const breath = 0.012 * Math.sin(st.t * 1.7);
      B.spine.rotation.set(lean * 0.5 + st.pitch * 0.15, -blade * 0.5 - sway, 0);
      B.chest.rotation.set(lean * 0.5 + st.pitch * 0.25 + breath + st.recoil * 0.03, -blade * 0.5, 0);

      const chain = tmp.q2.copy(B.hips.quaternion).multiply(B.spine.quaternion).multiply(B.chest.quaternion);
      const chainInv = tmp.q3.copy(chain).invert();

      // Rifle: aimed down the view, low ready, sprint carry across the body, or clutched lengthwise when down.
      tmp.qA.setFromEuler(tmp.eu.set(st.pitch, 0, 0, 'YXZ'));
      tmp.qR.setFromEuler(tmp.eu.set(clamp(st.pitch * 0.5, -0.5, 0.4) - 0.62, 0.2, 0.08, 'YXZ'));
      tmp.qS.setFromEuler(tmp.eu.set(-0.72, 0.5, 0.42, 'YXZ'));
      tmp.qR.slerp(tmp.qA, st.aim).slerp(tmp.qS, st.sprint);
      tmp.qR.slerp(tmp.qS.setFromEuler(tmp.eu.set(-1.42, 0.25, 1.3, 'YXZ')), st.down);
      B.rifle.quaternion.copy(chainInv).multiply(tmp.qR).multiply(tmp.q.setFromAxisAngle(XAXIS, st.recoil * 0.08));
      const bp = B.rifle.position.copy(butt.ready).lerp(butt.aim, st.aim).lerp(butt.sprint, st.sprint).lerp(butt.down, st.down);
      bp.z += 0.03 * st.recoil;
      B.rifle.updateMatrix();

      // Head follows the view; the neck takes part of the correction.
      tmp.q.setFromEuler(tmp.eu.set(st.pitch * 0.92 - 0.06 * st.aim, 0, 0.1 * st.aim + 0.35 * st.down, 'YXZ'));
      const corr = tmp.q.premultiply(chainInv);
      B.neck.quaternion.identity().slerp(corr, 0.45);
      B.head.quaternion.copy(B.neck.quaternion).invert().multiply(corr);

      // The support shoulder protracts toward the handguard; the firing shoulder rolls in behind the stock.
      const prot = 0.7 + 0.3 * Math.max(st.aim, st.sprint);
      B.upperL.position.set(-D.shX + 0.02 * prot, D.shY, -0.06 * prot);
      B.upperR.position.set(D.shX - 0.01 * st.aim, D.shY + 0.008 * st.aim, -0.02 * st.aim);
      ik(B.upperR, B.foreR, tmp.f.copy(gripR).applyMatrix4(B.rifle.matrix), D.upper, D.fore, poleArm.R);
      ik(B.upperL, B.foreL, tmp.f.copy(gripL).applyMatrix4(B.rifle.matrix), D.upper, D.fore, poleArm.L);

      // Legs, solved in the hip frame from body-frame ankle targets.
      B.hips.updateMatrix();
      const invHips = tmp.m.copy(B.hips.matrix).invert();
      const still = 1 - amp;
      for (const sd of ['L', 'R']) {
        const sg = sd === 'L' ? -1 : 1;
        const p = ph + (sg > 0 ? Math.PI : 0);
        const f = reach * Math.sin(p) * amp;
        const upAmt = lift * Math.max(0, Math.cos(p)) * amp;
        const tgt = tmp.g.set(
          sg * (0.11 + 0.03 * st.crouch) + mx * f,
          D.ankle + upAmt + st.air * (sg > 0 ? 0.26 : 0.16),
          sg * (0.08 * st.aim * still + 0.14 * st.crouch) + mz * f + st.air * 0.08,
        );
        if (st.down > 0.001) tgt.lerp(downFoot[sd], st.down);
        tgt.applyMatrix4(invHips);
        const thigh = B['thigh' + sd], shin = B['shin' + sd], foot = B['foot' + sd];
        ik(thigh, shin, tgt, D.thigh, D.shin, poleLeg[sd]);
        // Feet stay level with the ground, toes out a little, toe dropping while swinging.
        const toe = lift > 0 ? -0.35 * (upAmt / lift) : 0;
        tmp.q.setFromEuler(tmp.eu.set(toe, -sg * 0.08, 0, 'YXZ'));
        foot.quaternion.copy(B.hips.quaternion).multiply(thigh.quaternion).multiply(shin.quaternion).invert().multiply(tmp.q);
      }

      flash.visible = st.flash > 0;
      if (flash.visible) {
        flash.rotation.z = Math.random() * Math.PI;
        flash.scale.setScalar(0.8 + Math.random() * 0.5);
      }
    }

    // Shots come from a shouldered rifle: snap into the aim carry before the caller reads the muzzle.
    function fire() {
      st.flash = 0.05;
      st.recoil = 1;
      st.aimHold = 1.4;
      if (st.down < 0.5) st.aim = 1;
      update(0, st.last);
    }

    function muzzleWorld(out) {
      B.rifle.updateWorldMatrix(true, false);
      return B.rifle.localToWorld(out.copy(muzzle));
    }

    function tagAnchor(out) {
      B.head.getWorldPosition(out);
      out.y += 0.32;
      return out;
    }

    function dispose() {
      root.removeFromParent();
      for (const g of geos) g.dispose();
    }

    update(0, {});
    return { root, bones: B, look, update, fire, muzzleWorld, tagAnchor, dispose, state: st };
  }

  const api = { create, lookFor, dims: D, grips: { right: GRIP_R, left: GRIP_L }, skins: SKIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.SaltlineAvatar = api;
})(typeof window !== 'undefined' ? window : globalThis);
