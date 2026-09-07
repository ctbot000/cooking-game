// Skillet Rush -- game logic. No DOM, no timers, no randomness beyond a seeded
// PRNG, so the whole game can be driven from a test as well as from a browser.
//
// The caller owns the clock: build a state with `createGame`, push player input
// through `act`, and advance the simulation with `update(state, dt)`.

import {
  RECIPES,
  RECIPE_BY_ID,
  TIERS,
  TIER_UNLOCK_DAY,
  matchRecipe,
} from './recipes.js';

export const CONFIG = {
  // Heat dial. A full sweep from cold to scorching takes ~1.8s. `heatFall` is
  // the needle's slowest slew rate, and so the ceiling every band's drift speed
  // has to stay under -- see `bandSpeed` in recipes.js.
  heatRise: 0.55,
  heatFall: 0.50,

  // Searing fills while the needle sits inside the band; a flawless cook takes
  // ~3.3s, a realistic one 5-8s.
  searRate: 0.30,

  // Burning fills while the needle is *above* the band. The rate escalates with
  // time spent cooking and with how nearly done the dish is, so hovering just
  // over the line stops being survivable -- without that, a patient player can
  // never actually fail.
  burnRate: 0.26,
  burnEscalationTime: 12,
  burnEscalationMax: 1.4,
  burnProgressBoost: 0.8,
  // Recovery is deliberately slower than the fill, so repeated scorching adds up.
  burnRecover: 0.10,

  // Backstop: a pan left cooking forever is its own (clearly labelled) failure.
  cookMax: 20,

  maxTickets: 4,
  startLives: 3,
  maxLives: 5,
  comboStep: 0.08,
  comboCap: 10,

  quality: {
    perfect: { threshold: 0.18, multiplier: 1.6 },
    good: { threshold: 0.55, multiplier: 1.0 },
    ok: { threshold: Infinity, multiplier: 0.6 },
  },
};

