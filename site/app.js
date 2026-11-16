/*
 * app.js - the page: settings, roster slots, trade calculator, waiver wire.
 * All maths is in engine.js. Everything is saved in this browser only
 * (localStorage); nothing is sent anywhere.
 */
(function () {
  'use strict';
  var E = window.Engine;
  var KEY = 'fantasy-trade-calc-v1';
  var $ = function (id) { return document.getElementById(id); };

  var data = null, ctx = null, waiverCache = null, waiverShown = 30;
  var state = {
    settings: JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS)),
    slots: null,
    taken: [],
    trade: { give: [], get: [], costs: {} },
    tab: 'roster',
    waiverPos: 'ALL',
    showTaken: false
  };

  /* ---------- storage (never allowed to break the page) ---------- */
  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (s.settings) {
          var d = E.DEFAULT_SETTINGS;
          state.settings = Object.assign({}, d, s.settings);
          state.settings.lineup = Object.assign({}, d.lineup, s.settings.lineup || {});
        }
        if (Array.isArray(s.slots)) state.slots = s.slots;
        if (Array.isArray(s.taken)) state.taken = s.taken;
        if (s.trade) state.trade = Object.assign({ give: [], get: [], costs: {} }, s.trade);
        if (s.tab) state.tab = s.tab;
        if (s.waiverPos) state.waiverPos = s.waiverPos;
      }
    } catch (e) { /* private mode or corrupted data: start fresh */ }
  }
  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function f0(x) { return String(Math.round(x)); }
  function signed(x, d) { var v = d === 0 ? f0(x) : f1(x); return (x > 0 ? '+' : '') + v; }
  function cls(x) { return x > 0.05 ? 'pos' : (x < -0.05 ? 'neg' : ''); }
  function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
  function meta(p) { return p.p + ' · ' + p.t + (p.bye ? ' · bye ' + p.bye : ''); }
  function nameHtml(p) {
    return esc(p.n) + (p.st ? '<span class="st">' + esc(p.st) + '</span>' : '');
  }
  function myIds() { return state.slots.filter(function (s) { return s.id; }).map(function (s) { return s.id; }); }
  function costs() {
    var c = {};
    state.slots.forEach(function (s) { if (s.id && s.cost) c[s.id] = s.cost; });
    Object.keys(state.trade.costs).forEach(function (id) {
      if (state.trade.costs[id] && c[id] == null) c[id] = state.trade.costs[id];
    });
    return c;
  }
  function isKeeper() { return state.settings.leagueType === 'keeper'; }

  /* ---------- searchable player picker ---------- */
  function playerRow(p) {
    return '<span class="pmain"><span class="pname">' + nameHtml(p) + '</span><span class="pmeta">' +
      esc(meta(p)) + '</span></span><span class="pval" title="Value over replacement">' + f0(p.vor) + '</span>';
  }

  /* opts: selected (player|null), options() -> players sorted by value,
   *       onPick(id), placeholder */
  function makePicker(host, opts) {
    host.innerHTML = '';
    host.className = 'picker';
    var hi = 0, shown = [];

    function showPicked() {
      host.innerHTML = '';
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'picked';
      b.innerHTML = playerRow(opts.selected);
      b.title = 'Tap to change';
      b.addEventListener('click', function () { showInput(true); });
      host.appendChild(b);
    }

    function showInput(focus) {
      host.innerHTML = '';
      var input = document.createElement('input');
      input.type = 'text'; input.placeholder = opts.placeholder || 'Search players…';
      input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', opts.placeholder || 'Search players');
      var menu = document.createElement('div');
      menu.className = 'menu'; menu.hidden = true;
      host.appendChild(input); host.appendChild(menu);

      function render() {
        var q = input.value.trim().toLowerCase();
        var all = opts.options();
        shown = [];
        for (var i = 0; i < all.length && shown.length < 50; i++) {
          var p = all[i];
          if (!q || (p.n + ' ' + p.t + ' ' + p.p).toLowerCase().indexOf(q) !== -1) shown.push(p);
        }
        hi = Math.min(hi, Math.max(0, shown.length - 1));
        menu.innerHTML = shown.length ? shown.map(function (p, i) {
          return '<button type="button" class="opt' + (i === hi ? ' hi' : '') + '" data-id="' + esc(p.id) + '">' +
            playerRow(p) + '</button>';
        }).join('') : '<div class="empty">No matching players' + (opts.emptyHint ? ' — ' + esc(opts.emptyHint) : '') + '</div>';
        menu.hidden = false;
      }
      function close() {
        menu.hidden = true;
        if (opts.selected) showPicked();
      }
      input.addEventListener('focus', render);
      input.addEventListener('input', function () { hi = 0; render(); });
      input.addEventListener('blur', function () { setTimeout(close, 120); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, shown.length - 1); render(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); render(); e.preventDefault(); }
        else if (e.key === 'Enter' && shown[hi]) { e.preventDefault(); opts.onPick(shown[hi].id); }
        else if (e.key === 'Escape') { input.blur(); }
        var el = menu.querySelector('.hi');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
      menu.addEventListener('mousedown', function (e) { e.preventDefault(); });
      menu.addEventListener('click', function (e) {
        var b = e.target.closest('.opt');
        if (b) opts.onPick(b.getAttribute('data-id'));
      });
      if (focus) input.focus();
    }

    if (opts.selected) showPicked(); else showInput(false);
  }

  /* ---------- settings form ---------- */
  function seg(id, value, onChange) {
    var el = $(id);
    Array.prototype.forEach.call(el.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === String(value));
      b.onclick = function () { onChange(b.getAttribute('data-v')); };
    });
  }
  var LINEUP_LABELS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'FLEX', SUPERFLEX: 'SUPERFLEX', K: 'K', DST: 'DST' };

  function renderSettings() {
    var s = state.settings;
    seg('set-leagueType', s.leagueType, function (v) { s.leagueType = v; settingsChanged(false); });
    seg('set-scoring', s.scoring, function (v) { s.scoring = v; settingsChanged(false); });
    $('set-teams').value = s.teams;
    $('set-keepers').value = s.keepers;
    $('set-faab').value = s.faab;
    $('set-bench').value = s.bench;
    $('set-ir').value = s.ir;
    $('set-lineup').innerHTML = E.STARTER_ORDER.map(function (t) {
      return '<div class="stepper"><span class="label">' + LINEUP_LABELS[t] + '</span><div class="ctl">' +
        '<button type="button" data-t="' + t + '" data-d="-1" aria-label="Fewer ' + t + '">−</button><b>' + s.lineup[t] +
        '</b><button type="button" data-t="' + t + '" data-d="1" aria-label="More ' + t + '">+</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.keeper-only'), function (el) { el.hidden = !isKeeper(); });
  }

  function num(el, lo, hi, fallback) {
    var v = parseInt(el.value, 10);
    if (isNaN(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
  }

  function bindSettings() {
    $('set-teams').addEventListener('change', function () {
      state.settings.teams = parseInt(this.value, 10); settingsChanged(false);
    });
    $('set-keepers').addEventListener('change', function () {
      state.settings.keepers = num(this, 0, 15, 3); settingsChanged(false);
    });
    $('set-faab').addEventListener('input', function () {
      state.settings.faab = this.value; save(); waiverCache = null; renderWaiver();
    });
    $('set-bench').addEventListener('change', function () {
      state.settings.bench = num(this, 0, 10, 6); settingsChanged(true);
    });
    $('set-ir').addEventListener('change', function () {
      state.settings.ir = num(this, 0, 5, 1); settingsChanged(true);
    });
    $('set-lineup').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-t]');
      if (!b) return;
      var t = b.getAttribute('data-t'), l = state.settings.lineup;
      var max = (t === 'K' || t === 'DST' || t === 'SUPERFLEX') ? 2 : (t === 'QB' || t === 'TE' ? 3 : 5);
      l[t] = Math.max(0, Math.min(max, l[t] + parseInt(b.getAttribute('data-d'), 10)));
      settingsChanged(true);
    });
    $('reset-settings').addEventListener('click', function () {
      state.settings = JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS));
      settingsChanged(true);
    });
  }

  function settingsChanged(slotsChanged) {
    ctx = E.prepare(data, state.settings);
    if (slotsChanged) {
      var res = E.rebuildSlots(state.slots, state.settings, ctx.byId);
      state.slots = res.slots;
      if (res.removed.length) {
        toast('No room left on the smaller roster, so these players were removed: ' +
          res.removed.map(function (id) { return ctx.byId[id].n; }).join(', ') + '.');
      } else { toast(''); }
    }
    save();
    renderAll();
  }

  function toast(msg) {
    var el = $('roster-msg');
    el.hidden = !msg; el.textContent = msg;
  }

  /* ---------- roster ---------- */
  function renderRoster() {
    var host = $('slots');
    host.innerHTML = '';
    var used = {};
    state.slots.forEach(function (s) { if (s.id) used[s.id] = true; });
    var prev = null;
    state.slots.forEach(function (slot, i) {
      var row = document.createElement('div');
      var section = slot.type === 'BENCH' ? 'bench' : (slot.type === 'IR' ? 'ir' : 'start');
      row.className = 'slot' + (prev && prev !== section ? ' sep' : '');
      prev = section;
      var label = slot.type === 'BENCH' ? 'BN' : (slot.type === 'SUPERFLEX' ? 'SFLX' : slot.type);
      row.innerHTML = '<span class="tag ' + section + '">' + label + '</span><div></div>';
      makePicker(row.children[1], {
        selected: slot.id ? ctx.byId[slot.id] : null,
        placeholder: 'Add ' + (section === 'start' ? E.ELIGIBLE[slot.type].join('/') : 'any player') + '…',
        options: function () {
          return ctx.players.filter(function (p) {
            return E.eligible(slot.type, p.p) && (!used[p.id] || p.id === slot.id);
          });
        },
        onPick: function (id) {
          if (slot.id !== id) { slot.cost = null; }
          slot.id = id;
          state.taken = state.taken.filter(function (t) { return t !== id; });
          rosterChanged();
        }
      });
      if (isKeeper()) {
        var c = document.createElement('input');
        c.type = 'number'; c.className = 'cost'; c.min = 1; c.max = 30; c.placeholder = 'Rd';
        c.title = 'Keeper cost: the draft round you give up to keep this player';
        c.setAttribute('aria-label', 'Keeper cost (draft round)');
        c.value = slot.cost || ''; c.disabled = !slot.id;
        c.addEventListener('change', function () {
          var v = parseInt(c.value, 10);
          slot.cost = isNaN(v) ? null : Math.max(1, Math.min(30, v));
          save(); renderKeeper(); renderTrade();
        });
        row.appendChild(c);
      } else { row.appendChild(document.createElement('span')); }
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'x'; x.textContent = '×';
      x.title = 'Clear this slot'; x.setAttribute('aria-label', 'Clear slot ' + (i + 1));
      x.style.visibility = slot.id ? 'visible' : 'hidden';
      x.addEventListener('click', function () { slot.id = null; slot.cost = null; rosterChanged(); });
      row.appendChild(x);
      host.appendChild(row);
    });

    var mine = myIds().map(function (id) { return ctx.byId[id]; });
    var n = ctx.weeks.length || 1;
    var lu = E.rosLineup(mine, ctx);
    $('roster-summary').innerHTML = mine.length ? '<div class="summary">' +
      stat('Lineup points / week', f1(lu.total / n)) +
      stat('Rest-of-season lineup', f0(lu.total)) +
      stat('Playoff weeks ' + ctx.cfg.playoffWeeks[0] + '–' + ctx.cfg.playoffWeeks[ctx.cfg.playoffWeeks.length - 1], f0(lu.playoff)) +
      stat('Roster spots used', mine.length + ' / ' + state.slots.length) + '</div>' : '';
  }
  function stat(k, v, c) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v + '</div></div>';
  }

  function rosterChanged() {
    var ids = myIds();
    state.trade.give = state.trade.give.filter(function (id) { return ids.indexOf(id) !== -1; });
    state.trade.get = state.trade.get.filter(function (id) { return ids.indexOf(id) === -1; });
    toast('');
    save();
    renderAll();
  }

  function renderKeeper() {
    if (!isKeeper()) return;
    var c = costs();
    var mine = myIds().map(function (id) { return ctx.byId[id]; });
    if (!mine.length) { $('keeper-table').innerHTML = '<p class="hint">Add players to your roster to see keeper values.</p>'; return; }
    var keep = E.bestKeepers(mine, c, ctx).map(function (k) { return k.id; });
    var rows = mine.map(function (p) { return { p: p, k: E.keeperInfo(p, c[p.id], ctx) }; })
      .sort(function (a, b) { return b.k.surplus - a.k.surplus; });
    $('keeper-table').innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Player</th><th title="Rest-of-season value over replacement">ROS value</th>' +
      '<th title="Next-season value over replacement">Next season</th><th>Blend</th><th>Implied round</th><th>Cost</th><th>Rounds saved</th><th>Surplus</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var k = r.k;
        return '<tr><td>' + nameHtml(r.p) + (keep.indexOf(r.p.id) !== -1 ? '<span class="badge">Keep</span>' : '') +
          '<div class="pmeta">' + esc(r.p.p + ' · ' + r.p.t + (r.p.age ? ' · age ' + Math.floor(r.p.age) : '')) + '</div></td>' +
          '<td class="' + cls(k.rosPart) + '">' + f0(k.rosPart) + '</td>' +
          '<td class="' + cls(k.nextPart) + '">' + f0(k.nextPart) + '</td>' +
          '<td>' + f0(k.blend) + '</td><td>Rd ' + k.impliedRound + '</td>' +
          '<td>' + (k.cost ? 'Rd ' + k.cost : '–') + '</td>' +
          '<td class="' + cls(k.roundsSaved || 0) + '">' + (k.roundsSaved == null ? '–' : signed(k.roundsSaved, 0)) + '</td>' +
          '<td class="' + cls(k.surplus) + '">' + signed(k.surplus, 0) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="hint">Blend = ' + Math.round(ctx.cfg.keeperRosWeight * 100) + '% rest-of-season + ' +
      Math.round(ctx.cfg.keeperNextWeight * 100) + '% next season. Surplus = next-season value minus the value of the draft pick you give up. ' +
      'Your best ' + state.settings.keepers + ' keeper' + (state.settings.keepers === 1 ? ' is' : 's are') + ' tagged “Keep”.</p>';
  }

  /* ---------- trade ---------- */
  function chip(p, side) {
    var div = document.createElement('div');
    div.className = 'chip';
    div.innerHTML = '<span class="pmain"><span class="pname">' + nameHtml(p) + '</span><span class="pmeta">' +
      esc(meta(p)) + ' · value ' + f0(p.vor) + '</span></span>';
    if (side === 'get' && isKeeper()) {
      var c = document.createElement('input');
      c.type = 'number'; c.className = 'cost'; c.min = 1; c.max = 30; c.placeholder = 'Rd';
      c.title = 'Keeper cost (draft round) this player would have on your team';
      c.setAttribute('aria-label', 'Keeper cost (draft round)');
      c.value = state.trade.costs[p.id] || '';
      c.addEventListener('change', function () {
        var v = parseInt(c.value, 10);
        if (isNaN(v)) delete state.trade.costs[p.id]; else state.trade.costs[p.id] = Math.max(1, Math.min(30, v));
        save(); renderTradeResult();
      });
      div.appendChild(c);
    } else { div.appendChild(document.createElement('span')); }
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + p.n);
    x.addEventListener('click', function () {
      state.trade[side] = state.trade[side].filter(function (id) { return id !== p.id; });
      save(); renderTrade();
    });
    div.appendChild(x);
    return div;
  }

  function renderTrade() {
    var ids = myIds(), t = state.trade;
    t.give = t.give.filter(function (id) { return ids.indexOf(id) !== -1 && ctx.byId[id]; });
    t.get = t.get.filter(function (id) { return ids.indexOf(id) === -1 && ctx.byId[id]; });
    makePicker($('give-picker'), {
      selected: null, placeholder: 'Add one of your players…',
      emptyHint: ids.length ? '' : 'add your roster on the first tab',
      options: function () {
        return ctx.players.filter(function (p) { return ids.indexOf(p.id) !== -1 && t.give.indexOf(p.id) === -1; });
      },
      onPick: function (id) { t.give.push(id); save(); renderTrade(); }
    });
    makePicker($('get-picker'), {
      selected: null, placeholder: 'Search any other player…',
      options: function () {
        return ctx.players.filter(function (p) { return ids.indexOf(p.id) === -1 && t.get.indexOf(p.id) === -1; });
      },
      onPick: function (id) { t.get.push(id); save(); renderTrade(); }
    });
    ['give', 'get'].forEach(function (side) {
      var host = $(side + '-list');
      host.innerHTML = '';
      t[side].forEach(function (id) { host.appendChild(chip(ctx.byId[id], side)); });
    });
    renderTradeResult();
  }

  function renderTradeResult() {
    var host = $('trade-result'), ids = myIds(), t = state.trade;
    if (!ids.length) {
      host.innerHTML = '<div class="card"><p class="hint">First add your roster on the <strong>Settings &amp; Roster</strong> tab. ' +
        'Trades are scored by how they change <em>your</em> starting lineup, so the calculator needs to know your team.</p></div>';
      return;
    }
    if (!t.give.length && !t.get.length) {
      host.innerHTML = '<div class="card"><p class="hint">Pick the players you would give and the players you would get. Multi-player deals are fine.</p></div>';
      return;
    }
    var r = E.evaluateTrade(ids, t.give, t.get, ctx, costs());
    var n = r.weeks, m = r.me;
    var head = r.verdict === 'win' ? 'You win this trade by ' + f1(m.total) + ' rest-of-season points'
      : r.verdict === 'lose' ? 'You lose this trade by ' + f1(-m.total) + ' rest-of-season points'
      : 'Roughly even (' + signed(m.total) + ' rest-of-season points)';
    var html = '<div class="card verdict ' + r.verdict + '"><p class="big">' + head + '</p>' +
      '<div class="summary">' +
      stat('Starting lineup, rest of season', signed(m.lineup), cls(m.lineup)) +
      stat('Per week (' + n + ' left)', signed(m.lineup / n), cls(m.lineup)) +
      stat('Playoff weeks ' + ctx.cfg.playoffWeeks.join('–').replace(/–\d+–/, '–'), signed(m.playoff), cls(m.playoff)) +
      stat('Bench depth', signed(m.bench), cls(m.bench)) +
      '</div><ul class="reasons">' + r.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';

    var th = r.them;
    var tv = r.theirVerdict === 'win' ? 'they come out ahead by ' + f1(th.total) + ' points'
      : r.theirVerdict === 'lose' ? 'they come out behind by ' + f1(-th.total) + ' points'
      : 'it is roughly even for them (' + signed(th.total) + ')';
    var sell = r.theirVerdict === 'lose' ? ' They would probably say no — consider adding something.'
      : (r.theirVerdict === 'win' && r.verdict === 'win' ? ' It helps both teams, so it has a real chance of being accepted.' : '');
    html += '<div class="card"><h2>The other team’s view <span class="sub">(estimate)</span></h2><p>From their side, ' + tv +
      ' (lineup ' + signed(th.lineup) + ', playoff weeks ' + signed(th.playoff) + ').' + sell + '</p>' +
      '<p class="hint">We can’t see their roster, so this assumes a league-average starter in each of their other lineup spots.</p></div>';

    if (r.keeper) {
      var k = r.keeper;
      var names = function (a) { return a.length ? a.map(function (id) { return esc(ctx.byId[id].n); }).join(', ') : 'none'; };
      html += '<div class="card"><h2>Keeper impact <span class="sub">(next season)</span></h2><div class="summary">' +
        stat('Next-season keeper value', signed(k.nextSeason, 0), cls(k.nextSeason)) +
        stat('Best keepers change?', k.changed ? 'Yes' : 'No') + '</div>' +
        '<p><strong>Best keepers now:</strong> ' + names(k.before) + '<br><strong>After the trade:</strong> ' + names(k.after) + '</p>' +
        (k.changed ? '<p>' + (k.added.length ? 'New keeper' + (k.added.length > 1 ? 's' : '') + ': ' + names(k.added) + '. ' : '') +
          (k.removed.length ? 'No longer kept: ' + names(k.removed) + '.' : '') + '</p>' : '') +
        '<p class="hint">Uses the keeper costs you entered (blank = free to keep). Add a round next to players you’d receive to include their cost.</p></div>';
    }

    var rows = function (list, label) {
      return list.map(function (id) {
        var p = ctx.byId[id];
        return '<tr><td>' + nameHtml(p) + '<div class="pmeta">' + label + ' · ' + esc(meta(p)) + '</div></td><td>' + f1(p.pg) +
          '</td><td>' + f0(p.ros) + '</td><td>' + f0(p.po) + '</td><td class="' + cls(p.vor) + '">' + f0(p.vor) + '</td>' +
          (isKeeper() ? '<td>' + f0(p.nsVor) + '</td>' : '') + '</tr>';
      }).join('');
    };
    html += '<div class="card"><h2>Players in this deal</h2><div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Pts/game</th><th>ROS pts</th><th>Playoff pts</th><th>Value</th>' +
      (isKeeper() ? '<th>Next season</th>' : '') + '</tr></thead><tbody>' + rows(t.give, 'You give') + rows(t.get, 'You get') + '</tbody></table></div></div>';
    host.innerHTML = html;
  }

  /* ---------- waiver ---------- */
  function waiver() {
    if (!waiverCache) waiverCache = E.waiverRank(myIds(), state.showTaken ? [] : state.taken, ctx, costs());
    return waiverCache;
  }

  function renderWaiver() {
    if (!ctx) return;
    seg('waiver-pos', state.waiverPos, function (v) { state.waiverPos = v; waiverShown = 30; save(); renderWaiver(); });
    $('taken-count').textContent = state.taken.length;
    $('show-taken').checked = state.showTaken;
    var w = waiver(), q = $('waiver-search').value.trim().toLowerCase();
    var budget = parseFloat(state.settings.faab);
    var hasFaab = !isNaN(budget) && budget > 0;

    // drop candidates
    var ids = myIds();
    $('drops-card').hidden = !ids.length;
    if (ids.length) {
      var best = w.list[0];
      $('drops').innerHTML = w.drops.length ? '<div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Weeks he’d start</th><th title="Lineup points you lose without him, plus a little for depth">Cost of dropping</th></tr></thead><tbody>' +
        w.drops.map(function (d) {
          var p = ctx.byId[d.id];
          var better = best && best.score > d.keepValue;
          return '<tr><td>' + nameHtml(p) + (better ? '' : '<span class="badge warn">Hold</span>') + '<div class="pmeta">' + esc(meta(p)) + '</div></td><td>' +
            d.starts + ' of ' + ctx.weeks.length + '</td><td>' + f1(d.keepValue) + ' pts</td></tr>';
        }).join('') + '</tbody></table></div><p class="hint">These bench players help your lineup least. Drop one when a waiver player’s score is higher than the cost of dropping.' +
        (isKeeper() ? ' Your best keepers are never suggested.' : '') + '</p>'
        : '<p class="hint">No obvious drops — everyone on your bench is contributing.</p>';
    }

    var list = w.list.filter(function (x) {
      var p = ctx.byId[x.id];
      if (state.waiverPos !== 'ALL' && p.p !== state.waiverPos) return false;
      return !q || (p.n + ' ' + p.t).toLowerCase().indexOf(q) !== -1;
    });
    var host = $('waiver-list');
    host.innerHTML = list.length ? '' : '<div class="card"><p class="hint">No players match.</p></div>';
    list.slice(0, waiverShown).forEach(function (x, i) {
      var p = ctx.byId[x.id], taken = state.taken.indexOf(p.id) !== -1;
      var arrow = x.trend >= 0.75 ? '<span class="up">▲ ' + f1(x.trend) + '</span>'
        : x.trend <= -0.75 ? '<span class="down">▼ ' + f1(-x.trend) + '</span>' : '<span>● flat</span>';
      var bid;
      if (hasFaab) bid = '$' + x.bid[0] + '–$' + x.bid[1] + '<small>' + x.bidPct[0] + '–' + x.bidPct[1] + '% of budget</small>';
      else bid = x.priority + ' priority<small>FAAB: ' + x.bidPct[0] + '–' + x.bidPct[1] + '% of budget</small>';
      var u = p.u || {};
      var card = document.createElement('div');
      card.className = 'card wv' + (taken ? ' taken' : '');
      card.innerHTML = '<div class="rank">' + (i + 1) + '</div><div><div class="pname">' + nameHtml(p) + '</div><div class="pmeta">' + esc(meta(p)) +
        (p.age ? ' · age ' + Math.floor(p.age) : '') + '</div>' +
        '<div class="nums"><span>Score <b>' + f1(x.score) + '</b></span><span>Lineup gain <b>' + signed(x.gain) + '</b></span><span>Pts/g <b>' + f1(p.pg) +
        '</b></span><span>Trend <b>' + arrow + '</b></span>' +
        (u.ts != null && p.p !== 'QB' ? '<span>Targets <b>' + pct(u.ts) + '</b></span>' : '') +
        (u.cs != null && u.cs >= 0.03 ? '<span>Carries <b>' + pct(u.cs) + '</b></span>' : '') +
        (u.snap != null ? '<span>Snaps <b>' + pct(u.snap) + '</b></span>' : '') +
        (u.rz != null && u.rz >= 0.3 ? '<span>Red-zone/g <b>' + f1(u.rz) + '</b></span>' : '') + '</div>' +
        '<div class="tags">' + x.tags.map(function (tg) {
          var c = /falling|Tough|^IR$|^Out$|^PUP$|^Sus$|Doubtful|Questionable|Inactive/.test(tg) ? ' warn' : '';
          return '<span class="badge' + c + '">' + esc(tg) + '</span>';
        }).join('') + '</div></div>' +
        '<div class="side"><div class="bid">' + bid + '</div><label class="check"><input type="checkbox" data-id="' + esc(p.id) + '"' +
        (taken ? ' checked' : '') + '> Taken</label></div>';
      host.appendChild(card);
    });
    $('waiver-more').hidden = list.length <= waiverShown;
  }

  function bindWaiver() {
    $('waiver-search').addEventListener('input', function () { waiverShown = 30; renderWaiver(); });
    $('waiver-more').addEventListener('click', function () { waiverShown += 30; renderWaiver(); });
    $('show-taken').addEventListener('change', function () { state.showTaken = this.checked; waiverCache = null; renderWaiver(); });
    $('reset-taken').addEventListener('click', function () { state.taken = []; waiverCache = null; save(); renderWaiver(); });
    $('mark-likely').addEventListener('click', function () {
      var mine = myIds();
      var others = (state.settings.teams - 1) * E.rosterCapacity(state.settings);
      var count = Math.round(others * 0.85);
      var set = {};
      state.taken.forEach(function (id) { set[id] = true; });
      ctx.players.filter(function (p) { return mine.indexOf(p.id) === -1; }).slice(0, count)
        .forEach(function (p) { set[p.id] = true; });
      state.taken = Object.keys(set);
      waiverCache = null; save(); renderWaiver();
    });
    $('waiver-list').addEventListener('change', function (e) {
      var id = e.target.getAttribute && e.target.getAttribute('data-id');
      if (!id) return;
      if (e.target.checked) { if (state.taken.indexOf(id) === -1) state.taken.push(id); }
      else state.taken = state.taken.filter(function (t) { return t !== id; });
      waiverCache = null; save(); renderWaiver();
    });
  }

  /* ---------- tabs & page chrome ---------- */
  function showTab(name) {
    state.tab = name;
    ['roster', 'trade', 'waiver'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    save();
  }

  function renderAll() {
    waiverCache = null;
    renderSettings();
    renderRoster();
    renderKeeper();
    renderTrade();
    renderWaiver();
  }

  function renderMeta() {
    var m = data.meta;
    var d = new Date(m.generated + 'T12:00:00Z');
    var date = isNaN(d) ? m.generated : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    $('asof').textContent = 'Data as of Week ' + m.week + ' (' + date + ')' +
      (m.weekPartial ? ' · week ' + m.week + ' still in progress' : '') + ' · ' + m.season + ' season';
    if (m.notes && m.notes.length) {
      $('notes').hidden = false;
      $('notes').innerHTML = '<strong>Notes on this update</strong><ul>' +
        m.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    }
    $('sources').innerHTML = m.sources.map(function (s) {
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' +
        (s.license ? ' (' + esc(s.license) + ')' : '') + '</li>';
    }).join('') + '<li>Player names, teams and ages in this update came from: ' + esc(m.identitySource) + '.</li>';
  }

  function start(json) {
    data = json;
    ctx = E.prepare(data, state.settings);
    state.slots = E.rebuildSlots(state.slots, state.settings, ctx.byId).slots;
    state.taken = state.taken.filter(function (id) { return ctx.byId[id]; });
    renderMeta();
    bindSettings();
    bindWaiver();
    $('optimize').addEventListener('click', function () {
      state.slots = E.optimizeSlots(state.slots, ctx); rosterChanged();
    });
    $('clear-roster').addEventListener('click', function () {
      if (myIds().length && !window.confirm('Remove every player from your roster?')) return;
      state.slots = E.buildSlots(state.settings); rosterChanged();
    });
    $('clear-trade').addEventListener('click', function () {
      state.trade = { give: [], get: [], costs: {} }; save(); renderTrade();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });
    showTab(state.tab);
    renderAll();
  }

  load();
  fetch('data/players.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(start)
    .catch(function (e) {
      $('asof').textContent = 'Could not load player data.';
      var el = $('error');
      el.hidden = false;
      el.textContent = 'Player data failed to load (' + e.message + '). Try refreshing the page. If this keeps happening, the weekly data update may not have run yet.';
    });
})();
