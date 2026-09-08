// Skillet Rush -- everything that touches the browser: rendering, input, sound.
// All the rules live in engine.js; this file only reads state and pushes actions.

import { act, createGame, panBand, panStatus, takeEvents, update } from './engine.js';
import { INGREDIENTS, INGREDIENT_BY_ID, RECIPE_BY_ID } from './recipes.js';
import { createKitchen } from './scene.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  day: $('hud-day'),
  score: $('hud-score'),
  combo: $('hud-combo'),
  lives: $('hud-lives'),
  rail: $('rail'),
  railEmpty: $('rail-empty'),
  pan: $('pan'),
  stage: $('stage'),
  panItems: $('pan-items'),
  panStatus: $('pan-status'),
  pass: $('pass'),
  trash: $('btn-trash'),
  dialBand: $('dial-band'),
  dialNeedle: $('dial-needle'),
  sear: $('meter-sear'),
  burn: $('meter-burn'),
  cook: $('btn-cook'),
  shelf: $('shelf'),
  toasts: $('toasts'),
  announcer: $('announcer'),
  overlay: $('overlay'),
  overlayTitle: $('overlay-title'),
  overlayBody: $('overlay-body'),
  overlayAction: $('overlay-action'),
  overlayFoot: $('overlay-foot'),
  sound: $('btn-sound'),
  pause: $('btn-pause'),
};

const state = createGame({ seed: (Math.random() * 2 ** 32) >>> 0 });
let paused = false;

// ---------------------------------------------------------------- records
//
// The in-memory copy is the source of truth. localStorage throws in private
// modes and with cookies blocked, and a swallowed write there would otherwise
// make the next read contradict what we just displayed.

const STORE_KEY = 'skillet-rush/records/v1';
const records = { best: 0, bestDay: 1 };

(function loadRecords() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.best === 'number') records.best = parsed.best;
    if (typeof parsed?.bestDay === 'number') records.bestDay = parsed.bestDay;
  } catch {
    /* no persistence available; the session still keeps its own record */
  }
})();

function saveRecords() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
  } catch {
    /* persistence is the only thing lost */
  }
}

// ------------------------------------------------------------------ sound

let audio = null;
let muted = false;
let sizzle = null;

function ensureAudio() {
  if (audio || muted) return audio;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audio = new Ctx();
    const frames = audio.sampleRate * 2;
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = audio.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600;
    filter.Q.value = 0.7;
    const gain = audio.createGain();
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(audio.destination);
    source.start();
    sizzle = gain;
  } catch {
    audio = null;
  }
  return audio;
}

function beep({ freq, to = freq, dur = 0.12, type = 'triangle', gain = 0.09 }) {
  const ctx = ensureAudio();
  if (!ctx || muted) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + dur);
  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(gain, now + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

const SOUNDS = {
  add: () => beep({ freq: 520, to: 700, dur: 0.07, gain: 0.05 }),
  reject: () => beep({ freq: 150, to: 110, dur: 0.09, type: 'square', gain: 0.04 }),
  order: () => beep({ freq: 880, to: 1180, dur: 0.09, gain: 0.05 }),
  served: () => { beep({ freq: 660, dur: 0.1 }); setTimeout(() => beep({ freq: 990, dur: 0.16 }), 90); },
  perfect: () => {
    [660, 880, 1320].forEach((f, i) => setTimeout(() => beep({ freq: f, dur: 0.16, gain: 0.08 }), i * 80));
  },
  burnt: () => beep({ freq: 220, to: 60, dur: 0.4, type: 'sawtooth', gain: 0.07 }),
  walkout: () => beep({ freq: 400, to: 130, dur: 0.35, type: 'sine', gain: 0.07 }),
  trash: () => beep({ freq: 300, to: 180, dur: 0.1, type: 'square', gain: 0.04 }),
  dayEnd: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep({ freq: f, dur: 0.25 }), i * 110)),
  gameOver: () => [440, 370, 294, 220].forEach((f, i) => setTimeout(() => beep({ freq: f, dur: 0.3, type: 'sine' }), i * 170)),
};

function updateSizzle() {
  if (!sizzle || !audio) return;
  const pan = state.pan;
  const target = !muted && pan.cooking && running() ? 0.015 + 0.05 * pan.heat : 0;
  sizzle.gain.setTargetAtTime(target, audio.currentTime, 0.08);
}

