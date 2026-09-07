import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG,
  act,
  bandFor,
  createGame,
  dayConfig,
  panBand,
  takeEvents,
  update,
} from '../src/engine.js';
import { RECIPE_BY_ID, TIERS, bandSpeed, matchRecipe, isViablePrefix } from '../src/recipes.js';
import { cookMany, heatController } from './controllers.mjs';

function playing(opts = {}) {
  const state = createGame({ seed: opts.seed ?? 1, day: opts.day ?? 1 });
  act(state, { type: 'start', day: opts.day ?? 1 });
  takeEvents(state);
  return state;
}

function run(state, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) update(state, dt);
}

// --- recipe matching -------------------------------------------------------

test('a pan matches a recipe regardless of the order things went in', () => {
  assert.equal(matchRecipe(['egg', 'tomato']).id, 'tomato_egg');
  assert.equal(matchRecipe(['tomato', 'egg']).id, 'tomato_egg');
  assert.equal(matchRecipe(['noodles', 'mushroom', 'egg']).id, 'house_ramen');
});

test('a combination nobody orders matches nothing', () => {
  assert.equal(matchRecipe(['tomato', 'tomato']), null);
  assert.equal(matchRecipe(['cheese', 'shrimp']), null);
  assert.equal(matchRecipe([]), null);
});

test('a partial pan is reported as still viable, a doomed one is not', () => {
  assert.equal(isViablePrefix(['noodles']), true);
  assert.equal(isViablePrefix(['noodles', 'egg']), true);
  assert.equal(isViablePrefix(['cheese', 'shrimp']), false);
});

// --- pan handling ----------------------------------------------------------

test('adding ingredients names the dish once the set is complete', () => {
  const state = playing();
  act(state, { type: 'add', id: 'beef' });
  assert.equal(state.pan.recipeId, null);
  act(state, { type: 'add', id: 'onion' });
  assert.equal(state.pan.recipeId, 'beef_onion');
});

test('the pan is locked once it is on the heat', () => {
  const state = playing();
  act(state, { type: 'add', id: 'beef' });
  act(state, { type: 'add', id: 'onion' });
  act(state, { type: 'heat', on: true });
  act(state, { type: 'add', id: 'cheese' });
  assert.deepEqual(state.pan.items, ['beef', 'onion']);
});

test('heat does nothing until the pan holds a real dish', () => {
  const state = playing();
  act(state, { type: 'add', id: 'beef' });
  act(state, { type: 'heat', on: true });
  run(state, 1);
  assert.equal(state.pan.cooking, false);
  assert.equal(state.pan.heat, 0);
});

test('trashing clears the pan, then clears the pass', () => {
  const state = playing();
  act(state, { type: 'add', id: 'beef' });
  act(state, { type: 'trash' });
  assert.deepEqual(state.pan.items, []);
  state.pass = { recipeId: 'beef_onion', quality: 'good', platedAt: 0 };
  act(state, { type: 'trash' });
  assert.equal(state.pass, null);
});

// --- the heat band ---------------------------------------------------------

test('the band drifts but always stays reachable on the dial', () => {
  for (const recipe of [RECIPE_BY_ID.get('tomato_egg'), RECIPE_BY_ID.get('fire_noodles')]) {
    for (let t = 0; t < 12; t += 0.05) {
      const band = bandFor(recipe, t);
      assert.ok(band.lo > 0.05, `lo ${band.lo} too low at t=${t}`);
      assert.ok(band.hi < 0.95, `hi ${band.hi} too high at t=${t}`);
      assert.ok(band.hi > band.lo);
    }
  }
});

test('no band outruns the needle that has to chase it', () => {
  // A target moving faster than the controlled variable's slew rate cannot be
  // tracked at all: the dish then fails for a perfect player, which reads as
  // brutal tuning rather than as an impossible task.
  for (const tier of Object.keys(TIERS).map(Number)) {
    const speed = bandSpeed(tier);
    assert.ok(
      speed < CONFIG.heatFall * 0.8,
      `tier ${tier} band drifts at ${speed.toFixed(3)}/s against a slew rate of ${CONFIG.heatFall}/s`,
    );
  }
});

test('a flawless player never fails, at any tier, on any day', () => {
  for (const recipeId of ['tomato_egg', 'house_ramen', 'fire_noodles']) {
    for (const day of [1, 5, 12]) {
      const tally = cookMany({
        attempts: 12,
        recipe: RECIPE_BY_ID.get(recipeId),
        makeState: (i) => playing({ seed: 500 + i, day }),
        makeController: () => heatController({ interval: 1 / 120, errorRate: 0, rng: () => 1 }),
      });
      assert.equal(
        tally.failureRate,
        0,
        `${recipeId} on day ${day} beat a perfect player ${tally.failureRate * 100}% of the time`,
      );
    }
  }
});

