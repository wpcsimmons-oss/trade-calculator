/*
 * engine.js - all the maths the page does in your browser.
 *
 * No network calls, no DOM. It only takes the players.json data plus your
 * league settings/roster and returns numbers. That makes it testable with
 * `node --test tests/` (see tests/engine.test.js).
 */
(function (root) {
  'use strict';

  var POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
  var STARTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST'];
  var ELIGIBLE = {
    QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
    FLEX: ['RB', 'WR', 'TE'],
    SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
    K: ['K'], DST: ['DST'],
    BENCH: POSITIONS, IR: POSITIONS
  };
  var FORMAT_INDEX = { ppr: 0, half: 1, std: 2 };

  var DEFAULT_SETTINGS = {
    leagueType: 'redraft',          // or 'keeper'
    teams: 12,
    scoring: 'ppr',                 // 'ppr' | 'half' | 'std'
    lineup: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1, DST: 1 },
    bench: 6,
    ir: 1,
    keepers: 3,
    faab: ''                        // blank = rolling waivers
  };

  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* ---------------- eligibility & roster slots ---------------- */

  function eligible(slotType, pos) {
    return (ELIGIBLE[slotType] || []).indexOf(pos) !== -1;
  }

  function starterTypes(settings) {
    var out = [];
    STARTER_ORDER.forEach(function (t) {
      for (var i = 0; i < (settings.lineup[t] || 0); i++) out.push(t);
    });
    return out;
  }

  function buildSlots(settings) {
    var types = starterTypes(settings), i;
    for (i = 0; i < settings.bench; i++) types.push('BENCH');
    for (i = 0; i < settings.ir; i++) types.push('IR');
    return types.map(function (t) { return { type: t, id: null, cost: null }; });
  }

  /* Rebuild slots after a settings change. Players keep a matching slot when
   * they are still eligible; anyone who no longer fits goes to the bench
   * (then IR). Only if the whole roster is full are players removed. */
  function rebuildSlots(oldSlots, settings, byId) {
    var slots = buildSlots(settings);
    var leftovers = [];
    function place(old, types) {
      var p = byId[old.id];
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].id === null && types.indexOf(slots[i].type) !== -1 &&
            p && eligible(slots[i].type, p.p)) {
          slots[i].id = old.id; slots[i].cost = old.cost == null ? null : old.cost;
          return true;
        }
      }
      return false;
    }
    (oldSlots || []).forEach(function (old) {
      if (!old || old.id == null || !byId[old.id]) return;
      if (!place(old, [old.type])) leftovers.push(old);
    });
    var removed = [];
    leftovers.forEach(function (old) {
      if (!place(old, ['BENCH']) && !place(old, ['IR']) && !place(old, STARTER_ORDER)) removed.push(old.id);
    });
    return { slots: slots, removed: removed };
  }

  /* ---------------- league-wide context ---------------- */

  /* Pretend every team starts the best available players. Whoever is next at
   * each position after starters + a share of bench spots is "replacement". */
  function leagueSim(players, metric, settings, benchShare) {
    var byPos = {}, ptr = {}, started = {};
    POSITIONS.forEach(function (pos) { byPos[pos] = []; ptr[pos] = 0; });
    players.forEach(function (p) { if (byPos[p.p]) byPos[p.p].push(p); });
    POSITIONS.forEach(function (pos) {
      byPos[pos].sort(function (a, b) { return b[metric] - a[metric]; });
    });
    STARTER_ORDER.forEach(function (slot) {
      started[slot] = [];
      var n = settings.teams * (settings.lineup[slot] || 0);
      for (var i = 0; i < n; i++) {
        var best = null;
        ELIGIBLE[slot].forEach(function (pos) {
          var c = byPos[pos][ptr[pos]];
          if (c && (!best || c[metric] > best[metric])) best = c;
        });
        if (!best) break;
        ptr[best.p]++;
        started[slot].push(best);
      }
    });
    var repl = {}, replPlayer = {};
    POSITIONS.forEach(function (pos) {
      var extra = Math.round((benchShare[pos] || 0) * settings.teams * settings.bench);
      var idx = ptr[pos] + extra;
      var list = byPos[pos];
      var rp = list[Math.min(idx, list.length - 1)];
      replPlayer[pos] = idx < list.length ? rp : null;
      repl[pos] = idx < list.length ? rp[metric] : 0;
    });
    return { repl: repl, replPlayer: replPlayer, started: started };
  }

  /* Turn raw data + settings into everything else the page needs. */
  function prepare(data, settings) {
    var cfg = data.meta.config;
    var fi = FORMAT_INDEX[settings.scoring] || 0;
    var weeks = data.meta.weeks;
    var isPO = weeks.map(function (w) { return cfg.playoffWeeks.indexOf(w) !== -1; });
    var players = data.players.map(function (p) {
      var q = Object.assign({}, p);
      q.pg = p.ppg[fi];
      q.wkPts = p.wk.map(function (m) { return q.pg * m; });
      q.ros = sum(q.wkPts);
      q.po = sum(q.wkPts.filter(function (_, i) { return isPO[i]; }));
      q.wv = q.ros + (cfg.playoffWeight - 1) * q.po;   // playoff weeks count extra
      q.nsPts = p.ns[fi];
      return q;
    });
    var byId = {};
    players.forEach(function (p) { byId[p.id] = p; });

    var sim = leagueSim(players, 'wv', settings, cfg.benchShare);
    var nsSim = leagueSim(players, 'nsPts', settings, cfg.benchShare);
    var replWeekly = {};
    POSITIONS.forEach(function (pos) {
      var rp = sim.replPlayer[pos];
      var live = rp ? rp.wkPts.filter(function (x) { return x > 0; }).length : 0;
      replWeekly[pos] = rp && live ? rp.ros / live : 0;   // a waiver streamer has no bye
    });
    players.forEach(function (p) {
      p.vor = p.wv - sim.repl[p.p];
      p.nsVor = p.nsPts - nsSim.repl[p.p];
    });

    // next-season rank -> implied draft round
    var ranked = players.slice().sort(function (a, b) { return b.nsVor - a.nsVor; });
    ranked.forEach(function (p, i) {
      p.nsRank = i + 1;
      p.round = Math.ceil((i + 1) / settings.teams);
    });
    var roundValue = [];                       // roundValue[r] = typical nsVor of a round-r pick
    for (var r = 1; (r - 1) * settings.teams < ranked.length && r <= 30; r++) {
      var chunk = ranked.slice((r - 1) * settings.teams, r * settings.teams);
      roundValue[r] = Math.max(0, sum(chunk.map(function (p) { return p.nsVor; })) / chunk.length);
    }

    // average starter at each slot (used to imagine the other team in a trade)
    var avgStarter = {};
    STARTER_ORDER.forEach(function (slot) {
      var s = sim.started[slot];
      if (!s.length) return;
      var counts = {};
      s.forEach(function (p) { counts[p.p] = (counts[p.p] || 0) + 1; });
      var pos = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
      avgStarter[slot] = {
        pos: pos,
        weekly: weeks.length ? sum(s.map(function (p) { return p.ros; })) / s.length / weeks.length : 0,
        vor: sum(s.map(function (p) { return p.vor; })) / s.length
      };
    });

    players.sort(function (a, b) { return b.vor - a.vor; });
    return {
      settings: settings, cfg: cfg, meta: data.meta, weeks: weeks, isPO: isPO,
      players: players, byId: byId, repl: sim.repl, replWeekly: replWeekly,
      nsRepl: nsSim.repl, roundValue: roundValue, avgStarter: avgStarter
    };
  }

  /* ---------------- lineup optimiser ---------------- */

  /* Best starting lineup for one week. `roster` is a list of player objects
   * (each with wkPts). Any slot can fall back to a replacement-level waiver
   * pickup, so trading away your only TE costs you "TE minus a streamer",
   * not the whole TE. */
  function optimizeWeek(roster, w, ctx) {
    var pools = {}, used = {};
    POSITIONS.forEach(function (pos) { pools[pos] = []; });
    roster.forEach(function (p) { if (pools[p.p]) pools[p.p].push(p); });
    POSITIONS.forEach(function (pos) {
      pools[pos].sort(function (a, b) { return b.wkPts[w] - a.wkPts[w]; });
    });
    var total = 0, starters = [];
    starterTypes(ctx.settings).forEach(function (slot) {
      var best = null, bestRepl = 0, replPos = null;
      ELIGIBLE[slot].forEach(function (pos) {
        var list = pools[pos];
        for (var i = 0; i < list.length; i++) {
          if (!used[list[i].id]) {
            if (!best || list[i].wkPts[w] > best.wkPts[w]) best = list[i];
            break;
          }
        }
        if (replPos === null || ctx.replWeekly[pos] > bestRepl) { bestRepl = ctx.replWeekly[pos]; replPos = pos; }
      });
      if (best && best.wkPts[w] >= bestRepl) {
        used[best.id] = true;
        total += best.wkPts[w];
        starters.push({ slot: slot, id: best.id, pts: best.wkPts[w] });
      } else {
        total += bestRepl;
        starters.push({ slot: slot, id: null, pos: replPos, pts: bestRepl });
      }
    });
    return { total: total, starters: starters };
  }

  /* Sum of the best lineup for every remaining week. */
  function rosLineup(roster, ctx) {
    var out = { total: 0, playoff: 0, weekly: [], starts: {}, startPts: {} };
    for (var w = 0; w < ctx.weeks.length; w++) {
      var res = optimizeWeek(roster, w, ctx);
      out.weekly.push(res.total);
      out.total += res.total;
      if (ctx.isPO[w]) out.playoff += res.total;
      res.starters.forEach(function (s) {
        if (s.id) {
          out.starts[s.id] = (out.starts[s.id] || 0) + 1;
          out.startPts[s.id] = (out.startPts[s.id] || 0) + s.pts;
        }
      });
    }
    return out;
  }

  /* Bench "insurance" value: positive value-over-replacement for the share of
   * weeks a player is NOT in the starting lineup. */
  function benchValue(roster, lineup, ctx) {
    var n = ctx.weeks.length || 1, v = 0;
    roster.forEach(function (p) {
      if (p.phantom) return;
      v += Math.max(0, p.vor) * (1 - (lineup.starts[p.id] || 0) / n);
    });
    return v;
  }

  /* "Optimize lineup" button: best players by rest-of-season value into the
   * starting slots, injured-reserve players into IR slots, the rest on the bench. */
  function optimizeSlots(slots, ctx) {
    var held = slots.filter(function (s) { return s.id && ctx.byId[s.id]; });
    var costOf = {};
    held.forEach(function (s) { costOf[s.id] = s.cost; });
    var pool = held.map(function (s) { return ctx.byId[s.id]; })
      .sort(function (a, b) { return b.wv - a.wv; });
    var out = buildSlots(ctx.settings), used = {};
    function fill(filterSlot, filterPlayer) {
      out.forEach(function (slot) {
        if (slot.id || !filterSlot(slot)) return;
        for (var i = 0; i < pool.length; i++) {
          var p = pool[i];
          if (!used[p.id] && eligible(slot.type, p.p) && (!filterPlayer || filterPlayer(p))) {
            slot.id = p.id; slot.cost = costOf[p.id] == null ? null : costOf[p.id]; used[p.id] = true;
            return;
          }
        }
      });
    }
    var isIR = function (p) { return p.st === 'IR' || p.st === 'PUP'; };
    fill(function (s) { return s.type === 'IR'; }, isIR);
    fill(function (s) { return s.type !== 'BENCH' && s.type !== 'IR'; });
    fill(function (s) { return s.type === 'BENCH'; });
    fill(function (s) { return s.type === 'IR'; });
    return out;
  }

  /* ---------------- keeper helpers ---------------- */

  /* Next-season value of keeping a player, after paying his keeper cost
   * (the value of the draft pick you give up). No cost = free to keep. */
  function keeperInfo(p, cost, ctx) {
    var c = ctx.cfg;
    var pick = cost ? (ctx.roundValue[Math.min(cost, ctx.roundValue.length - 1)] || 0) : 0;
    return {
      rosPart: p.vor,
      nextPart: p.nsVor,
      blend: c.keeperRosWeight * p.vor + c.keeperNextWeight * p.nsVor,
      impliedRound: p.round,
      cost: cost || null,
      roundsSaved: cost ? cost - p.round : null,
      surplus: p.nsVor - pick
    };
  }

  function bestKeepers(roster, costs, ctx) {
    return roster
      .map(function (p) { return { id: p.id, surplus: keeperInfo(p, costs[p.id], ctx).surplus }; })
      .filter(function (k) { return k.surplus > 0; })
      .sort(function (a, b) { return b.surplus - a.surplus; })
      .slice(0, ctx.settings.keepers);
  }

  /* ---------------- trade calculator ---------------- */

  function rosterCapacity(settings) {
    return starterTypes(settings).length + settings.bench + settings.ir;
  }

  /* We don't know the other manager's roster, so imagine a league-average
   * starter in every slot they have, then swap in the players in the deal. */
  function phantomRoster(theirPlayers, ctx) {
    var types = starterTypes(ctx.settings);
    var taken = types.map(function () { return false; });
    theirPlayers.forEach(function (p) {
      var order = [p.p, 'FLEX', 'SUPERFLEX'];
      for (var o = 0; o < order.length; o++) {
        for (var i = 0; i < types.length; i++) {
          if (!taken[i] && types[i] === order[o] && eligible(types[i], p.p)) { taken[i] = true; return; }
        }
      }
    });
    var roster = theirPlayers.slice();
    types.forEach(function (t, i) {
      var a = ctx.avgStarter[t];
      if (taken[i] || !a) return;
      roster.push({
        id: '_avg_' + i, phantom: true, p: a.pos, vor: a.vor,
        wkPts: ctx.weeks.map(function () { return a.weekly; })
      });
    });
    return roster;
  }

  function sideScore(before, after, benchBefore, benchAfter, ctx) {
    var lineup = after.total - before.total;
    var bench = ctx.cfg.benchDepthWeight * (benchAfter - benchBefore);
    return { lineup: lineup, playoff: after.playoff - before.playoff, bench: bench, total: lineup + bench };
  }

  /* myIds: everyone on my roster. giveIds: my players leaving. getIds: players arriving.
   * costs: {playerId: keeperRound} (keeper mode, optional). */
  function evaluateTrade(myIds, giveIds, getIds, ctx, costs) {
    costs = costs || {};
    var P = function (id) { return ctx.byId[id]; };
    var mine = myIds.map(P).filter(Boolean);
    var give = giveIds.map(P).filter(Boolean);
    var get = getIds.map(P).filter(Boolean);
    var n = ctx.weeks.length || 1;

    // ---- my side
    var before = rosLineup(mine, ctx);
    var afterRoster = mine.filter(function (p) { return giveIds.indexOf(p.id) === -1; }).concat(get);
    var drops = [];
    var cap = rosterCapacity(ctx.settings);
    while (afterRoster.length > cap) {            // roster-spot tax: must cut someone
      var worst = afterRoster.slice().sort(function (a, b) { return a.vor - b.vor; })[0];
      drops.push(worst);
      afterRoster = afterRoster.filter(function (p) { return p.id !== worst.id; });
    }
    var after = rosLineup(afterRoster, ctx);
    var me = sideScore(before, after, benchValue(mine, before, ctx), benchValue(afterRoster, after, ctx), ctx);
    var openSpots = Math.max(0, give.length - get.length);

    // ---- their side (estimated)
    var tBeforeRoster = phantomRoster(get, ctx);
    var tAfterRoster = tBeforeRoster.filter(function (p) { return getIds.indexOf(p.id) === -1; }).concat(give);
    var tb = rosLineup(tBeforeRoster, ctx), ta = rosLineup(tAfterRoster, ctx);
    var them = sideScore(tb, ta, benchValue(tBeforeRoster, tb, ctx), benchValue(tAfterRoster, ta, ctx), ctx);

    // ---- verdict
    var even = ctx.cfg.evenTradePerWeek * n;
    var verdict = me.total > even ? 'win' : (me.total < -even ? 'lose' : 'even');
    var theirVerdict = them.total > even ? 'win' : (them.total < -even ? 'lose' : 'even');

    // ---- plain-language reasons
    var reasons = [];
    var f1 = function (x) { return (Math.round(x * 10) / 10).toFixed(1); };
    get.forEach(function (p) {
      var s = after.starts[p.id] || 0;
      if (drops.indexOf(p) !== -1) {
        reasons.push(p.n + ' would not even make your roster - he is worth less than everyone you already have.');
      } else if (s >= n / 2) {
        reasons.push(p.n + ' would start for you in ' + s + ' of the ' + n + ' remaining weeks (about ' +
          f1(after.startPts[p.id] / s) + ' pts in those weeks).');
      } else if (s > 0) {
        reasons.push(p.n + ' would be a part-time starter for you (' + s + ' of ' + n + ' weeks), mostly covering byes and bad matchups.');
      } else {
        reasons.push(p.n + ' would sit on your bench - your current starters at ' + p.p + ' project higher every week.');
      }
      if (p.st) reasons.push(p.n + ' is currently listed as ' + p.st + ', and his value is already discounted for that.');
    });
    give.forEach(function (p) {
      var s = before.starts[p.id] || 0;
      if (s >= n / 2) {
        reasons.push('You lose ' + p.n + ', who was in your starting lineup ' + s + ' of ' + n + ' weeks.');
      } else {
        reasons.push(p.n + ' was mostly on your bench, so losing him barely touches your starting lineup.');
      }
    });
    var promoted = Object.keys(after.starts).filter(function (id) {
      return getIds.indexOf(id) === -1 && (after.starts[id] - (before.starts[id] || 0)) >= n / 2;
    });
    promoted.forEach(function (id) { reasons.push(P(id).n + ' moves from your bench into the starting lineup.'); });
    drops.forEach(function (p) {
      if (get.indexOf(p) === -1) {
        reasons.push('You get more players than you give and your roster is full, so you would have to drop ' +
          p.n + ' (roster-spot tax).');
      }
    });
    if (openSpots > 0 && !drops.length) {
      reasons.push('You give ' + openSpots + ' more player' + (openSpots > 1 ? 's' : '') +
        ' than you get, which frees ' + (openSpots > 1 ? 'roster spots' : 'a roster spot') +
        ' for waiver pickups (counted at replacement level).');
    }
    if (Math.abs(me.playoff) >= 1) {
      reasons.push('In the fantasy playoffs (weeks ' + ctx.cfg.playoffWeeks.join(', ') + ') your lineup ' +
        (me.playoff > 0 ? 'gains ' : 'loses ') + f1(Math.abs(me.playoff)) + ' points.');
    }
    if (Math.abs(me.bench) >= 1) {
      reasons.push('Your bench depth gets ' + (me.bench > 0 ? 'stronger' : 'thinner') + ' (' +
        (me.bench > 0 ? '+' : '') + f1(me.bench) + ' after weighting).');
    }

    var result = {
      me: me, them: them, verdict: verdict, theirVerdict: theirVerdict,
      drops: drops.map(function (p) { return p.id; }), openSpots: openSpots,
      reasons: reasons, weeks: n, before: before, after: after
    };

    // ---- keeper mode extras
    if (ctx.settings.leagueType === 'keeper') {
      var kb = bestKeepers(mine, costs, ctx), ka = bestKeepers(afterRoster, costs, ctx);
      var tot = function (k) { return sum(k.map(function (x) { return x.surplus; })); };
      var idsB = kb.map(function (k) { return k.id; }), idsA = ka.map(function (k) { return k.id; });
      result.keeper = {
        before: idsB, after: idsA,
        nextSeason: tot(ka) - tot(kb),
        changed: idsB.slice().sort().join() !== idsA.slice().sort().join(),
        added: idsA.filter(function (id) { return idsB.indexOf(id) === -1; }),
        removed: idsB.filter(function (id) { return idsA.indexOf(id) === -1; })
      };
    }
    return result;
  }

  /* ---------------- waiver wire ---------------- */

  function waiverRank(myIds, takenIds, ctx, costs) {
    costs = costs || {};
    var cfg = ctx.cfg, s = ctx.settings, n = ctx.weeks.length || 1;
    var keeper = s.leagueType === 'keeper';
    var mine = myIds.map(function (id) { return ctx.byId[id]; }).filter(Boolean);
    var before = rosLineup(mine, ctx);
    var skip = {};
    myIds.forEach(function (id) { skip[id] = true; });
    (takenIds || []).forEach(function (id) { skip[id] = true; });

    var stashLimit = s.teams * (s.keepers + 4);
    var list = [];
    ctx.players.forEach(function (p) {
      if (skip[p.id] || (p.pg <= 0 && p.nsPts <= 0)) return;
      var gain = rosLineup(mine.concat([p]), ctx).total - before.total;
      var live = p.wk.filter(function (m) { return m > 0; });
      var schedEase = (p.st || p.stale || !live.length) ? 0 : sum(live) / live.length - 1;
      var trend = clamp(p.tr || 0, -3, 5);
      var score = gain + cfg.waiverVorWeight * Math.max(0, p.vor) + cfg.waiverTrendWeight * trend +
        (p.open ? cfg.waiverOpeningBonus : 0) + cfg.waiverScheduleWeight * schedEase;
      var stash = keeper && p.age != null && p.age <= cfg.stashMaxAge && p.nsVor > 0 && p.nsRank <= stashLimit;
      if (stash) score += cfg.keeperNextWeight * p.nsVor * 0.1;
      var tags = [];
      if (gain >= n * 0.75) tags.push('Fills a need at ' + p.p);
      if ((p.tr || 0) >= 1.5) tags.push('Usage rising');
      if ((p.tr || 0) <= -1.5) tags.push('Usage falling');
      if (p.open) tags.push('Role opening: ' + p.open);
      if (schedEase >= 0.04) tags.push('Easy schedule');
      if (schedEase <= -0.04) tags.push('Tough schedule');
      if (stash) tags.push('Keeper stash');
      if (p.st) tags.push(p.st);
      list.push({ id: p.id, score: score, gain: gain, trend: p.tr || 0, schedEase: schedEase, stash: stash, tags: tags });
    });
    list.sort(function (a, b) { return b.score - a.score; });

    // FAAB / priority suggestion
    var budget = parseFloat(s.faab);
    list.forEach(function (w) {
      var pct = clamp(w.score * cfg.faabPctPerPoint, 0, cfg.faabMaxPct);
      w.bidPct = [Math.round(pct * 0.7), Math.round(pct * 1.3)];
      if (w.bidPct[1] < 1) w.bidPct = [0, 1];
      if (!isNaN(budget) && budget > 0) {
        w.bid = [Math.round(budget * w.bidPct[0] / 100), Math.max(1, Math.round(budget * w.bidPct[1] / 100))];
      }
      w.priority = pct >= 20 ? 'High' : (pct >= 8 ? 'Medium' : 'Low');
    });

    // drop candidates: the players my team would miss least
    var keepIds = keeper ? bestKeepers(mine, costs, ctx).map(function (k) { return k.id; }) : [];
    var dropsList = mine.map(function (p) {
      var without = rosLineup(mine.filter(function (q) { return q.id !== p.id; }), ctx);
      return {
        id: p.id,
        keepValue: (before.total - without.total) + cfg.benchDepthWeight * Math.max(0, p.vor),
        starts: before.starts[p.id] || 0
      };
    }).filter(function (d) { return keepIds.indexOf(d.id) === -1 && d.starts < n / 2; })
      .sort(function (a, b) { return a.keepValue - b.keepValue; })
      .slice(0, 3);

    return { list: list, drops: dropsList };
  }

  var api = {
    POSITIONS: POSITIONS, STARTER_ORDER: STARTER_ORDER, ELIGIBLE: ELIGIBLE,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    eligible: eligible, starterTypes: starterTypes, buildSlots: buildSlots, rebuildSlots: rebuildSlots,
    leagueSim: leagueSim, prepare: prepare, optimizeWeek: optimizeWeek, rosLineup: rosLineup,
    benchValue: benchValue, optimizeSlots: optimizeSlots, keeperInfo: keeperInfo, bestKeepers: bestKeepers,
    rosterCapacity: rosterCapacity, evaluateTrade: evaluateTrade, waiverRank: waiverRank
  };
  root.Engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