function setMuted(next) {
  muted = next;
  el.sound.textContent = muted ? '🔇' : '🔊';
  el.sound.setAttribute('aria-pressed', String(!muted));
  if (muted && sizzle && audio) sizzle.gain.setTargetAtTime(0, audio.currentTime, 0.05);
}

// ------------------------------------------------------------------ shelf

for (const ingredient of INGREDIENTS) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shelf-btn';
  button.dataset.id = ingredient.id;
  button.innerHTML =
    `<span class="shelf-emoji" aria-hidden="true">${ingredient.emoji}</span>` +
    `<span class="shelf-name">${ingredient.name}</span>` +
    `<span class="shelf-key" aria-hidden="true">${ingredient.key}</span>`;
  button.setAttribute('aria-label', `Add ${ingredient.name} (key ${ingredient.key})`);
  button.addEventListener('click', () => addIngredient(ingredient.id));
  li.append(button);
  el.shelf.append(li);
}

const shelfButtons = new Map(
  [...el.shelf.querySelectorAll('.shelf-btn')].map((b) => [b.dataset.id, b]),
);

// ----------------------------------------------------------------- toasts

const liveToasts = [];

function toast(text, tone = 'good') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.tone = tone;
  node.textContent = text;
  el.toasts.append(node);
  // Retire on wall-clock time: animation events never arrive in a hidden tab,
  // so an animationend-only cleanup can leave the overlay stuck on screen.
  liveToasts.push({ node, die: performance.now() + 2100 });
  while (liveToasts.length > 4) liveToasts.shift().node.remove();
}

function sweepToasts(now) {
  for (let i = liveToasts.length - 1; i >= 0; i -= 1) {
    if (now >= liveToasts[i].die) liveToasts.splice(i, 1)[0].node.remove();
  }
}

function announce(text) {
  el.announcer.textContent = text;
}

// --------------------------------------------------------------- overlays

let overlayAction = null;

function showOverlay({ title, body, actionLabel, action, foot = '' }) {
  el.overlayTitle.textContent = title;
  el.overlayBody.innerHTML = body;
  el.overlayAction.textContent = actionLabel;
  el.overlayFoot.textContent = foot;
  overlayAction = action;
  el.overlay.hidden = false;
  el.overlayAction.focus({ preventScroll: true });
}

function hideOverlay() {
  el.overlay.hidden = true;
  overlayAction = null;
}

el.overlayAction.addEventListener('click', () => {
  const run = overlayAction;
  hideOverlay();
  if (run) run();
});

/** Promote the current run to the record if it beats it. Returns true if it did. */
function noteRecord() {
  if (state.score <= records.best) return false;
  records.best = state.score;
  records.bestDay = state.day;
  saveRecords();
  return true;
}

const recordLine = () =>
  records.best > 0 ? `Best so far: ${records.best} on day ${records.bestDay}.` : '';

function titleScreen() {
  showOverlay({
    title: '🍳 Skillet Rush',
    body: `
      <p>You are the whole kitchen. Orders land on the rail; you have one pan.</p>
      <ul>
        <li><strong>Build the dish.</strong> Click the shelf, or press <kbd>1</kbd>–<kbd>9</kbd>. Order does not matter, the exact set does.</li>
        <li><strong>Ride the heat.</strong> Hold <kbd>Space</kbd> (or the heat button) to raise the needle, release to let it fall. Keep it inside the drifting green band.</li>
        <li><strong>Above the band it chars</strong>, and charring gets worse the longer you cook. Below it, nothing happens at all.</li>
        <li>A finished dish goes to whoever has been waiting longest for it. <kbd>⌫</kbd> clears a mistake.</li>
      </ul>
      <p>Three walkouts and service is over.</p>`,
    actionLabel: 'Start service',
    action: () => {
      act(state, { type: 'start', day: 1 });
      takeEvents(state);
    },
    foot: recordLine(),
  });
}

function tallyList(stats) {
  return `<ul class="tally">
    <li><b>${stats.served}</b><span>served</span></li>
    <li><b>${stats.perfect}</b><span>perfect</span></li>
    <li><b>${stats.burnt}</b><span>burnt</span></li>
    <li><b>${stats.walkouts}</b><span>walked out</span></li>
  </ul>`;
}

function dayEndScreen(day, stats) {
  noteRecord();
  showOverlay({
    title: `Day ${day} closed`,
    body: `<p>You took <strong>${stats.earned}</strong> today.</p>${tallyList(stats)}
      <p>Day ${day + 1} brings more orders, shorter tempers and a tighter band.
      One customer's patience comes back.</p>`,
    actionLabel: `Open day ${day + 1}`,
    action: () => {
      act(state, { type: 'nextDay' });
      takeEvents(state);
    },
    foot: recordLine(),
  });
}