test('harder tiers get a narrower band', () => {
  const easy = bandFor(RECIPE_BY_ID.get('tomato_egg'), 0);
  const hard = bandFor(RECIPE_BY_ID.get('fire_noodles'), 0);
  assert.ok(hard.hi - hard.lo < easy.hi - easy.lo);
});

// --- cooking outcomes ------------------------------------------------------

test('a dish parked above the band burns, and burning escalates', () => {
  const state = playing();
  act(state, { type: 'add', id: 'tomato' });
  act(state, { type: 'add', id: 'egg' });
  act(state, { type: 'heat', on: true });

  let burnt = false;
  for (let t = 0; t < CONFIG.cookMax && !burnt; t += 1 / 60) {
    update(state, 1 / 60);
    burnt = takeEvents(state).some((e) => e.type === 'burnt');
  }
  assert.ok(burnt, 'holding maximum heat should ruin the dish');
});

test('a dish nobody heats is ruined by the hard cap, with its own outcome', () => {
  const state = playing();
  act(state, { type: 'add', id: 'tomato' });
  act(state, { type: 'add', id: 'egg' });
  act(state, { type: 'heat', on: true });
  act(state, { type: 'heat', on: false });
  takeEvents(state);

  const seen = [];
  for (let t = 0; t < CONFIG.cookMax + 1; t += 1 / 60) {
    update(state, 1 / 60);
    seen.push(...takeEvents(state).map((e) => e.type));
  }
  assert.ok(seen.includes('ruined'), 'the cook clock should time the dish out');
  assert.ok(!seen.includes('burnt'), 'a cold pan is not a burnt pan');
});

test('a dish cooked cleanly plates as perfect and pays out', () => {
  const state = playing();
  // Put a matching customer on the rail first.
  state.tickets = [{
    id: 99, recipeId: 'tomato_egg', patience: 25, maxPatience: 30, placedAt: 0,
  }];
  const controller = heatController({ interval: 1 / 60, errorRate: 0, rng: () => 1 });
  act(state, { type: 'add', id: 'tomato' });
  act(state, { type: 'add', id: 'egg' });
  act(state, { type: 'heat', on: true });
  takeEvents(state);

  const seen = [];
  for (let t = 0; t < 20 && !seen.some((e) => e.type === 'served'); t += 1 / 60) {
    act(state, { type: 'heat', on: controller(state, 1 / 60) });
    update(state, 1 / 60);
    seen.push(...takeEvents(state));
  }
  const served = seen.find((e) => e.type === 'served');
  assert.ok(served, 'a clean cook should reach the customer');
  assert.equal(served.quality, 'perfect');
  assert.ok(served.earned > 0);
  assert.ok(state.score > 0);
});

// --- balance ---------------------------------------------------------------
//
// A skill test is only a game if it can be failed. These assert the shape of the
// difficulty curve rather than exact numbers, so tuning stays free to move.

const BALANCE_ATTEMPTS = 300;

function balanceFor({ recipeId, day, interval, errorRate }) {
  let seed = 1;
  return cookMany({
    attempts: BALANCE_ATTEMPTS,
    recipe: RECIPE_BY_ID.get(recipeId),
    makeState: (i) => playing({ seed: 1000 + i, day }),
    makeController: () => {
      // A deterministic but decorrelated stream per attempt.
      let a = (seed += 0x9e3779b9) >>> 0;
      const rng = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return heatController({ interval, errorRate, rng });
    },
  });
}

test('a sharp player clears an easy dish almost every time, and quickly', () => {
  const tally = balanceFor({ recipeId: 'tomato_egg', day: 1, interval: 0.07, errorRate: 0.04 });
  assert.ok(tally.failureRate < 0.1, `sharp player failed ${(tally.failureRate * 100).toFixed(1)}%`);
  assert.ok(tally.meanTime < 9, `a clean cook took ${tally.meanTime.toFixed(1)}s on average`);
});

test('a sloppy player fails sometimes -- but not always', () => {
  const tally = balanceFor({ recipeId: 'house_ramen', day: 3, interval: 0.26, errorRate: 0.3 });
  assert.ok(
    tally.failureRate > 0.05,
    `a deliberately bad player never failed (${(tally.failureRate * 100).toFixed(1)}%) -- the meter has no fail state`,
  );
  assert.ok(
    tally.failureRate < 0.9,
    `a bad player failed ${(tally.failureRate * 100).toFixed(1)}% -- unwinnable, not hard`,
  );
});

test('the same player finds a tier 3 dish harder than a tier 1 dish', () => {
  const opts = { interval: 0.16, errorRate: 0.18 };
  const easy = balanceFor({ recipeId: 'tomato_egg', day: 4, ...opts });
  const hard = balanceFor({ recipeId: 'fire_noodles', day: 4, ...opts });
  assert.ok(
    hard.failureRate > easy.failureRate,
    `tier 3 failed ${hard.failureRate} vs tier 1 ${easy.failureRate}`,
  );
});

