// The 3D kitchen: a WebGL skillet that mirrors whatever the engine says is in
// the pan. It reads engine state and never writes to it, so the rules, the
// tests and the DOM HUD are all unaffected by anything in here.
//
// three.js is fetched at runtime. If that fails -- offline, CDN blocked, no
// WebGL -- `createKitchen` resolves to null and the caller falls back to the
// flat pan, which is why nothing else in the game imports this module's types.

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';

const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where each ingredient's look is defined: geometry recipe plus base colour. */
const LOOKS = {
  tomato:   { color: 0xd6382f, build: (T) => new T.SphereGeometry(0.15, 20, 14) },
  onion:    { color: 0xe8d6ae, build: (T) => scaleGeo(new T.SphereGeometry(0.15, 20, 14), 1, 0.86, 1) },
  mushroom: { color: 0xc9a882, build: null },
  cheese:   { color: 0xf0b429, build: (T) => new T.BoxGeometry(0.24, 0.07, 0.19) },
  beef:     { color: 0x8c3b34, build: (T) => new T.BoxGeometry(0.30, 0.09, 0.22) },
  shrimp:   { color: 0xf08a72, build: (T) => new T.TorusGeometry(0.11, 0.045, 10, 18, Math.PI * 1.45) },
  egg:      { color: 0xf4efe4, build: null },
  noodles:  { color: 0xe6c98a, build: (T) => new T.TorusKnotGeometry(0.11, 0.032, 72, 8, 2, 3) },
  chili:    { color: 0xcf3a2b, build: (T) => new T.ConeGeometry(0.06, 0.30, 12) },
};

function scaleGeo(geometry, x, y, z) {
  geometry.scale(x, y, z);
  return geometry;
}

/**
 * A tiny equirectangular gradient used as the scene environment. Without one,
 * a `metalness: 0.8` material has almost nothing to reflect and renders very
 * near black however many lights are pointed at it -- which reads as "the pan
 * did not load" rather than as a lighting setting.
 */
function makeEnvironment(THREE, renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0.0, '#6b5546');   // warm ceiling bounce
  sky.addColorStop(0.42, '#3a2b24');
  sky.addColorStop(0.58, '#241a16');
  sky.addColorStop(1.0, '#120c0a');   // dark floor
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 32, 128);
  // a bright strip standing in for the overhead service light
  ctx.fillStyle = 'rgba(255, 226, 180, 0.95)';
  ctx.fillRect(0, 6, 32, 12);

  const source = new THREE.CanvasTexture(canvas);
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(source);
  pmrem.dispose();
  source.dispose();
  return target.texture;
}

/** A soft round dot, drawn once and reused for every particle. */
function makeSpriteTexture(THREE) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * A fixed-capacity particle cloud. Lifetimes are wall-clock, never frame
 * counts: a throttled tab would otherwise freeze steam mid-air indefinitely.
 */