function gameOverScreen() {
  const beaten = noteRecord();
  showOverlay({
    title: beaten ? 'New record!' : 'Service over',
    body: `<p>You made it to <strong>day ${state.day}</strong> with
      <strong>${state.score}</strong> in the till.</p>
      ${tallyList(state.stats)}
      <p>Longest streak: <strong>${state.bestCombo}</strong> dishes without a slip.</p>`,
    actionLabel: 'Cook again',
    action: () => {
      state.seed = (Math.random() * 2 ** 32) >>> 0;
      act(state, { type: 'start', day: 1 });
      takeEvents(state);
    },
    foot: recordLine(),
  });
}

function pauseScreen() {
  showOverlay({
    title: 'Paused',
    body: '<p>The pan is off the heat. Nothing is burning.</p>',
    actionLabel: 'Back to it',
    action: () => { paused = false; },
    foot: 'Esc also resumes.',
  });
}

function togglePause() {
  if (state.phase !== 'playing') return;
  if (paused) {
    paused = false;
    hideOverlay();
  } else {
    paused = true;
    setHeat(false);
    pauseScreen();
  }
}

const running = () => state.phase === 'playing' && !paused;

// ------------------------------------------------------------------ input

function addIngredient(id) {
  if (!running()) return;
  ensureAudio();
  act(state, { type: 'add', id });
}

function setHeat(on) {
  if (on && !running()) return;
  ensureAudio();
  act(state, { type: 'heat', on });
  el.cook.classList.toggle('on', !!on && !!state.pan.recipeId);
}

el.cook.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  el.cook.setPointerCapture?.(event.pointerId);
  setHeat(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  el.cook.addEventListener(type, () => setHeat(false));
}
el.cook.addEventListener('contextmenu', (event) => event.preventDefault());
el.trash.addEventListener('click', () => { if (running()) act(state, { type: 'trash' }); });
el.sound.addEventListener('click', () => setMuted(!muted));
el.pause.addEventListener('click', togglePause);

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    togglePause();
    return;
  }
  // While a dialog is up, leave the keyboard to its own button: Enter and Space
  // should activate it natively rather than reaching the kitchen.
  if (!el.overlay.hidden) return;

  if (event.key === ' ' || event.key === 'Spacebar') {
    // preventDefault is the right tool here: it stops the page scrolling *and*
    // stops a focused shelf button firing its own click on the same press.
    event.preventDefault();
    if (!event.repeat) setHeat(true);
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    if (running()) act(state, { type: 'trash' });
    return;
  }
  if (event.key === 'm' || event.key === 'M') {
    setMuted(!muted);
    return;
  }
  const ingredient = INGREDIENTS.find((i) => i.key === event.key);
  if (ingredient) {
    event.preventDefault();
    addIngredient(ingredient.id);
  }
});

document.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    setHeat(false);
  }
});

window.addEventListener('blur', () => setHeat(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    setHeat(false);
    if (state.phase === 'playing' && !paused) togglePause();
  } else {
    lastFrame = 0; // and, with it, the accumulator -- see the loop below
  }
});

// -------------------------------------------------------------- rendering

const ticketNodes = new Map();

function renderTickets() {
  const seen = new Set();
  const panRecipe = state.pan.recipeId;

  state.tickets.forEach((ticket, index) => {
    seen.add(ticket.id);
    let node = ticketNodes.get(ticket.id);
    if (!node) {
      const recipe = RECIPE_BY_ID.get(ticket.recipeId);
      node = document.createElement('li');
      node.className = 'ticket';
      node.innerHTML =
        `<span class="ticket-dish" aria-hidden="true">${recipe.emoji}</span>` +
        `<span class="ticket-name">${recipe.name}</span>` +
        `<span class="ticket-needs" aria-hidden="true">${recipe.needs
          .map((id) => INGREDIENT_BY_ID.get(id).emoji)
          .join(' ')}</span>` +
        '<span class="ticket-bar"><span class="ticket-fill"></span></span>';
      node.setAttribute(
        'aria-label',
        `${recipe.name}: ${recipe.needs.map((id) => INGREDIENT_BY_ID.get(id).name).join(', ')}`,
      );
      node.dataset.fill = '';
      ticketNodes.set(ticket.id, node);
      el.rail.append(node);
    }

    const left = Math.max(0, ticket.patience / ticket.maxPatience);
    node.querySelector('.ticket-fill').style.transform = `scaleX(${left})`;
    const mood = left > 0.5 ? 'calm' : left > 0.25 ? 'warn' : 'panic';
    if (node.dataset.mood !== mood) node.dataset.mood = mood;
    node.classList.toggle('cookable', panRecipe === ticket.recipeId);
    if (node.style.order !== String(index)) node.style.order = String(index);
  });

  for (const [id, node] of ticketNodes) {
    if (seen.has(id)) continue;
    ticketNodes.delete(id);
    // Freeze where it sits before lifting it out of the grid, so it animates
    // away from its own cell while the remaining tickets close the gap.
    const railBox = el.rail.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
    node.style.left = `${box.left - railBox.left}px`;
    node.style.top = `${box.top - railBox.top}px`;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }

  el.railEmpty.hidden = state.tickets.length > 0;
}

