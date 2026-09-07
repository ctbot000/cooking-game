// Simulated players used by the balance tests.
//
// The important detail: error is sampled *per decision*, not per tick. A miss
// chance rolled every frame is an 8ms wobble, not a handicap, and it makes a
// punishing game look trivial.

import { act, panBand, update, takeEvents } from '../src/engine.js';

/**
 * A bang-bang heat controller. It re-decides every `interval` seconds, and on an
 * `errorRate` fraction of those decisions it does the wrong thing and commits to
 * it until the next decision point.
 */
export function heatController({ interval, errorRate, rng = Math.random }) {
  let untilNextDecision = 0;
  let holding = false;
  return function step(state, dt) {
    untilNextDecision -= dt;
    if (untilNextDecision > 0) return holding;
    untilNextDecision = interval;
    const band = panBand(state);
    if (!band) {
      holding = false;
      return holding;
    }
    const wants = state.pan.heat < band.centre;
    holding = rng() < errorRate ? !wants : wants;
    return holding;
  };
}

/** Cook one dish start to finish. Returns how it ended. */
export function cookOnce(state, recipe, controller, { dt = 1 / 60, maxSeconds = 45 } = {}) {
  for (const id of recipe.needs) act(state, { type: 'add', id });
  act(state, { type: 'heat', on: true });
  takeEvents(state);

  let elapsed = 0;
  while (elapsed < maxSeconds) {
    act(state, { type: 'heat', on: controller(state, dt) });
    update(state, dt);
    for (const event of takeEvents(state)) {
      if (event.type === 'plated') return { outcome: 'plated', quality: event.quality, elapsed };
      if (event.type === 'burnt') return { outcome: 'burnt', elapsed };
      if (event.type === 'ruined') return { outcome: 'ruined', elapsed };
    }
    elapsed += dt;
  }
  return { outcome: 'stalled', elapsed };
}

/** Run `attempts` cooks and tally the outcomes. */
export function cookMany({ attempts, makeState, recipe, makeController, dt }) {
  const tally = { plated: 0, burnt: 0, ruined: 0, stalled: 0, perfect: 0, totalTime: 0 };
  for (let i = 0; i < attempts; i += 1) {
    const state = makeState(i);
    const result = cookOnce(state, recipe, makeController(i), { dt });
    tally[result.outcome] += 1;
    tally.totalTime += result.elapsed;
    if (result.quality === 'perfect') tally.perfect += 1;
  }
  tally.failureRate = (tally.burnt + tally.ruined + tally.stalled) / attempts;
  tally.meanTime = tally.totalTime / attempts;
  return tally;
}