function createParticles(THREE, { count, size, color, blending, opacity }) {
  const positions = new Float32Array(count * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);

  const material = new THREE.PointsMaterial({
    size,
    map: makeSpriteTexture(THREE),
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  const live = [];
  return {
    object: points,
    spawn(x, y, z, vx, vy, vz, lifeMs, now) {
      if (live.length >= count) return;
      live.push({ x, y, z, vx, vy, vz, born: now, die: now + lifeMs });
    },
    update(now, dt) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const p = live[i];
        if (now >= p.die) {
          live.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vy += 0.12 * dt; // buoyancy
      }
      for (let i = 0; i < live.length; i += 1) {
        positions[i * 3] = live[i].x;
        positions[i * 3 + 1] = live[i].y;
        positions[i * 3 + 2] = live[i].z;
      }
      geometry.setDrawRange(0, live.length);
      geometry.attributes.position.needsUpdate = true;
      points.visible = live.length > 0;
    },
    clear() {
      live.length = 0;
      geometry.setDrawRange(0, 0);
    },
  };
}

export async function createKitchen(canvas) {
  let THREE;
  try {
    THREE = await import(/* webpackIgnore: true */ THREE_URL);
  } catch {
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  } catch {
    return null; // no WebGL on this device
  }

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = !REDUCED_MOTION;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x140f0d);
  scene.fog = new THREE.Fog(0x140f0d, 3.4, 7.2);
  scene.environment = makeEnvironment(THREE, renderer);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 40);
  camera.position.set(0, 1.94, 1.38);
  camera.lookAt(0, 0.04, 0);

  // --- lighting -----------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xffd2a1, 0x1b1210, 1.0));

  const key = new THREE.DirectionalLight(0xffe0b8, 2.6);
  key.position.set(-2.1, 3.4, 2.2);
  key.castShadow = !REDUCED_MOTION;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 9;
  key.shadow.camera.left = -2;
  key.shadow.camera.right = 2;
  key.shadow.camera.top = 2;
  key.shadow.camera.bottom = -2;
  key.shadow.bias = -0.0025;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x8fc4dd, 1.1);
  rim.position.set(2.6, 1.8, -2.6);
  scene.add(rim);

  // The burner is the mood: it brightens and shifts colour with the heat dial.
  const burnerLight = new THREE.PointLight(0xff6a2a, 0, 3.4, 2);
  burnerLight.position.set(0, -0.12, 0);
  scene.add(burnerLight);

  // --- counter and burner -------------------------------------------------
  const counter = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.6, 0.16, 48),
    new THREE.MeshStandardMaterial({ color: 0x33241e, roughness: 0.94, metalness: 0.04 }),
  );
  counter.position.y = -0.3;
  counter.receiveShadow = true;
  scene.add(counter);

  const burnerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.05, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0x191211, roughness: 0.7, metalness: 0.5 }),
  );
  burnerRing.rotation.x = Math.PI / 2;
  burnerRing.position.y = -0.2;
  burnerRing.receiveShadow = true;
  scene.add(burnerRing);

  for (let i = 0; i < 4; i += 1) {
    const grate = new THREE.Mesh(
      new THREE.BoxGeometry(1.36, 0.035, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x120d0c, roughness: 0.6, metalness: 0.6 }),
    );
    grate.rotation.y = (i * Math.PI) / 4;
    grate.position.y = -0.19;
    grate.receiveShadow = true;
    scene.add(grate);
  }

  // --- side dressing ------------------------------------------------------
  // The pan panel is much wider than it is tall, so the frame has room either
  // side of the skillet that would otherwise read as empty darkness.

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.07, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x6b452a, roughness: 0.82, metalness: 0.02 }),
  );
  board.position.set(-1.72, -0.18, 0.1);
  board.rotation.y = 0.28;
  board.castShadow = true;
  board.receiveShadow = true;
  scene.add(board);

  const plateMaterial = new THREE.MeshStandardMaterial({
    color: 0xb3a695, roughness: 0.45, metalness: 0.04,
  });
  for (let i = 0; i < 4; i += 1) {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.27, 0.035, 28), plateMaterial);
    plate.position.set(1.78, -0.19 + i * 0.037, 0.02);
    plate.castShadow = true;
    plate.receiveShadow = true;
    scene.add(plate);
  }

  const crock = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.15, 0.34, 20),
    new THREE.MeshStandardMaterial({ color: 0x3f2f28, roughness: 0.7, metalness: 0.1 }),
  );
  crock.position.set(1.5, -0.05, -0.82);
  crock.castShadow = true;
  scene.add(crock);

  // --- the skillet --------------------------------------------------------
  const skillet = new THREE.Group();
  scene.add(skillet);

  const panProfile = [
    [0.001, 0.0], [0.26, 0.0], [0.46, 0.012], [0.61, 0.06],
    [0.71, 0.15], [0.762, 0.25], [0.78, 0.32],
  ].map(([x, y]) => new THREE.Vector2(x, y));

  const panMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a3c35,
    roughness: 0.42,
    metalness: 0.68,
    side: THREE.DoubleSide,
  });
  const panBody = new THREE.Mesh(new THREE.LatheGeometry(panProfile, 56), panMaterial);
  panBody.castShadow = true;
  panBody.receiveShadow = true;
  skillet.add(panBody);

  const panRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.022, 10, 56),
    new THREE.MeshStandardMaterial({ color: 0x6b574d, roughness: 0.28, metalness: 0.9 }),
  );
  panRim.rotation.x = Math.PI / 2;
  panRim.position.y = 0.32;
  panRim.castShadow = true;
  skillet.add(panRim);

  const handle = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.052, 0.78, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x17100e, roughness: 0.85, metalness: 0.15 }),
  );
  handle.rotation.z = Math.PI / 2;
  handle.rotation.y = -0.34;
  handle.position.set(0.98, 0.30, 0.36);
  handle.castShadow = true;
  skillet.add(handle);

  // --- flame --------------------------------------------------------------
  const flame = new THREE.Group();
  flame.position.y = -0.2;
  scene.add(flame);

  // A pool of heat on the burner ring. Does most of the work of selling the
  // flame; the cones are the detail on top of it.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 40),
    new THREE.MeshBasicMaterial({
      color: 0xff5a1e,
      map: makeSpriteTexture(THREE),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.015;
  flame.add(glow);

  const flameCones = [];
  for (let i = 0; i < 9; i += 1) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.085, 0.26, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff8a2b,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const angle = (i / 9) * Math.PI * 2;
    cone.position.set(Math.cos(angle) * 0.86, 0.06, Math.sin(angle) * 0.86);
    cone.userData.phase = Math.random() * Math.PI * 2;
    flame.add(cone);
    flameCones.push(cone);
  }

  const steam = createParticles(THREE, {
    count: REDUCED_MOTION ? 30 : 130,
    size: 0.24,
    color: 0xe8dccb,
    blending: THREE.NormalBlending,
    opacity: 0.3,
  });
  scene.add(steam.object);

  const smoke = createParticles(THREE, {
    count: REDUCED_MOTION ? 24 : 110,
    size: 0.3,
    color: 0x2a2320,
    blending: THREE.NormalBlending,
    opacity: 0.62,
  });
  scene.add(smoke.object);

  // --- ingredients --------------------------------------------------------
  // Geometry is identical for every copy of an ingredient, so it is built once
  // and shared. Materials are per-instance, because each portion browns and
  // chars on its own schedule -- and they are the only thing needing disposal.
  const geometryCache = new Map();

  function partsFor(id) {
    const cached = geometryCache.get(id);
    if (cached) return cached;
    let parts;
    if (id === 'mushroom') {
      parts = [
        { geometry: new THREE.SphereGeometry(0.14, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), y: 0.05 },
        { geometry: new THREE.CylinderGeometry(0.055, 0.07, 0.11, 12), y: 0 },
      ];
    } else if (id === 'egg') {
      parts = [
        { geometry: scaleGeo(new THREE.SphereGeometry(0.16, 20, 14), 1, 0.33, 1), y: 0 },
        { geometry: scaleGeo(new THREE.SphereGeometry(0.072, 16, 12), 1, 0.72, 1), y: 0.035, accent: 0xf2a71b },
      ];
    } else {
      parts = [{ geometry: (LOOKS[id] ?? LOOKS.tomato).build(THREE), y: 0 }];
    }
    geometryCache.set(id, parts);
    return parts;
  }

  function buildIngredient(id) {
    const look = LOOKS[id] ?? LOOKS.tomato;
    const material = new THREE.MeshStandardMaterial({
      color: look.color,
      roughness: 0.62,
      metalness: 0.04,
    });
    const group = new THREE.Group();
    const extraMaterials = [];

    for (const part of partsFor(id)) {
      let partMaterial = material;
      if (part.accent !== undefined) {
        partMaterial = new THREE.MeshStandardMaterial({ color: part.accent, roughness: 0.45 });
        extraMaterials.push(partMaterial);
      }
      const mesh = new THREE.Mesh(part.geometry, partMaterial);
      mesh.position.y = part.y;
      mesh.castShadow = !REDUCED_MOTION;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    group.userData.material = material;
    group.userData.extraMaterials = extraMaterials;
    group.userData.baseColor = new THREE.Color(look.color);
    group.userData.spin = (Math.random() - 0.5) * 1.4;
    group.userData.phase = Math.random() * Math.PI * 2;
    return group;
  }

  /** Frees the per-instance materials. Shared geometry stays in the cache. */
  function releaseIngredient(group) {
    group.userData.material?.dispose();
    for (const extra of group.userData.extraMaterials ?? []) extra.dispose();
  }

  const GOLDEN = new THREE.Color(0xb2702a);
  const CHARRED = new THREE.Color(0x140f0d);

  const plated = new THREE.Group();
  skillet.add(plated);

  /** Meshes currently in the pan, parallel to `state.pan.items`. */
  let inPan = [];
  /** Ingredients thrown clear on a serve or a burn, animating out. */
  const flying = [];

  function seatIngredients(items, now) {
    // Rebuild only when the contents actually changed.
    const same =
      inPan.length === items.length && inPan.every((entry, i) => entry.id === items[i]);
    if (same) return;

    for (const entry of inPan) {
      plated.remove(entry.object);
      releaseIngredient(entry.object);
    }
    inPan = items.map((id, index) => {
      const object = buildIngredient(id);
      const angle = (index / Math.max(1, items.length)) * Math.PI * 2 - Math.PI / 2;
      const radius = items.length === 1 ? 0 : 0.27;
      object.userData.home = new THREE.Vector3(
        Math.cos(angle) * radius,
        0.11,
        Math.sin(angle) * radius,
      );
      object.position.copy(object.userData.home);
      object.position.y += 1.5; // drop in
      object.userData.droppedAt = now;
      plated.add(object);
      return { id, object };
    });
  }

  let serveTiltUntil = 0;

  function throwClear(now, { burnt }) {
    for (const entry of inPan) {
      const object = entry.object;
      plated.remove(object);
      scene.add(object);
      object.position.add(plated.position);
      // A served dish arcs sideways towards the plate stack: seen from almost
      // overhead, anything thrown straight up just leaves the frame.
      object.userData.velocity = burnt
        ? new THREE.Vector3((Math.random() - 0.5) * 0.9, 1.0 + Math.random() * 0.5, (Math.random() - 0.5) * 0.9)
        : new THREE.Vector3(2.5 + Math.random() * 0.7, 1.15 + Math.random() * 0.35, (Math.random() - 0.5) * 0.5);
      object.userData.die = now + (burnt ? 900 : 1100);
      flying.push(object);
    }
    inPan = [];
    if (!burnt) serveTiltUntil = now + 460;
  }

  function updateFlying(now, dt) {
    for (let i = flying.length - 1; i >= 0; i -= 1) {
      const object = flying[i];
      const velocity = object.userData.velocity;
      velocity.y -= 5.4 * dt;
      object.position.addScaledVector(velocity, dt);
      object.rotation.x += dt * 4;
      object.rotation.z += dt * 3;
      if (now >= object.userData.die) {
        scene.remove(object);
        releaseIngredient(object);
        flying.splice(i, 1);
      }
    }
  }

  // --- per-frame sync -----------------------------------------------------
  const tint = new THREE.Color();
  let lastSteamAt = 0;
  let lastSmokeAt = 0;
  let previousItemCount = 0;
  let previousBurn = 0;

  function sync(state, now, dt) {
    const pan = state.pan;
    const heat = pan.heat;
    const seconds = now / 1000;

    // Something left the pan: either plated, or burnt to a crisp.
    if (pan.items.length === 0 && previousItemCount > 0 && inPan.length > 0) {
      const wasBurnt = previousBurn > 0.75;
      throwClear(now, { burnt: wasBurnt });
      if (wasBurnt) {
        for (let i = 0; i < (REDUCED_MOTION ? 6 : 26); i += 1) {
          smoke.spawn(
            (Math.random() - 0.5) * 0.6, 0.3, (Math.random() - 0.5) * 0.6,
            (Math.random() - 0.5) * 0.5, 0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 0.5,
            1400 + Math.random() * 900, now,
          );
        }
      }
    }
    previousItemCount = pan.items.length;
    previousBurn = pan.burn;

    seatIngredients(pan.items, now);

    // Drop-in bounce, sizzle jitter, and browning.
    for (const entry of inPan) {
      const object = entry.object;
      const home = object.userData.home;
      const age = (now - object.userData.droppedAt) / 1000;
      const settle = Math.min(1, age / 0.34);
      const eased = 1 - (1 - settle) * (1 - settle);
      const squash = settle < 1 ? 0 : Math.abs(Math.sin((age - 0.34) * 9)) * Math.exp(-(age - 0.34) * 6) * 0.05;

      const jitter = pan.cooking && !REDUCED_MOTION
        ? Math.sin(seconds * 13 + object.userData.phase) * 0.012 * (0.3 + heat)
        : 0;

      object.position.set(
        home.x + jitter,
        home.y + (1 - eased) * 1.5 + squash + Math.abs(jitter) * 0.6,
        home.z + jitter * 0.6,
      );
      if (pan.cooking && !REDUCED_MOTION) {
        object.rotation.y += object.userData.spin * dt * (0.2 + heat * 0.8);
      }

      tint.copy(object.userData.baseColor).lerp(GOLDEN, Math.min(1, pan.sear * 0.85));
      tint.lerp(CHARRED, Math.min(1, pan.burn * 1.1));
      object.userData.material.color.copy(tint);
      for (const extra of object.userData.extraMaterials ?? []) {
        extra.color.lerp(tint, 0.04);
      }
    }

    // Flame tracks the dial: taller, brighter and whiter as the needle climbs.
    const alive = pan.recipeId ? heat : heat * 0.35;
    flame.visible = alive > 0.02;
    if (flame.visible) {
      for (const cone of flameCones) {
        const flicker = 0.82 + Math.sin(seconds * 11 + cone.userData.phase) * 0.18;
        cone.scale.set(0.45 + alive * 0.35, (0.4 + alive * 1.5) * flicker, 0.45 + alive * 0.35);
        cone.position.y = 0.06 + alive * 0.13;
        cone.material.opacity = 0.26 + alive * 0.36;
        // Stays firmly in the orange-to-red band: pushed any lighter, additive
        // blending turns the cones into white spikes rather than flame.
        cone.material.color.setHSL(0.065 - alive * 0.028, 1, 0.3 + alive * 0.16);
      }
      glow.material.opacity = 0.1 + alive * 0.42;
      glow.material.color.setHSL(0.055 - alive * 0.025, 1, 0.32 + alive * 0.14);
      glow.scale.setScalar(0.8 + alive * 0.35);
    }
    burnerLight.intensity = alive * 6.2;
    burnerLight.color.setHSL(0.075 - alive * 0.04, 0.9, 0.5);
    panMaterial.emissive.setHSL(0.05, 0.9, 0.5);
    panMaterial.emissiveIntensity = Math.max(0, alive - 0.5) * 0.42;

    // Steam while searing, smoke while charring -- rates, not per-frame rolls.
    if (pan.cooking && pan.sear > 0.02) {
      const interval = 90 - Math.min(60, pan.sear * 60);
      if (now - lastSteamAt > interval) {
        lastSteamAt = now;
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 0.34;
        steam.spawn(
          Math.cos(angle) * radius, 0.22, Math.sin(angle) * radius,
          (Math.random() - 0.5) * 0.16, 0.42 + Math.random() * 0.3, (Math.random() - 0.5) * 0.16,
          1100 + Math.random() * 700, now,
        );
      }
    }
    if (pan.cooking && pan.burn > 0.06) {
      const interval = 150 - Math.min(115, pan.burn * 130);
      if (now - lastSmokeAt > interval) {
        lastSmokeAt = now;
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 0.4;
        smoke.spawn(
          Math.cos(angle) * radius, 0.26, Math.sin(angle) * radius,
          (Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.45, (Math.random() - 0.5) * 0.3,
          1300 + Math.random() * 800, now,
        );
      }
    }

    steam.update(now, dt);
    smoke.update(now, dt);
    updateFlying(now, dt);

    // Idle drift so the kitchen never looks frozen, plus the tip of the wrist
    // that sends a finished dish to the pass.
    skillet.rotation.y = Math.sin(seconds * 0.28) * 0.05;
    skillet.position.y = Math.sin(seconds * 0.7) * 0.006;

    const tiltLeft = serveTiltUntil - now;
    if (tiltLeft > 0 && !REDUCED_MOTION) {
      const phase = 1 - tiltLeft / 460;
      skillet.rotation.z = -Math.sin(phase * Math.PI) * 0.42;
    } else {
      skillet.rotation.z = 0;
    }

    renderer.render(scene, camera);
  }

  function resize(width, height) {
    if (!(width > 0 && height > 0)) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the pan framed in a short, wide panel as well as a tall one.
    camera.fov = height / width > 0.75 ? 46 : 40;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    steam.clear();
    smoke.clear();
    renderer.dispose();
  }

  return {
    sync,
    resize,
    dispose,
    /** Live GPU object counts, for verifying nothing accumulates. */
    stats: () => ({ ...renderer.info.memory, calls: renderer.info.render.calls }),
  };
}
