// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../site/engine.js');

const CONFIG = {
  playoffWeeks: [15, 16, 17], playoffWeight: 1.5,
  benchShare: { QB: 0.1, RB: 0.4, WR: 0.38, TE: 0.1, K: 0.01, DST: 0.01 },
  benchDepthWeight: 0.15, evenTradePerWeek: 0.5, keeperRosWeight: 0.4, keeperNextWeight: 0.6,
  waiverVorWeight: 0.35, waiverTrendWeight: 1.5, waiverOpeningBonus: 6, waiverScheduleWeight: 20,
  stashMaxAge: 24, faabPctPerPoint: 0.9, faabMaxPct: 60
};
const WEEKS = [11, 12, 13, 14, 15, 16, 17];

// A made-up player pool: 40 QB, 80 RB, 100 WR, 40 TE, 32 K, 32 DST, each a bit worse than the last.
function makeData() {
  const players = [];
  const add = (pos, count, top, step) => {
    for (let i = 0; i < count; i++) {
      const ppr = Math.max(0.5, top - i * step);
      players.push({
        id: pos + (i + 1), n: pos + ' ' + (i + 1), p: pos, t: 'T' + (i % 32), bye: 9,
        age: 22 + (i % 10), ppg: [ppr, ppr * 0.92, ppr * 0.84], ns: [ppr * 15, ppr * 14, ppr * 13],
        wk: WEEKS.map(() => 1), u: {}, tr: 0
      });
    }
  };
  add('QB', 40, 24, 0.4); add('RB', 80, 22, 0.25); add('WR', 100, 22, 0.2);
  add('TE', 40, 15, 0.3); add('K', 32, 10, 0.1); add('DST', 32, 9, 0.1);
  return { meta: { weeks: WEEKS, config: CONFIG }, players };
}
const settings = (over) => Object.assign(JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS)), over || {});
const ctxFor = (over, data) => E.prepare(data || makeData(), settings(over));
const MY_TEAM = ['QB10', 'RB12', 'RB20', 'WR12', 'WR20', 'TE8', 'RB30', 'K5', 'DST5',
  'WR35', 'WR40', 'RB40', 'TE15', 'QB20', 'WR50', 'RB45'];   // full 16-man roster

test('eligibility: each slot only accepts the right positions', () => {
  assert.ok(E.eligible('QB', 'QB') && !E.eligible('QB', 'RB'));
  assert.ok(E.eligible('FLEX', 'RB') && E.eligible('FLEX', 'WR') && E.eligible('FLEX', 'TE'));
  assert.ok(!E.eligible('FLEX', 'QB') && !E.eligible('FLEX', 'K') && !E.eligible('FLEX', 'DST'));
  assert.ok(E.eligible('SUPERFLEX', 'QB') && !E.eligible('SUPERFLEX', 'K'));
  assert.ok(E.eligible('K', 'K') && !E.eligible('K', 'DST') && E.eligible('DST', 'DST'));
  for (const pos of E.POSITIONS) assert.ok(E.eligible('BENCH', pos) && E.eligible('IR', pos));
});

test('slots match the lineup settings', () => {
  const slots = E.buildSlots(settings());
  assert.deepEqual(slots.map((s) => s.type),
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'IR']);
  const sf = E.buildSlots(settings({ lineup: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, SUPERFLEX: 1, K: 0, DST: 0 }, bench: 2, ir: 0 }));
  assert.equal(sf.filter((s) => s.type === 'SUPERFLEX').length, 1);
  assert.equal(sf.length, 12);
});

test('rebuilding slots keeps eligible players and benches the rest', () => {
  const ctx = ctxFor();
  const slots = E.buildSlots(ctx.settings);
  slots[0].id = 'QB1'; slots[3].id = 'WR1'; slots[4].id = 'WR2'; slots[4].cost = 7; slots[7].id = 'K1';
  const fewer = settings({ lineup: { QB: 1, RB: 2, WR: 1, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 0, DST: 1 } });
  const res = E.rebuildSlots(slots, fewer, ctx.byId);
  const find = (id) => res.slots.find((s) => s.id === id);
  assert.equal(find('QB1').type, 'QB');
  assert.equal(find('WR1').type, 'WR');
  assert.equal(find('WR2').type, 'BENCH');           // lost his WR slot
  assert.equal(find('WR2').cost, 7);                 // keeper cost travels with him
  assert.equal(find('K1').type, 'BENCH');            // no kicker slot any more
  assert.deepEqual(res.removed, []);
  const tiny = E.rebuildSlots(slots, settings({ lineup: { QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPERFLEX: 0, K: 0, DST: 0 }, bench: 1, ir: 0 }), ctx.byId);
  assert.equal(tiny.removed.length, 2);              // truly no room: reported, not silently lost
});

