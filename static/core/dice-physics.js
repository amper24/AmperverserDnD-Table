// ---------------------------------------------------------------------------
// dice-physics.js — локальная, детерминированная по результату физика анимации.
// Кость получает уже выпавшее значение; симуляция никогда не бросает её заново.
// ---------------------------------------------------------------------------
window.DicePhysics = (() => {
  'use strict';

  const EPS = 1e-7;
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    length: a => Math.hypot(a[0], a[1], a[2]),
    normalize(a) { const n = this.length(a) || 1; return this.scale(a, 1 / n); },
  };
  const Q = {
    normalize(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map(x => x / n); },
    multiply(a, b) {
      return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
      ];
    },
    conjugate: q => [q[0], -q[1], -q[2], -q[3]],
    axisAngle(axis, angle) {
      const n = V.normalize(axis), half = angle / 2, s = Math.sin(half);
      return [Math.cos(half), n[0] * s, n[1] * s, n[2] * s];
    },
    slerp(from, to, amount) {
      let target = to, cosine = from.reduce((sum, value, index) => sum + value * to[index], 0);
      if (cosine < 0) { target = to.map(value => -value); cosine = -cosine; }
      if (cosine > .9995) return this.normalize(from.map((value, index) => value + (target[index] - value) * amount));
      const angle = Math.acos(Math.max(-1, Math.min(1, cosine))), sine = Math.sin(angle);
      const a = Math.sin((1 - amount) * angle) / sine, b = Math.sin(amount * angle) / sine;
      return this.normalize(from.map((value, index) => value * a + target[index] * b));
    },
    rotate(q, v) {
      const p = [0, v[0], v[1], v[2]], r = this.multiply(this.multiply(q, p), this.conjugate(q));
      return [r[1], r[2], r[3]];
    },
    fromTo(from, to) {
      const a = V.normalize(from), b = V.normalize(to), d = Math.max(-1, Math.min(1, V.dot(a, b)));
      if (d > 1 - EPS) return [1, 0, 0, 0];
      if (d < -1 + EPS) {
        const axis = V.normalize(V.cross(a, Math.abs(a[0]) < .8 ? [1, 0, 0] : [0, 1, 0]));
        return this.axisAngle(axis, Math.PI);
      }
      return this.normalize([1 + d, ...V.cross(a, b)]);
    },
  };

  function hull(vertices) {
    const center = vertices.reduce((sum, p) => V.add(sum, p), [0, 0, 0]).map(n => n / vertices.length);
    const planes = new Map();
    for (let i = 0; i < vertices.length - 2; i++) for (let j = i + 1; j < vertices.length - 1; j++) for (let k = j + 1; k < vertices.length; k++) {
      let normal = V.cross(V.sub(vertices[j], vertices[i]), V.sub(vertices[k], vertices[i]));
      const magnitude = V.length(normal);
      if (magnitude < EPS) continue;
      normal = V.scale(normal, 1 / magnitude);
      const distances = vertices.map(p => V.dot(normal, V.sub(p, vertices[i])));
      const positive = distances.some(d => d > 1e-5), negative = distances.some(d => d < -1e-5);
      if (positive && negative) continue;
      if (V.dot(normal, V.sub(center, vertices[i])) > 0) normal = V.scale(normal, -1);
      const ids = vertices.flatMap((p, index) => Math.abs(V.dot(normal, V.sub(p, vertices[i]))) < 1e-5 ? [index] : []);
      if (ids.length < 3) continue;
      const key = ids.join(',');
      if (planes.has(key)) continue;
      const middle = ids.reduce((sum, id) => V.add(sum, vertices[id]), [0, 0, 0]).map(n => n / ids.length);
      const reference = V.normalize(V.sub(vertices[ids[0]], middle));
      const tangent = V.cross(normal, reference);
      ids.sort((a, b) => {
        const pa = V.sub(vertices[a], middle), pb = V.sub(vertices[b], middle);
        return Math.atan2(V.dot(pa, tangent), V.dot(pa, reference)) - Math.atan2(V.dot(pb, tangent), V.dot(pb, reference));
      });
      if (V.dot(V.cross(V.sub(vertices[ids[1]], vertices[ids[0]]), V.sub(vertices[ids[2]], vertices[ids[1]])), normal) < 0) ids.reverse();
      planes.set(key, { indices: ids, normal });
    }
    return [...planes.values()];
  }

  const PHI = (1 + Math.sqrt(5)) / 2;
  const icosaVertices = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ];
  const cubeVertices = Array.from({ length: 8 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
  const tetraVertices = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  const octaVertices = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const decaVertices = Array.from({ length: 5 }, (_, i) => [Math.cos(i * 2 * Math.PI / 5), Math.sin(i * 2 * Math.PI / 5), 0])
    .concat([[0, 0, 1.35], [0, 0, -1.35]]);

  function dodecahedron() {
    const triangles = hull(icosaVertices);
    const vertices = triangles.map(face => V.normalize(face.indices.reduce((sum, i) => V.add(sum, icosaVertices[i]), [0, 0, 0])));
    const faces = icosaVertices.map((normal, vertexIndex) => {
      const ids = triangles.flatMap((face, i) => face.indices.includes(vertexIndex) ? [i] : []);
      const n = V.normalize(normal), middle = ids.reduce((sum, id) => V.add(sum, vertices[id]), [0, 0, 0]).map(x => x / ids.length);
      const reference = V.normalize(V.sub(vertices[ids[0]], middle)), tangent = V.cross(n, reference);
      ids.sort((a, b) => {
        const pa = V.sub(vertices[a], middle), pb = V.sub(vertices[b], middle);
        return Math.atan2(V.dot(pa, tangent), V.dot(pa, reference)) - Math.atan2(V.dot(pb, tangent), V.dot(pb, reference));
      });
      if (V.dot(V.cross(V.sub(vertices[ids[1]], vertices[ids[0]]), V.sub(vertices[ids[2]], vertices[ids[1]])), n) < 0) ids.reverse();
      return { indices: ids, normal: n };
    });
    return { vertices, faces };
  }

  const regular = new Map();
  function modelFor(sides) {
    if (regular.has(sides)) return regular.get(sides);
    let vertices;
    if (sides === 4) vertices = tetraVertices;
    else if (sides === 6) vertices = cubeVertices;
    else if (sides === 8) vertices = octaVertices;
    else if (sides === 10 || sides === 100) vertices = decaVertices;
    else if (sides === 12) {
      const model = dodecahedron();
      const radius = Math.max(...model.vertices.map(V.length));
      model.vertices = model.vertices.map(p => V.scale(p, 1 / radius));
      model.faces.forEach((face, i) => { face.id = i; face.label = i + 1; });
      regular.set(sides, model); return model;
    } else if (sides === 20) vertices = icosaVertices;
    else vertices = cubeVertices;
    const radius = Math.max(...vertices.map(V.length));
    const normalized = vertices.map(p => V.scale(p, 1 / radius));
    const faces = hull(normalized);
    faces.forEach((face, i) => { face.id = i; face.label = i + 1; });
    const model = { vertices: normalized, faces };
    regular.set(sides, model);
    return model;
  }

  function randomUnit(rng) {
    if (rng) return Math.max(0, Math.min(.999999999, Number(rng()) || 0));
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] / 4294967296;
  }
  function randomQuaternion(rng) {
    const u1 = randomUnit(rng), u2 = randomUnit(rng) * Math.PI * 2, u3 = randomUnit(rng) * Math.PI * 2;
    return Q.normalize([
      Math.sqrt(1 - u1) * Math.sin(u2), Math.sqrt(1 - u1) * Math.cos(u2),
      Math.sqrt(u1) * Math.sin(u3), Math.sqrt(u1) * Math.cos(u3),
    ]);
  }
  function randomAxis(rng) { return V.normalize([randomUnit(rng) * 2 - 1, randomUnit(rng) * 2 - 1, randomUnit(rng) * 2 - 1]); }
  // Timeline in seconds: the die appears at the centre, is tossed to a random
  // landing spot near it, hops once, rolls a little across the invisible table
  // and comes to rest. The orientation servo still drives the accepted face to
  // `target`; the slide only moves the rest point and spins the die while rolling.
  const TOSS = .56, HOP = .18, ROLL = .4, DURATION = 1.5, SETTLE = .34;
  const ROLL_END = TOSS + HOP + ROLL;
  const easeOut = t => 1 - (1 - t) * (1 - t);
  function createDie({ sides, value, kept = true }, rng) {
    const faceCount = Math.max(1, Number(sides) || 6), model = modelFor(faceCount);
    const faceIndex = ((Math.max(1, Math.trunc(Number(value) || 1)) - 1) % model.faces.length);
    const face = model.faces[faceIndex];
    const desiredNormal = V.normalize([.13, .18, 1]);
    const align = Q.fromTo(face.normal, desiredNormal);
    const yaw = Q.axisAngle([0, 0, 1], randomUnit(rng) * Math.PI * 2);
    const target = Q.normalize(Q.multiply(yaw, align));
    return {
      sides: faceCount, value: Math.trunc(Number(value) || 1), kept: !!kept,
      model, faceIndex, target, orientation: randomQuaternion(rng), axis: randomAxis(rng),
      angularVelocity: V.scale(randomAxis(rng), 7 + randomUnit(rng) * 10),
      lift: .9 + randomUnit(rng) * .35, hopLift: .16 + randomUnit(rng) * .08,
      kicks: 0, height: 0, scale: .55,
      x: 0, y: 0, anchorX: 0, anchorY: 0, landX: 0, landY: 0, restX: 0, restY: 0,
      size: 48, elapsed: 0, duration: DURATION, settleFrom: null, settled: false,
    };
  }

  /// Places a die: origin (throw point, the centre), landing point and rest point
  /// are absolute canvas coordinates. Defaults keep the die still at the origin.
  function place(die, { x, y, size, landX = x, landY = y, restX = landX, restY = landY }) {
    die.anchorX = die.x = x; die.anchorY = die.y = y; die.size = size;
    die.landX = landX; die.landY = landY; die.restX = restX; die.restY = restY;
    return die;
  }
  function setAnchor(die, x, y, size) { return place(die, { x, y, size }); }
  function step(die, delta) {
    if (die.settled) return die;
    const dt = Math.max(0, Math.min(.035, Number(delta) || 0));
    if (!dt) return die;
    die.elapsed += dt;
    const t = die.elapsed, size = die.size, lerp = (a, b, k) => a + (b - a) * k;
    die.scale = .55 + .45 * easeOut(Math.min(1, t / .32));

    // Phase 1: toss from the centre to the landing spot, height is a parabola.
    if (t < TOSS) {
      const s = t / TOSS;
      die.height = size * die.lift * 4 * s * (1 - s);
      die.x = lerp(die.anchorX, die.landX, easeOut(s)); die.y = lerp(die.anchorY, die.landY, easeOut(s));
    // Phase 2: one small hop on the invisible table.
    } else if (t < TOSS + HOP) {
      const s = (t - TOSS) / HOP;
      die.height = size * die.hopLift * 4 * s * (1 - s);
      die.x = die.landX; die.y = die.landY;
    // Phase 3: slide/roll to the rest point, decelerating, spinning as it goes.
    } else if (t < ROLL_END) {
      const u = (t - TOSS - HOP) / ROLL, dx = die.restX - die.landX, dy = die.restY - die.landY, dist = Math.hypot(dx, dy);
      die.height = 0;
      die.x = lerp(die.landX, die.restX, easeOut(u)); die.y = lerp(die.landY, die.restY, easeOut(u));
      if (dist > EPS) {
        const speed = dist * 2 * (1 - u) / ROLL, rate = speed / Math.max(1, size * .9);
        // Rolling on a floor (normal = +y, screen plane = x/z) turns about the axis cross(up, direction).
        const axis = [dy / dist, 0, -dx / dist];
        die.orientation = Q.normalize(Q.multiply(Q.axisAngle(axis, rate * dt), die.orientation));
      }
    } else {
      die.height = 0; die.x = die.restX; die.y = die.restY;
    }
    // Cosmetic impact kicks at the toss landing and at the hop landing.
    if (t >= TOSS && die.kicks < 1) { die.kicks = 1; die.angularVelocity = V.add(die.angularVelocity, V.scale(die.axis, (randomUnitFromDie(die) - .5) * 1.7)); }
    if (t >= TOSS + HOP && die.kicks < 2) { die.kicks = 2; die.angularVelocity = V.add(die.angularVelocity, V.scale(die.axis, (randomUnitFromDie(die) - .5) * 1.1)); }

    // A damped angular motor guides the visible top face to the server's value.
    // Unlike a post-roll spin, it brakes continuously and ends with zero velocity.
    const settleStart = die.duration - SETTLE;
    let error = Q.normalize(Q.multiply(die.target, Q.conjugate(die.orientation)));
    if (error[0] < 0) error = error.map(n => -n);
    const sine = Math.hypot(error[1], error[2], error[3]);
    if (sine > EPS && t < settleStart) {
      const angle = 2 * Math.atan2(sine, Math.max(0, error[0]));
      const axis = [error[1] / sine, error[2] / sine, error[3] / sine];
      const kp = 58, kd = 15.2;
      let acceleration = V.sub(V.scale(axis, kp * angle), V.scale(die.angularVelocity, kd));
      const cap = 105, accelLength = V.length(acceleration);
      if (accelLength > cap) acceleration = V.scale(acceleration, cap / accelLength);
      die.angularVelocity = V.add(die.angularVelocity, V.scale(acceleration, dt));
      const spin = V.length(die.angularVelocity);
      if (spin > EPS) die.orientation = Q.normalize(Q.multiply(Q.axisAngle(die.angularVelocity, spin * dt), die.orientation));
    }
    if (t >= settleStart) {
      if (!die.settleFrom) die.settleFrom = [...die.orientation];
      const progress = Math.max(0, Math.min(1, (t - settleStart) / (die.duration - settleStart)));
      const eased = progress * progress * (3 - 2 * progress);
      die.orientation = Q.slerp(die.settleFrom, die.target, eased);
      die.angularVelocity = V.scale(die.angularVelocity, 1 - eased);
    }

    if (t >= die.duration) {
      die.orientation = [...die.target];
      die.angularVelocity = [0, 0, 0];
      die.height = 0;
      die.x = die.restX; die.y = die.restY;
      die.settled = true;
    }
    return die;
  }
  // The impact jitters are deterministic and cosmetic: they never change the face value.
  function randomUnitFromDie(die) {
    die.impactIndex = (die.impactIndex || 0) + 1;
    const x = Math.sin(die.value * 73.17 + die.impactIndex * 19.19) * 43758.5453;
    return x - Math.floor(x);
  }
  function faceUp(die) {
    let best = null, score = -Infinity;
    for (const face of die.model.faces) {
      const normal = Q.rotate(die.orientation, face.normal), dot = normal[2];
      if (dot > score) { score = dot; best = face; }
    }
    return { label: best?.id === die.faceIndex ? die.value : best?.label, faceIndex: best?.id, alignment: score };
  }

  return { modelFor, createDie, place, setAnchor, step, faceUp, rotate: (q, vector) => Q.rotate(q, vector) };
})();