let panSignature = '';

function renderPan() {
  const pan = state.pan;
  const signature = pan.items.join(',');
  if (signature !== panSignature) {
    panSignature = signature;
    el.panItems.replaceChildren(
      ...pan.items.map((id) => {
        const li = document.createElement('li');
        li.textContent = INGREDIENT_BY_ID.get(id).emoji;
        li.title = INGREDIENT_BY_ID.get(id).name;
        return li;
      }),
    );
  }

  const status = panStatus(state);
  if (el.panStatus.textContent !== status.text) el.panStatus.textContent = status.text;
  el.panStatus.dataset.kind = status.kind;
  el.pan.dataset.cooking = String(pan.cooking);
  el.pan.dataset.heat = pan.cooking && pan.heat > 0.6 ? 'hot' : 'warm';

  if (state.pass) {
    const recipe = RECIPE_BY_ID.get(state.pass.recipeId);
    el.pass.textContent = `On the pass: ${recipe.emoji} ${recipe.name} — nobody has ordered it`;
    el.pass.hidden = false;
  } else {
    el.pass.hidden = true;
  }

  el.trash.disabled = !running() || (pan.items.length === 0 && !state.pass);
}

function renderDial() {
  const band = panBand(state);
  const pan = state.pan;

  if (band) {
    el.dialBand.classList.remove('off');
    el.dialBand.style.left = `${band.lo * 100}%`;
    el.dialBand.style.width = `${(band.hi - band.lo) * 100}%`;
  } else {
    el.dialBand.classList.add('off');
    el.dialBand.style.left = '40%';
    el.dialBand.style.width = '20%';
  }

  el.dialNeedle.style.left = `${pan.heat * 100}%`;
  const inBand = !!band && pan.heat >= band.lo && pan.heat <= band.hi;
  const tooHot = !!band && pan.heat > band.hi;
  el.dialNeedle.classList.toggle('in-band', inBand && pan.cooking);
  el.dialNeedle.classList.toggle('too-hot', tooHot && pan.cooking);

  el.sear.style.width = `${pan.sear * 100}%`;
  el.burn.style.width = `${pan.burn * 100}%`;
  el.cook.disabled = !running() || !pan.recipeId;
}

function renderHud() {
  setText(el.day, String(state.day));
  setText(el.score, String(state.score));
  setText(el.combo, state.combo > 1 ? `×${state.combo}` : '—');
  const hearts = '♥'.repeat(Math.max(0, state.lives)) || '—';
  setText(el.lives, hearts);
}

function setText(node, value) {
  if (node.textContent === value) return;
  node.textContent = value;
  const gauge = node.closest('.gauge');
  if (gauge) {
    gauge.classList.remove('pop');
    void gauge.offsetWidth; // restart the animation
    gauge.classList.add('pop');
  }
}

function renderShelf() {
  const wanted = new Set();
  for (const ticket of state.tickets) {
    for (const id of RECIPE_BY_ID.get(ticket.recipeId).needs) wanted.add(id);
  }
  const locked = !running() || state.pan.cooking || state.pan.items.length >= 4;
  for (const [id, button] of shelfButtons) {
    button.disabled = locked;
    button.classList.toggle('wanted', wanted.has(id) && !locked);
  }
}

function render() {
  renderHud();
  renderTickets();
  renderPan();
  renderDial();
  renderShelf();
  updateSizzle();
}

// ------------------------------------------------------------------ events

