# 🍳 Skillet Rush

A short, sharp cooking game that runs in the browser, with a 3D skillet you
cook in. No build step, no bundler, no image or model assets — one HTML file,
one stylesheet, four ES modules.

**▶️ [Play it](https://ctbot000.github.io/cooking-game/)**

## The game

You are the whole kitchen. Orders land on the rail, you have one pan.

1. **Build the dish.** Click the shelf or press <kbd>1</kbd>–<kbd>9</kbd>. The
   order you add things in does not matter; the exact set does.
2. **Ride the heat.** Hold <kbd>Space</kbd> to raise the needle, release to let
   it fall, and keep it inside the green band — which drifts, so parking on one
   heat setting never works. The pan tells you the same story: flames climb the
   sides, the iron starts glowing, the food browns, then blackens and smokes.
3. **Watch the char.** Above the band the dish burns, and it burns *faster* the
   longer you have been cooking and the closer you are to done. Below the band
   nothing happens at all, and the customer is still waiting.

A finished dish goes automatically to whoever has been waiting longest for it.
Three walkouts and service is over. Each day brings more orders, shorter
tempers, and a narrower band.

Also: <kbd>⌫</kbd> clears a mistake, <kbd>Esc</kbd> pauses, <kbd>M</kbd> mutes.
It plays with a mouse or a thumb too — the whole kitchen fits on a phone screen
without scrolling.

## Rendering

The kitchen is real 3D — a WebGL skillet on a lit burner, with the ingredients
as solid objects that drop in, jostle as they sizzle, brown, char, and get
flipped out towards the plates when the dish goes to the pass.

What is *not* 3D is deliberate. The heat band is a precision tracking task, and
the tickets are read under time pressure; both stay as flat, high-contrast HUD.
Putting a skill-critical readout in perspective costs accuracy and returns only
decoration.

three.js is fetched at runtime from a CDN (pinned to r160, ~670 KB, one file).
It is the game's only dependency and it is optional: if the CDN is blocked, the
device has no WebGL, or the fetch simply fails, `createKitchen` resolves to null
and the original flat pan carries on with no other change. Nothing outside
`src/scene.js` knows which one is running.

## Design notes

The interesting problem here is the heat mechanic, and two things about it are
easy to get wrong.

**A tug-of-war meter with no clock has no failure state.** Gain while you are on
target, lose while you are off, both at constant rates, and the outcome is
decided purely by your average accuracy: above break-even you always win
eventually, below it you always lose. Skill sets the *length* of the attempt,
not the result. So the char rate here escalates — with elapsed cook time and
with how nearly finished the dish is — and a hard cap ruins anything left on the
heat too long, with its own distinct message. `test/engine.test.mjs` asserts
that a deliberately sloppy simulated player fails *sometimes*, which is the
property that makes it a game rather than a progress bar.

**A target that moves faster than the thing chasing it is not hard, it is
impossible.** The first tuning pass gave tier 3 dishes a band drifting at
0.77 dial-units per second against a needle whose maximum slew rate is 0.50 —
so a *flawless* player failed 100% of the time. That reads as brutal balance
rather than as an unreachable target, which is exactly why it is worth a
permanent test: `bandSpeed(tier) < CONFIG.heatFall` now holds by assertion.

The tuning was picked by simulating players of four skill levels over 250
attempts each, with error sampled **per decision** rather than per frame — a
miss chance rolled every tick is an 8 ms wobble, not a handicap, and it makes a
punishing game look trivial. The resulting failure-rate curve:

| player | tier 1, day 1 | tier 2, day 3 | tier 3, day 5 | tier 3, day 9 |
| ------ | ------------- | ------------- | ------------- | ------------- |
| sharp  | 0%            | 0%            | 0%            | 0%            |
| decent | 0%            | 1%            | 9%            | 12%           |
| medium | 3%            | 12%           | 52%           | 61%           |
| sloppy | 27%           | 65%           | 90%           | 91%           |

## Layout

```
index.html        markup and the shell
styles.css        the whole look
src/recipes.js    ingredients, dishes, difficulty tiers  (pure data)
src/engine.js     rules, scoring, the simulation         (no DOM, no timers)
src/ui.js         HUD, input, sound                      (no rules)
src/scene.js      the 3D kitchen                         (reads state, never writes)
test/             the engine suite and simulated players
```

`engine.js` never touches the browser: the caller owns the clock, so the same
code runs under `node --test` and behind `requestAnimationFrame`. That split is
what makes the balance numbers above measurable at all — and it is why adding a
WebGL renderer changed no rule and broke no test.

## Running it locally

ES modules need a real origin, so open it over HTTP rather than from `file://`:

```bash
python3 -m http.server 8080
```

Then visit <http://localhost:8080>.

Tests need only Node (≥ 20) and nothing else:

```bash
node --test 'test/*.test.mjs'
```

## Licence

[MIT](LICENSE).