test('later days are harsher than earlier ones for the same player', () => {
  const opts = { recipeId: 'tomato_egg', interval: 0.18, errorRate: 0.2 };
  const early = balanceFor({ ...opts, day: 1 });
  const late = balanceFor({ ...opts, day: 9 });
  assert.ok(late.failureRate >= early.failureRate);
  assert.ok(dayConfig(9).patience < dayConfig(1).patience);
  assert.ok(dayConfig(9).spawnEvery < dayConfig(1).spawnEvery);
});

// --- service loop ----------------------------------------------------------

test('orders arrive, wait, then walk out and cost a life', () => {
  const state = playing({ seed: 7 });
  run(state, 3);
  assert.ok(state.tickets.length > 0, 'the first order should be on the rail');

  const before = state.lives;
  run(state, dayConfig(1).patience + 5);
  assert.ok(state.lives < before, 'an ignored customer should cost a life');
  assert.ok(state.stats.walkouts > 0);
});

test('running out of lives ends the game', () => {
  const state = playing({ seed: 11 });
  run(state, 400);
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.lives, 0);
});

test('a plated dish waits on the pass until someone orders it', () => {
  const state = playing({ seed: 3 });
  state.tickets = [];
  state.pass = { recipeId: 'beef_onion', quality: 'good', platedAt: 0 };
  update(state, 1 / 60);
  assert.ok(state.pass, 'nothing to serve it to yet');

  state.tickets = [{ id: 1, recipeId: 'beef_onion', patience: 10, maxPatience: 20, placedAt: 0 }];
  update(state, 1 / 60);
  assert.equal(state.pass, null);
  assert.equal(state.tickets.length, 0);
  assert.ok(state.score > 0);
});

test('a dish goes to whichever matching customer is closest to leaving', () => {
  const state = playing({ seed: 3 });
  state.tickets = [
    { id: 1, recipeId: 'beef_onion', patience: 18, maxPatience: 20, placedAt: 0 },
    { id: 2, recipeId: 'beef_onion', patience: 4, maxPatience: 20, placedAt: 0 },
  ];
  state.pass = { recipeId: 'beef_onion', quality: 'good', platedAt: 0 };
  update(state, 1 / 60);
  assert.deepEqual(state.tickets.map((t) => t.id), [1]);
});

test('a served day ends and the next one is busier', () => {
  const state = playing({ seed: 5 });
  state.dayCfg = { ...state.dayCfg, orders: 1 };
  run(state, 2);
  state.tickets = [];
  state.ordersSpawned = 1;
  update(state, 1 / 60);
  assert.equal(state.phase, 'dayEnd');

  const livesBefore = state.lives;
  act(state, { type: 'nextDay' });
  assert.equal(state.phase, 'playing');
  assert.equal(state.day, 2);
  assert.ok(state.lives >= livesBefore, 'surviving a day should not cost a life');
  assert.ok(state.dayCfg.orders > dayConfig(1).orders - 1);
});

// --- determinism and frame-rate independence -------------------------------

test('the same seed produces the same service', () => {
  const a = playing({ seed: 42 });
  const b = playing({ seed: 42 });
  run(a, 30);
  run(b, 30);
  assert.deepEqual(
    a.tickets.map((t) => [t.recipeId, t.patience.toFixed(6)]),
    b.tickets.map((t) => [t.recipeId, t.patience.toFixed(6)]),
  );
});

test('the simulation advances the same amount at 30, 60 and 144 Hz', () => {
  const results = [30, 60, 144].map((hz) => {
    const dt = 1 / hz;
    const state = playing({ seed: 21 });
    act(state, { type: 'add', id: 'tomato' });
    act(state, { type: 'add', id: 'egg' });
    act(state, { type: 'heat', on: true });
    // Same wall-clock interval, same input, different step size.
    const steps = Math.round(2 / dt);
    for (let i = 0; i < steps; i += 1) update(state, dt);
    return { hz, time: state.time, sear: state.pan.sear, burn: state.pan.burn };
  });

  for (const r of results) {
    assert.ok(r.sear > 0 || r.burn > 0, `nothing simulated at ${r.hz}Hz -- the loop stalled`);
    assert.ok(Math.abs(r.time - 2) < 0.02, `${r.hz}Hz advanced ${r.time}s of game time`);
  }
  const spread = Math.max(...results.map((r) => r.burn)) - Math.min(...results.map((r) => r.burn));
  assert.ok(spread < 0.05, `burn differed by ${spread} across frame rates`);
});

test('a non-positive delta is ignored rather than rewinding the simulation', () => {
  const state = playing({ seed: 4 });
  run(state, 5);
  const snapshot = { time: state.time, tickets: state.tickets.length };
  update(state, 0);
  update(state, -1);
  update(state, NaN);
  assert.equal(state.time, snapshot.time);
  assert.equal(state.tickets.length, snapshot.tickets);
});