test('changing league size changes replacement level', () => {
  const small = ctxFor({ teams: 8 }), big = ctxFor({ teams: 16 });
  for (const pos of ['QB', 'RB', 'WR', 'TE']) assert.ok(small.repl[pos] > big.repl[pos], pos);
  assert.ok(big.byId.RB20.vor > small.byId.RB20.vor);
});

test('lineup and scoring settings change values', () => {
  const one = ctxFor(), sflex = ctxFor({ lineup: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1 } });
  assert.ok(sflex.byId.QB15.vor > one.byId.QB15.vor);      // QBs matter more in superflex
  assert.ok(ctxFor({ scoring: 'ppr' }).byId.WR1.ros > ctxFor({ scoring: 'std' }).byId.WR1.ros);
});

test('playoff weeks are weighted extra in value', () => {
  const p = ctxFor().byId.RB1;
  assert.ok(Math.abs(p.po - 22 * 3) < 1e-9);
  assert.ok(Math.abs(p.wv - (p.ros + 0.5 * p.po)) < 1e-9);
});

test('lineup optimizer starts the best eligible players', () => {
  const ctx = ctxFor();
  const roster = ['QB5', 'QB6', 'RB1', 'RB2', 'RB3', 'WR1', 'WR2', 'WR60', 'TE1', 'K1', 'DST1'].map((id) => ctx.byId[id]);
  const res = E.optimizeWeek(roster, 0, ctx);
  const at = (slot) => res.starters.filter((s) => s.slot === slot).map((s) => s.id);
  assert.deepEqual(at('QB'), ['QB5']);
  assert.deepEqual(at('RB'), ['RB1', 'RB2']);
  assert.deepEqual(at('FLEX'), ['RB3']);             // RB3 beats WR60 for the flex
  assert.ok(!res.starters.some((s) => s.id === 'QB6'));   // a QB can never be flexed
  const expected = ['QB5', 'RB1', 'RB2', 'RB3', 'WR1', 'WR2', 'TE1', 'K1', 'DST1']
    .reduce((t, id) => t + ctx.byId[id].wkPts[0], 0);
  assert.ok(Math.abs(res.total - expected) < 1e-9);
});

test('bye weeks are covered by the bench', () => {
  const data = makeData();
  data.players.find((p) => p.id === 'QB5').wk[2] = 0;       // QB5 on bye in the third remaining week
  const ctx = ctxFor({}, data);
  const lu = E.rosLineup(['QB5', 'QB6'].map((id) => ctx.byId[id]), ctx);
  assert.equal(lu.starts.QB5, WEEKS.length - 1);
  assert.equal(lu.starts.QB6, 1);
});

test('optimize button fills starters by value and uses IR for injured players', () => {
  const data = makeData();
  data.players.find((p) => p.id === 'WR3').st = 'IR';
  const ctx = ctxFor({}, data);
  const slots = E.buildSlots(ctx.settings);
  ['WR50', 'WR1', 'RB30', 'RB2', 'QB9', 'TE4', 'WR3', 'RB1', 'WR2'].forEach((id, i) => { slots[15 - i].id = id; });
  const out = E.optimizeSlots(slots, ctx);
  const at = (t) => out.filter((s) => s.type === t).map((s) => s.id);
  assert.deepEqual(at('RB'), ['RB1', 'RB2']);
  assert.deepEqual(at('WR'), ['WR1', 'WR2']);
  assert.deepEqual(at('FLEX'), ['RB30']);
  assert.deepEqual(at('IR'), ['WR3']);
  assert.equal(out.filter((s) => s.id).length, 9);   // nobody lost
});

test('a lopsided trade scores as lopsided, for both sides', () => {
  const ctx = ctxFor();
  const win = E.evaluateTrade(MY_TEAM, ['RB40'], ['RB1'], ctx);
  assert.equal(win.verdict, 'win');
  assert.equal(win.theirVerdict, 'lose');
  assert.ok(win.me.total > 30 && win.them.total < -30);
  const lose = E.evaluateTrade(MY_TEAM, ['RB12'], ['RB70'], ctx);
  assert.equal(lose.verdict, 'lose');
  assert.ok(lose.me.playoff < 0);
  assert.ok(lose.reasons.length > 0);
});

