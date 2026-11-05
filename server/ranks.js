// Rank labels the client paints. The badge and leaderboard read `rank.label`
// ("BRONZE III", "CHAMPION", …). Room member cards read a bare label string.
// The client's emblem splits the label on the first space (tier + division).

const LADDER = [
  ['BRONZE III', 0],
  ['BRONZE II', 100],
  ['BRONZE I', 200],
  ['SILVER III', 300],
  ['SILVER II', 400],
  ['SILVER I', 500],
  ['GOLD III', 650],
  ['GOLD II', 800],
  ['GOLD I', 950],
  ['PLATINUM III', 1150],
  ['PLATINUM II', 1350],
  ['PLATINUM I', 1550],
  ['DIAMOND III', 1800],
  ['DIAMOND II', 2050],
  ['DIAMOND I', 2300],
  ['CHAMPION', 2600],
];

// Virtual MMR used when a human's result is scored against bots.
const BOT_MMR = { elite: 1600, friend: 1000 };

function labelFor(mmr) {
  let label = LADDER[0][0];
  const n = Number(mmr) || 0;
  for (const [name, min] of LADDER) if (n >= min) label = name;
  return label;
}

function presentUser(user) {
  return {
    name: user.name,
    mmr: user.mmr,
    wins: user.wins,
    races: user.races,
    rank: { label: labelFor(user.mmr) },
  };
}

/**
 * Placement delta for a finished race.
 * `place` is 1-based. `opponentMmrs` is every other racer (humans at their
 * pre-race MMR, bots at BOT_MMR). Winner always gains at least 8; last place
 * always loses at least 4, before the 0 MMR floor is applied by the caller.
 */
function placementDelta(place, mmr, opponentMmrs) {
  const n = opponentMmrs.length + 1;
  if (n <= 1) return 10;
  const table = n === 2 ? [0, 20, -16] : n === 3 ? [0, 24, 4, -18] : [0, 28, 12, -8, -24];
  const base = table[place] ?? -20;
  const oppAvg = opponentMmrs.reduce((sum, value) => sum + value, 0) / opponentMmrs.length;
  const upset = Math.max(-15, Math.min(15, Math.round((oppAvg - mmr) / 100)));
  let delta = base + upset;
  if (place === 1) delta = Math.max(delta, 8);
  if (place === n) delta = Math.min(delta, -4);
  return delta;
}

module.exports = { LADDER, BOT_MMR, labelFor, presentUser, placementDelta };