function handleEvents(events) {
  for (const event of events) {
    switch (event.type) {
      case 'add':
        SOUNDS.add();
        break;
      case 'reject':
        SOUNDS.reject();
        break;
      case 'order': {
        const recipe = RECIPE_BY_ID.get(event.recipeId);
        SOUNDS.order();
        announce(`New order: ${recipe.name}`);
        break;
      }
      case 'trash':
        SOUNDS.trash();
        break;
      case 'plated':
        if (state.pass) {
          const recipe = RECIPE_BY_ID.get(event.recipeId);
          toast(`Nobody ordered ${recipe.name}`, 'bad');
        }
        break;
      case 'served': {
        const recipe = RECIPE_BY_ID.get(event.recipeId);
        const label = event.quality === 'perfect' ? 'Perfect' : event.quality === 'good' ? 'Served' : 'Scraped by';
        const streak = event.combo > 2 ? ` ·  ×${event.combo}` : '';
        toast(`${label}! ${recipe.name} +${event.earned}${streak}`, event.quality === 'perfect' ? 'great' : 'good');
        announce(`${label}: ${recipe.name}, plus ${event.earned}`);
        (event.quality === 'perfect' ? SOUNDS.perfect : SOUNDS.served)();
        break;
      }
      case 'burnt':
        toast('Burnt to the pan', 'bad');
        announce('The dish burnt');
        SOUNDS.burnt();
        break;
      case 'ruined':
        toast('Too slow — the pan gave up', 'bad');
        announce('The dish was ruined');
        SOUNDS.burnt();
        break;
      case 'walkout': {
        const recipe = RECIPE_BY_ID.get(event.recipeId);
        toast(`Walked out — ${recipe.name}`, 'bad');
        announce(`A customer left. ${event.lives} patience left.`);
        SOUNDS.walkout();
        break;
      }
      case 'dayEnd':
        SOUNDS.dayEnd();
        dayEndScreen(event.day, state.dayStats);
        break;
      case 'gameOver':
        SOUNDS.gameOver();
        gameOverScreen();
        break;
      default:
        break;
    }
  }

  if (state.phase === 'playing') noteRecord();
}

// -------------------------------------------------------------- game loop

// --------------------------------------------------------- the 3D kitchen
//
// Purely presentational: it reads engine state and renders it. If three.js or
// WebGL is unavailable it stays null for the whole session and the flat pan
// underneath carries on doing the job.

let kitchen = null;

function fitKitchen() {
  if (!kitchen) return;
  const box = el.stage.getBoundingClientRect();
  kitchen.resize(box.width, box.height);
}

createKitchen(el.stage).then((made) => {
  if (!made) return;
  kitchen = made;
  el.pan.classList.add('is-3d');
  fitKitchen();
}).catch(() => {
  /* stay flat */
});

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(fitKitchen).observe(el.pan);
} else {
  window.addEventListener('resize', fitKitchen);
}

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.25;
const MAX_STEPS = 60;

let lastFrame = 0;
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);

  // The timestamp baseline and the accumulator are one piece of state: reset
  // either alone and the fixed step either double-counts or stalls outright.
  if (!lastFrame) {
    lastFrame = now;
    accumulator = 0;
  }
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (!(dt > 0)) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

  if (running()) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      update(state, FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }
    if (steps >= MAX_STEPS) accumulator = 0;
    handleEvents(takeEvents(state));
  } else {
    accumulator = 0;
    takeEvents(state);
  }

  render();
  if (kitchen) kitchen.sync(state, now, dt);
  sweepToasts(now);
}

// A deterministic handle for tests and for driving the game without frames.
window.skilletRush = {
  state,
  act: (action) => act(state, action),
  step(seconds, dt = FIXED_DT) {
    // Drives the scene from a virtual wall clock as well, so the particle
    // systems -- which expire on time, not on frames -- advance in step with
    // the simulation even where no animation frames are being delivered.
    let clock = performance.now();
    let lastDraw = clock;
    for (let t = 0; t < seconds; t += dt) {
      update(state, dt);
      clock += dt * 1000;
      if (kitchen && clock - lastDraw >= 16) {
        kitchen.sync(state, clock, (clock - lastDraw) / 1000);
        lastDraw = clock;
      }
    }
    handleEvents(takeEvents(state));
    render();
    if (kitchen) kitchen.sync(state, clock, 1 / 60);
  },
  get records() { return { ...records }; },
  get is3D() { return !!kitchen; },
  get sceneStats() { return kitchen ? kitchen.stats() : null; },
};

setMuted(false);
render();
titleScreen();
requestAnimationFrame(frame);
