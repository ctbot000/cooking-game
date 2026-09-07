// Static content for Skillet Rush: what you can put in the pan, and what those
// combinations turn into. Kept free of engine logic so both the browser and the
// Node test suite can import it.

/** Everything on the shelf. `key` is the keyboard shortcut for that slot. */
export const INGREDIENTS = [
  { id: 'tomato',   name: 'Tomato',   emoji: '\u{1F345}', key: '1' },
  { id: 'onion',    name: 'Onion',    emoji: '\u{1F9C5}', key: '2' },
  { id: 'mushroom', name: 'Mushroom', emoji: '\u{1F344}', key: '3' },
  { id: 'cheese',   name: 'Cheese',   emoji: '\u{1F9C0}', key: '4' },
  { id: 'beef',     name: 'Beef',     emoji: '\u{1F969}', key: '5' },
  { id: 'shrimp',   name: 'Shrimp',   emoji: '\u{1F990}', key: '6' },
  { id: 'egg',      name: 'Egg',      emoji: '\u{1F95A}', key: '7' },
  { id: 'noodles',  name: 'Noodles',  emoji: '\u{1F35C}', key: '8' },
  { id: 'chili',    name: 'Chili',    emoji: '\u{1F336}️', key: '9' },
];

export const INGREDIENT_BY_ID = new Map(INGREDIENTS.map((i) => [i.id, i]));

/**
 * Difficulty tiers. `width`/`amp`/`period` describe the heat band the player has
 * to track: a window of `width` whose centre swings `+/-amp` around the middle
 * of the dial every `period` seconds. Narrower and faster is harder.
 */
export const TIERS = {
  1: { width: 0.27, amp: 0.15, period: 5.6 },
  2: { width: 0.2, amp: 0.2, period: 5.0 },
  3: { width: 0.155, amp: 0.24, period: 4.8 },
};

/**
 * Peak speed of the band's centre, in dial units per second. This has to stay
 * comfortably under the needle's own slew rate (CONFIG.heatFall) -- a target
 * that outruns the thing you steer is not difficult, it is unreachable.
 */
export function bandSpeed(tier) {
  return (2 * Math.PI * TIERS[tier].amp) / TIERS[tier].period;
}

/** `needs` is a multiset: the pan must hold exactly these, in any order. */
export const RECIPES = [
  { id: 'tomato_egg',  name: 'Tomato Egg Toss', emoji: '\u{1F373}', tier: 1, reward: 30, needs: ['tomato', 'egg'] },
  { id: 'mush_melt',   name: 'Mushroom Melt',   emoji: '\u{1FAD5}', tier: 1, reward: 32, needs: ['mushroom', 'cheese'] },
  { id: 'beef_onion',  name: 'Beef & Onion',    emoji: '\u{1F958}', tier: 1, reward: 36, needs: ['beef', 'onion'] },
  { id: 'chili_shrimp', name: 'Chili Shrimp',   emoji: '\u{1F364}', tier: 2, reward: 48, needs: ['shrimp', 'chili'] },
  { id: 'house_ramen', name: 'House Ramen',     emoji: '\u{1F35C}', tier: 2, reward: 54, needs: ['noodles', 'egg', 'mushroom'] },
  { id: 'cheese_steak', name: 'Cheese Steak',   emoji: '\u{1F354}', tier: 2, reward: 56, needs: ['beef', 'cheese', 'onion'] },
  { id: 'fire_noodles', name: 'Fire Noodles',   emoji: '\u{1F525}', tier: 3, reward: 74, needs: ['noodles', 'chili', 'beef'] },
  { id: 'sea_pasta',   name: 'Seaside Pasta',   emoji: '\u{1F35D}', tier: 3, reward: 78, needs: ['noodles', 'shrimp', 'tomato'] },
];

export const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

/** Day a tier first appears on the ticket rail. */
export const TIER_UNLOCK_DAY = { 1: 1, 2: 2, 3: 4 };

/** Sorted signature of an ingredient list, so lookup ignores the order added. */
export function signature(ids) {
  return [...ids].sort().join('+');
}

const BY_SIGNATURE = new Map(RECIPES.map((r) => [signature(r.needs), r]));

/** The recipe a pan of `ids` makes, or null if that combination is nothing. */
export function matchRecipe(ids) {
  return BY_SIGNATURE.get(signature(ids)) ?? null;
}

/** True while `ids` is still a prefix of some recipe -- used for pan feedback. */
export function isViablePrefix(ids) {
  return RECIPES.some((r) => {
    if (ids.length > r.needs.length) return false;
    const pool = [...r.needs];
    for (const id of ids) {
      const at = pool.indexOf(id);
      if (at === -1) return false;
      pool.splice(at, 1);
    }
    return true;
  });
}