test('swapping near-identical players is even', () => {
  const r = E.evaluateTrade(MY_TEAM, ['RB12'], ['RB13'], ctxFor());
  assert.equal(r.verdict, 'even');
});

test('trades are scored by lineup change, not by adding up values', () => {
  const ctx = ctxFor();
  // Two decent WRs "add up" to more value than one star RB, but only one lineup spot improves.
  const r = E.evaluateTrade(MY_TEAM, ['RB12'], ['WR25', 'WR26'], ctx);
  assert.ok(ctx.byId.WR25.vor + ctx.byId.WR26.vor > ctx.byId.RB12.vor);
  assert.equal(r.verdict, 'lose');
});

test('roster-spot tax: getting 2-for-1 with a full roster forces a drop', () => {
  const ctx = ctxFor();
  const r = E.evaluateTrade(MY_TEAM, ['RB12'], ['RB10', 'WR30'], ctx);
  assert.equal(r.drops.length, 1);
  assert.ok(r.reasons.some((x) => /drop/.test(x)));
  const roomy = E.evaluateTrade(MY_TEAM.slice(0, 12), ['RB12'], ['RB10', 'WR70'], ctx);
  assert.equal(roomy.drops.length, 0);               // open roster spots: no tax
  const giveMore = E.evaluateTrade(MY_TEAM, ['RB12', 'WR50'], ['RB10'], ctx);
  assert.equal(giveMore.openSpots, 1);
});

test('keeper mode: implied round, surplus and trade impact', () => {
  const ctx = ctxFor({ leagueType: 'keeper', keepers: 2 });
  const star = ctx.byId.RB1;
  assert.equal(star.round, 1);
  const cheap = E.keeperInfo(star, 10, ctx), pricey = E.keeperInfo(star, 1, ctx);
  assert.equal(cheap.roundsSaved, 9);
  assert.ok(cheap.surplus > pricey.surplus);         // cheap keepers show surplus value
  assert.ok(cheap.nextPart === star.nsVor && cheap.rosPart === star.vor);   // parts shown separately
  const r = E.evaluateTrade(MY_TEAM, ['RB40'], ['RB1'], ctx, {});
  assert.ok(r.keeper.changed && r.keeper.added.includes('RB1') && r.keeper.nextSeason > 0);
  assert.equal(r.keeper.after.length, 2);
  assert.equal(E.evaluateTrade(MY_TEAM, ['RB40'], ['RB1'], ctxFor()).keeper, undefined);
});

test('waiver list hides my players and taken players, and ranks by need', () => {
  const ctx = ctxFor({ faab: '100' });
  const w = E.waiverRank(MY_TEAM, ['RB1', 'WR1'], ctx);
  const ids = w.list.map((x) => x.id);
  assert.ok(!ids.includes('RB1') && !ids.includes('WR1') && !ids.includes('RB12'));
  assert.equal(ids[0], 'RB2');                       // best remaining upgrade for this team
  assert.ok(w.list[0].bidPct[0] < w.list[0].bidPct[1] && w.list[0].bidPct[1] <= 78);
  assert.ok(w.list[0].bid[1] <= 100);
  // my QB is weak relative to my TE, so QB1 helps me more than TE9 does
  const score = (id) => w.list.find((x) => x.id === id).score;
  assert.ok(score('QB1') > score('TE9'));
  // drop candidates come from my bench, never my starters
  assert.ok(w.drops.length > 0 && w.drops.every((d) => !['QB10', 'RB12', 'WR12', 'TE8'].includes(d.id)));
});

test('waiver bonuses: rising usage, role openings, keeper stashes', () => {
  const data = makeData();
  const a = data.players.find((p) => p.id === 'WR60'), b = data.players.find((p) => p.id === 'WR59');
  a.tr = 4; a.open = 'WR 3 is IR';
  const ctx = ctxFor({ leagueType: 'keeper' }, data);
  const w = E.waiverRank(MY_TEAM, [], ctx);
  const get = (id) => w.list.find((x) => x.id === id);
  assert.ok(get('WR60').score > get('WR59').score);
  assert.ok(get('WR60').tags.includes('Usage rising') && get('WR60').tags.some((t) => t.startsWith('Role opening')));
  assert.ok(get('RB3').stash === true);              // age 24, high next-season value
  assert.ok(E.waiverRank(MY_TEAM, [], ctxFor({}, data)).list.every((x) => !x.stash));   // redraft: no stash flag
});