/** Tuning for a given service day. Later days are busier, tighter, hotter. */
export function dayConfig(day) {
  return {
    day,
    orders: Math.min(12, 4 + day),
    patience: Math.max(15, 34 - 2 * day),
    spawnEvery: Math.max(2.8, 7.5 - 0.45 * day),
    openingRush: 1.2,
    maxTier: day >= TIER_UNLOCK_DAY[3] ? 3 : day >= TIER_UNLOCK_DAY[2] ? 2 : 1,
    burnMultiplier: 1 + 0.06 * (day - 1),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function emptyPan() {
  return {
    items: [],
    recipeId: null,
    cooking: false,
    heatOn: false,
    heat: 0,
    sear: 0,
    burn: 0,
    cookTime: 0,
  };
}

export function createGame({ seed = Date.now(), day = 1 } = {}) {
  const state = {
    phase: 'title', // title | playing | dayEnd | gameOver
    seed: seed >>> 0,
    rng: mulberry32(seed),
    day,
    dayCfg: dayConfig(day),
    time: 0,
    spawnTimer: 0,
    ordersSpawned: 0,
    ordersResolved: 0,
    nextTicketId: 1,
    tickets: [],
    pan: emptyPan(),
    pass: null, // a cooked dish nobody has ordered yet
    score: 0,
    lives: CONFIG.startLives,
    combo: 0,
    bestCombo: 0,
    stats: { served: 0, perfect: 0, burnt: 0, ruined: 0, walkouts: 0, earned: 0 },
    dayStats: null,
    events: [],
  };
  resetDay(state, day);
  return state;
}

function resetDay(state, day) {
  state.day = day;
  state.dayCfg = dayConfig(day);
  state.time = 0;
  state.spawnTimer = state.dayCfg.openingRush;
  state.ordersSpawned = 0;
  state.ordersResolved = 0;
  state.tickets = [];
  state.pan = emptyPan();
  state.pass = null;
  state.dayStats = { served: 0, perfect: 0, burnt: 0, walkouts: 0, earned: 0 };
}

function emit(state, type, data = {}) {
  state.events.push({ type, ...data });
}

/** Drain queued feedback events. The UI calls this once per frame. */
export function takeEvents(state) {
  const out = state.events;
  state.events = [];
  return out;
}

// ---------------------------------------------------------------------------
// Heat band
// ---------------------------------------------------------------------------

/**
 * The window the needle has to stay inside, at time `t`. It drifts, so holding
 * one heat level is never a winning strategy.
 */
export function bandFor(recipe, t) {
  const tier = TIERS[recipe.tier];
  const centre = 0.5 + tier.amp * Math.sin((2 * Math.PI * t) / tier.period);
  const half = tier.width / 2;
  return { lo: centre - half, hi: centre + half, centre };
}

export function panBand(state) {
  const recipe = state.pan.recipeId ? RECIPE_BY_ID.get(state.pan.recipeId) : null;
  return recipe ? bandFor(recipe, state.time) : null;
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

export function act(state, action) {
  switch (action.type) {
    case 'start':
      state.phase = 'playing';
      state.score = 0;
      state.lives = CONFIG.startLives;
      state.combo = 0;
      state.bestCombo = 0;
      state.stats = { served: 0, perfect: 0, burnt: 0, ruined: 0, walkouts: 0, earned: 0 };
      state.rng = mulberry32(state.seed);
      resetDay(state, action.day ?? 1);
      break;

    case 'nextDay':
      if (state.phase !== 'dayEnd') break;
      state.lives = Math.min(CONFIG.maxLives, state.lives + 1);
      state.phase = 'playing';
      resetDay(state, state.day + 1);
      break;

    case 'add':
      addIngredient(state, action.id);
      break;

    case 'trash':
      trash(state);
      break;

    case 'heat':
      if (state.phase === 'playing' && state.pan.recipeId) {
        if (action.on && !state.pan.cooking) {
          state.pan.cooking = true;
          emit(state, 'cookStart');
        }
        state.pan.heatOn = !!action.on;
      } else {
        state.pan.heatOn = false;
      }
      break;

    default:
      break;
  }
  return state;
}

function addIngredient(state, id) {
  const pan = state.pan;
  if (state.phase !== 'playing' || pan.cooking || pan.items.length >= 4) {
    emit(state, 'reject');
    return;
  }
  pan.items.push(id);
  const recipe = matchRecipe(pan.items);
  pan.recipeId = recipe ? recipe.id : null;
  emit(state, 'add', { id, recipeId: pan.recipeId });
}

function trash(state) {
  if (state.pass) {
    emit(state, 'trash', { what: 'pass' });
    state.pass = null;
    return;
  }
  if (state.pan.items.length === 0) return;
  emit(state, 'trash', { what: 'pan', wasCooking: state.pan.cooking });
  state.pan = emptyPan();
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Advance the game by `dt` seconds. Safe to call with a clamped frame delta. */
export function update(state, dt) {
  if (state.phase !== 'playing') return state;
  if (!(dt > 0)) return state;

  state.time += dt;
  spawnTickets(state, dt);
  agePatience(state, dt);
  cook(state, dt);
  deliver(state);
  checkDayEnd(state);
  return state;
}

function pickRecipe(state) {
  const cfg = state.dayCfg;
  const pool = RECIPES.filter((r) => r.tier <= cfg.maxTier);
  // Later days lean harder: weight rises with tier once the tier is unlocked.
  const weights = pool.map((r) => 1 + (cfg.maxTier - r.tier === 0 ? 0.9 : 0) + 0.15 * r.tier);
  const onRail = new Set(state.tickets.map((t) => t.recipeId));
  const adjusted = pool.map((r, i) => (onRail.has(r.id) ? weights[i] * 0.45 : weights[i]));
  const total = adjusted.reduce((a, b) => a + b, 0);
  let roll = state.rng() * total;
  for (let i = 0; i < pool.length; i += 1) {
    roll -= adjusted[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function spawnTickets(state, dt) {
  const cfg = state.dayCfg;
  if (state.ordersSpawned >= cfg.orders) return;
  state.spawnTimer -= dt;
  if (state.spawnTimer > 0) return;
  if (state.tickets.length >= CONFIG.maxTickets) {
    state.spawnTimer = 0.5; // rail is full; try again shortly
    return;
  }
  const recipe = pickRecipe(state);
  const patience = cfg.patience * (0.85 + 0.3 * state.rng());
  state.tickets.push({
    id: state.nextTicketId++,
    recipeId: recipe.id,
    patience,
    maxPatience: patience,
    placedAt: state.time,
  });
  state.ordersSpawned += 1;
  state.spawnTimer = cfg.spawnEvery * (0.8 + 0.4 * state.rng());
  emit(state, 'order', { recipeId: recipe.id });
}

function agePatience(state, dt) {
  for (let i = state.tickets.length - 1; i >= 0; i -= 1) {
    const ticket = state.tickets[i];
    ticket.patience -= dt;
    if (ticket.patience <= 0) {
      state.tickets.splice(i, 1);
      state.ordersResolved += 1;
      state.combo = 0;
      state.lives -= 1;
      state.stats.walkouts += 1;
      state.dayStats.walkouts += 1;
      emit(state, 'walkout', { recipeId: ticket.recipeId, lives: state.lives });
      if (state.lives <= 0) {
        state.phase = 'gameOver';
        emit(state, 'gameOver');
        return;
      }
    }
  }
}

function qualityFor(burn) {
  const q = CONFIG.quality;
  if (burn < q.perfect.threshold) return 'perfect';
  if (burn < q.good.threshold) return 'good';
  return 'ok';
}

function cook(state, dt) {
  const pan = state.pan;
  const recipe = pan.recipeId ? RECIPE_BY_ID.get(pan.recipeId) : null;

  if (!recipe) {
    pan.heatOn = false;
    pan.heat = Math.max(0, pan.heat - CONFIG.heatFall * dt);
    return;
  }

  pan.heat = clamp(
    pan.heat + (pan.heatOn ? CONFIG.heatRise : -CONFIG.heatFall) * dt,
    0,
    1,
  );

  if (!pan.cooking) return;
  pan.cookTime += dt;

  const band = bandFor(recipe, state.time);
  if (pan.heat >= band.lo && pan.heat <= band.hi) {
    pan.sear = Math.min(1, pan.sear + CONFIG.searRate * dt);
    pan.burn = Math.max(0, pan.burn - CONFIG.burnRecover * dt);
  } else if (pan.heat > band.hi) {
    const escalation =
      1 +
      CONFIG.burnEscalationMax * Math.min(1, pan.cookTime / CONFIG.burnEscalationTime) +
      CONFIG.burnProgressBoost * pan.sear;
    pan.burn = Math.min(
      1,
      pan.burn + CONFIG.burnRate * escalation * state.dayCfg.burnMultiplier * dt,
    );
  }

  if (pan.burn >= 1) {
    state.combo = 0;
    state.stats.burnt += 1;
    state.dayStats.burnt += 1;
    emit(state, 'burnt', { recipeId: recipe.id });
    state.pan = emptyPan();
    return;
  }

  if (pan.sear >= 1) {
    const quality = qualityFor(pan.burn);
    state.pass = { recipeId: recipe.id, quality, platedAt: state.time };
    emit(state, 'plated', { recipeId: recipe.id, quality });
    state.pan = emptyPan();
    return;
  }

  if (pan.cookTime >= CONFIG.cookMax) {
    state.combo = 0;
    state.stats.ruined += 1;
    emit(state, 'ruined', { recipeId: recipe.id });
    state.pan = emptyPan();
  }
}

/** A plated dish goes to whichever waiting customer is closest to leaving. */
function deliver(state) {
  if (!state.pass) return;
  let target = null;
  for (const ticket of state.tickets) {
    if (ticket.recipeId !== state.pass.recipeId) continue;
    if (!target || ticket.patience < target.patience) target = ticket;
  }
  if (!target) return;

  const recipe = RECIPE_BY_ID.get(target.recipeId);
  const quality = state.pass.quality;
  const qualityMultiplier = CONFIG.quality[quality].multiplier;
  const comboMultiplier = 1 + Math.min(state.combo, CONFIG.comboCap) * CONFIG.comboStep;
  const tip = Math.round(recipe.reward * 0.5 * (target.patience / target.maxPatience));
  const earned = Math.round(recipe.reward * qualityMultiplier * comboMultiplier) + tip;

  state.score += earned;
  state.combo += 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  state.stats.served += 1;
  state.stats.earned += earned;
  state.dayStats.served += 1;
  state.dayStats.earned += earned;
  if (quality === 'perfect') {
    state.stats.perfect += 1;
    state.dayStats.perfect += 1;
  }

  state.tickets = state.tickets.filter((t) => t.id !== target.id);
  state.ordersResolved += 1;
  state.pass = null;
  emit(state, 'served', {
    recipeId: recipe.id,
    quality,
    earned,
    tip,
    combo: state.combo,
  });
}

function checkDayEnd(state) {
  if (state.ordersSpawned < state.dayCfg.orders) return;
  if (state.tickets.length > 0) return;
  state.phase = 'dayEnd';
  emit(state, 'dayEnd', { day: state.day, ...state.dayStats });
}

// ---------------------------------------------------------------------------
// Read-only helpers for the UI
// ---------------------------------------------------------------------------

export function panStatus(state) {
  const pan = state.pan;
  if (state.pass) return { kind: 'pass', text: 'Plated - waiting for an order' };
  if (pan.items.length === 0) return { kind: 'empty', text: 'Pick ingredients to start a dish' };
  if (!pan.recipeId) return { kind: 'unknown', text: 'Not a dish anyone orders - clear the pan' };
  const recipe = RECIPE_BY_ID.get(pan.recipeId);
  if (!pan.cooking) return { kind: 'ready', text: `${recipe.name} - hold to heat`, recipe };
  return { kind: 'cooking', text: `Searing ${recipe.name}`, recipe };
}

export { RECIPES, RECIPE_BY_ID };
