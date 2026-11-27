/* global campaignTrail_temp, PROPS, A, electionNight, renderOptions, modded */

/*
 * Campaign Trail Showcase - Multiplayer (1968)
 *
 * Two or three people each run a campaign as a different 1968 candidate (Nixon, Humphrey,
 * Wallace). Every player plays the normal game on their own device. When their campaign ends,
 * the game hands them a "ballot code" (their answers and state visits). Once the ballots of all
 * human players are collected, anyone can hold election night: every ballot is applied to the
 * same election, with a seed derived from the ballots, so every device computes and shows the
 * identical result. Candidates nobody plays are run by the computer, as usual.
 *
 * This is a static site, so there is no server: ballots are exchanged by copy and paste.
 *
 * The pure logic (ballot codes, seeding, question-set parsing) lives in the "core" section so it
 * can be unit-tested in Node. The rest is UI and engine glue.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* core (pure)                                                         */
  /* ------------------------------------------------------------------ */

  const ELECTION_ID = 4; // 1968 in static/json/election.json
  const YEAR = 1968;
  const CANDIDATES = [23, 24, 25]; // Nixon, Humphrey, Wallace (canonical order)
  const CODE_PREFIX = 'CTMP1';
  const MAX_QUESTIONS = 25;

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(n) {
    return (n >>> 0).toString(16).padStart(8, '0');
  }

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 24);
  }

  function encodeBallot(b) {
    const payload = {
      v: 1,
      e: ELECTION_ID,
      c: Number(b.candidate),
      r: Number(b.runningMate),
      n: cleanName(b.name),
      a: (b.answers || []).map((x) => (x == null ? null : Number(x))),
      p: (b.visits || []).map((x) => Number(x)),
    };
    const body = b64urlEncode(JSON.stringify(payload));
    return `${CODE_PREFIX}.${body}.${hex8(fnv1a(body))}`;
  }

  function decodeBallot(code) {
    try {
      const parts = String(code || '').trim().split('.');
      if (parts.length !== 3 || parts[0] !== CODE_PREFIX) {
        return { ok: false, error: 'That does not look like a multiplayer ballot code.' };
      }
      if (hex8(fnv1a(parts[1])) !== parts[2].toLowerCase()) {
        return { ok: false, error: 'This ballot code is damaged (checksum mismatch). Copy it again in full.' };
      }
      const p = JSON.parse(b64urlDecode(parts[1]));
      if (p.v !== 1 || p.e !== ELECTION_ID) {
        return { ok: false, error: 'This ballot is for a different scenario or version.' };
      }
      if (!CANDIDATES.includes(p.c)) {
        return { ok: false, error: 'This ballot is for a candidate that is not playable in 1968 multiplayer.' };
      }
      if (!Array.isArray(p.a) || p.a.length > MAX_QUESTIONS + 1
        || !p.a.every((x) => x === null || Number.isInteger(x))) {
        return { ok: false, error: 'This ballot has invalid answers.' };
      }
      if (!Array.isArray(p.p) || p.p.length > 2 * MAX_QUESTIONS || !p.p.every(Number.isFinite)) {
        return { ok: false, error: 'This ballot has invalid state visits.' };
      }
      return {
        ok: true,
        ballot: {
          candidate: p.c, runningMate: p.r, name: cleanName(p.n), answers: p.a, visits: p.p,
        },
        code: String(code).trim(),
      };
    } catch (err) {
      return { ok: false, error: 'This ballot code could not be read.' };
    }
  }

  // Everyone who holds the same set of ballots gets the same seed, whatever order they were added in.
  function seedFromCodes(codes) {
    return fnv1a([...codes].sort().join('|'));
  }

  function mulberry32(seed) {
    let a = seed | 0;
    return function rng() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Box-Muller needs Math.log, which engines are allowed to round differently. A sum of twelve
  // uniforms uses only plain IEEE addition, so every browser produces bit-identical numbers.
  function makeDeterministicNormal(rng) {
    return function deterministicNormal() {
      let s = 0;
      for (let i = 0; i < 12; i += 1) s += rng();
      return s - 6;
    };
  }

  const TABLE_NAMES = [
    'questions_json', 'answers_json', 'states_json', 'issues_json', 'state_issue_score_json',
    'candidate_issue_score_json', 'running_mate_issue_score_json', 'candidate_state_multiplier_json',
    'answer_score_global_json', 'answer_score_issue_json', 'answer_score_state_json',
  ];

  // Question set pages assign their data with JSON.parse("...") calls; read them without eval.
  function parseQuestionSet(html) {
    const tables = {};
    const re = /campaignTrail_temp\.(\w+)\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\);/g;
    let m = re.exec(html);
    while (m) {
      if (TABLE_NAMES.includes(m[1])) tables[m[1]] = JSON.parse(JSON.parse(`"${m[2]}"`));
      m = re.exec(html);
    }
    const scalars = {};
    const re2 = /campaignTrail_temp\.(\w+)\s*=\s*'([^']*)';/g;
    m = re2.exec(html);
    while (m) {
      scalars[m[1]] = m[2];
      m = re2.exec(html);
    }
    return { tables, scalars };
  }

  // Check a ballot against the question set it claims to come from.
  function validateAgainstSet(ballot, tables) {
    const answerPks = new Set((tables.answers_json || []).map((a) => a.pk));
    const statePks = new Set((tables.states_json || []).map((s) => s.pk));
    if (!ballot.answers.every((x) => x === null || answerPks.has(x))) {
      return 'contains an answer that does not exist in that candidate\'s 1968 question set';
    }
    if (!ballot.visits.every((x) => statePks.has(x))) {
      return 'contains a state visit that does not exist';
    }
    return null;
  }

  // A short fingerprint players can compare to confirm they all saw the same result.
  function resultFingerprint(stateResults) {
    const parts = [];
    stateResults.forEach((s) => {
      parts.push(`${s.state}:${s.result.map((r) => `${r.candidate}=${r.votes}/${r.electoral_votes}`).join(',')}`);
    });
    const h = hex8(fnv1a(parts.join(';'))).toUpperCase();
    return `${h.slice(0, 4)}-${h.slice(4)}`;
  }

  function evTotals(stateResults) {
    const totals = {};
    stateResults.forEach((s) => s.result.forEach((r) => {
      totals[r.candidate] = (totals[r.candidate] || 0) + (r.electoral_votes || 0);
    }));
    return totals;
  }

  const core = {
    ELECTION_ID,
    YEAR,
    CANDIDATES,
    fnv1a,
    encodeBallot,
    decodeBallot,
    seedFromCodes,
    mulberry32,
    makeDeterministicNormal,
    parseQuestionSet,
    validateAgainstSet,
    resultFingerprint,
    evTotals,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  /* ------------------------------------------------------------------ */
  /* browser UI and engine glue                                          */
  /* ------------------------------------------------------------------ */

  const STORE_KEY = 'ctmp_ballots_v1';
  const OPEN_KEY = 'ctmp_open_picker';

  const CTMP = { active: false, pending: null };
  window.CTMP = CTMP;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c]));

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function saveStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (err) { /* private mode */ }
  }

  function candName(id) {
    const c = PROPS.CANDIDATES.get(String(id));
    return c ? `${c.first_name} ${c.last_name}` : `Candidate ${id}`;
  }

  function lastName(id) {
    const c = PROPS.CANDIDATES.get(String(id));
    return c ? c.last_name : String(id);
  }

  function shell(inner) {
    const gw = document.getElementById('game_window');
    gw.innerHTML = `
      <div class="game_header">${window.corrr || '<h2>CAMPAIGN TRAIL SHOWCASE</h2>'}</div>
      <div class="inner_window_w_desc" id="ctmp_panel" style="text-align:left;padding:12px 18px;">${inner}</div>`;
    const bb = document.getElementById('bottomBar');
    if (bb) gw.appendChild(bb);
  }

  function dataReady() {
    return PROPS.CANDIDATES.size > 0 && (window.campaignTrail_temp.running_mate_json || []).length > 0;
  }

  function open() {
    CTMP.active = false;
    ['modloaddiv', 'modLoadReveal', 'featured-mods-area'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    if (typeof modded !== 'undefined' && modded) {
      shell(`<h3>1968 Multiplayer</h3>
        <p>A mod is loaded in this tab. Reload the page, then open Multiplayer before loading anything else.</p>
        <p><button class="person_button" id="ctmp_reload">Reload</button></p>`);
      document.getElementById('ctmp_reload').onclick = () => window.location.reload();
      return;
    }
    if (!dataReady()) {
      shell('<h3>1968 Multiplayer</h3><p>Loading game data...</p>');
      setTimeout(open, 400);
      return;
    }
    screenHome();
  }

  function slotRows(store) {
    return CANDIDATES.map((id) => {
      const b = store[id];
      const who = b
        ? `<strong>${esc(b.name || 'Player')}</strong> <small>(${b.local ? 'played on this device' : 'pasted ballot'})</small>`
        : '<em>Computer</em>';
      return `<li><span style="color:${esc(PROPS.CANDIDATES.get(String(id))?.color_hex || '#000')}">&#9632;</span> ${esc(candName(id))}: ${who}</li>`;
    }).join('');
  }

  function screenHome() {
    const store = loadStore();
    const count = Object.keys(store).length;
    shell(`
      <h3>1968 Multiplayer</h3>
      <p>Two or three players each run a campaign as a different candidate: Nixon, Humphrey or Wallace.
      Anyone nobody plays is run by the computer.</p>
      <ol>
        <li>Each player runs a normal 1968 campaign on their own device (or take turns on one device).</li>
        <li>At the end you get a <strong>ballot code</strong>. Send it to the other players.</li>
        <li>Everyone pastes all the ballots here and holds election night. All devices show the same result.</li>
      </ol>
      <p><small>Multiplayer uses the Default (Winner-Take-All) mode on Normal difficulty for everyone.</small></p>
      <h4>Players so far</h4>
      <ul style="list-style:none;padding-left:0;">${slotRows(store)}</ul>
      <p>
        <button class="person_button" id="ctmp_play">Run a campaign</button>
        <button class="person_button" id="ctmp_collect"${count ? '' : ' disabled'}>Collect ballots &amp; hold election night</button>
      </p>
      <p>
        <button class="person_button" id="ctmp_reset">Clear saved ballots</button>
        <button class="person_button" id="ctmp_back">Back</button>
      </p>`);
    document.getElementById('ctmp_play').onclick = screenPicker;
    document.getElementById('ctmp_collect').onclick = () => screenBallots(null);
    document.getElementById('ctmp_reset').onclick = () => { saveStore({}); screenHome(); };
    document.getElementById('ctmp_back').onclick = () => window.location.reload();
  }

  function screenPicker() {
    const store = loadStore();
    const e = window.campaignTrail_temp;
    const candOptions = CANDIDATES.map((id) => {
      const taken = store[id] ? ' disabled' : '';
      return `<option value="${id}"${taken}>${esc(candName(id))}${store[id] ? ' (ballot already saved)' : ''}</option>`;
    }).join('');
    const firstFree = CANDIDATES.find((id) => !store[id]);
    if (!firstFree) {
      shell(`<h3>1968 Multiplayer</h3><p>All three candidates already have a saved ballot. Clear the saved ballots to start over.</p>
        <p><button class="person_button" id="ctmp_b">Back</button></p>`);
      document.getElementById('ctmp_b').onclick = screenHome;
      return;
    }
    shell(`
      <h3>Choose your candidate</h3>
      <p><label>Your name: <input id="ctmp_name" maxlength="24" placeholder="Player name" style="padding:4px;"></label></p>
      <p><select id="ctmp_cand">${candOptions}</select></p>
      <p><select id="ctmp_rm"></select></p>
      <div class="person_description_window" id="ctmp_desc"></div>
      <p>
        <button class="person_button" id="ctmp_go">Start campaign</button>
        <button class="person_button" id="ctmp_b">Back</button>
      </p>`);
    const candSel = document.getElementById('ctmp_cand');
    const rmSel = document.getElementById('ctmp_rm');
    candSel.value = String(firstFree);

    const fillRunningMates = () => {
      const cand = Number(candSel.value);
      rmSel.innerHTML = e.running_mate_json
        .filter((f) => f.fields.candidate === cand)
        .map((f) => `<option value="${f.fields.running_mate}">${esc(candName(f.fields.running_mate))}</option>`)
        .join('');
      const c = PROPS.CANDIDATES.get(String(cand));
      document.getElementById('ctmp_desc').innerHTML = c ? c.description : '';
    };
    candSel.onchange = fillRunningMates;
    fillRunningMates();
    document.getElementById('ctmp_b').onclick = screenHome;
    document.getElementById('ctmp_go').onclick = () => launch(
      Number(candSel.value),
      Number(rmSel.value),
      document.getElementById('ctmp_name').value,
    );
  }

  function launch(cand, rm, name) {
    const e = window.campaignTrail_temp;
    CTMP.active = true;
    CTMP.pending = { candidate: cand, runningMate: rm, name: cleanName(name) || candName(cand) };

    e.election_id = ELECTION_ID;
    e.candidate_id = cand;
    renderOptions(ELECTION_ID, cand, rm);

    // Everyone plays the same mode so results are comparable.
    const normal = (e.difficulty_level_json || []).find((d) => d.fields.name === 'Normal');
    document.getElementById('game_type_id').value = '1';
    if (normal) document.getElementById('difficulty_level_id').value = String(normal.pk);
    document.getElementById('opponent_selection_id_button').click();
  }

  // Called by the engine at the end of the last question (see nextQuestion in campaign_trail.js).
  CTMP.onCampaignEnd = function onCampaignEnd() {
    const e = window.campaignTrail_temp;
    const pending = CTMP.pending;
    if (!CTMP.active || !pending) return false;

    const code = encodeBallot({
      candidate: e.candidate_id,
      runningMate: e.running_mate_id,
      name: pending.name,
      answers: e.player_answers,
      visits: e.player_visits,
    });
    const store = loadStore();
    store[e.candidate_id] = { code, name: pending.name, local: true };
    saveStore(store);
    CTMP.viewer = e.candidate_id;
    screenBallots(code);
    return true;
  };

  function screenBallots(ownCode, message) {
    const store = loadStore();
    const count = Object.keys(store).length;
    shell(`
      <h3>${ownCode ? 'Your campaign is over' : 'Collect ballots'}</h3>
      ${ownCode ? `<p>Send this ballot code to the other players:</p>
        <textarea id="ctmp_own" readonly rows="4" style="width:98%;font-size:11px;">${esc(ownCode)}</textarea>
        <p><button class="person_button" id="ctmp_copy">Copy my ballot</button></p>` : ''}
      <h4>Players</h4>
      <ul style="list-style:none;padding-left:0;">${slotRows(store)}</ul>
      <p>Paste another player's ballot code:</p>
      <textarea id="ctmp_paste" rows="3" style="width:98%;font-size:11px;" placeholder="CTMP1...."></textarea>
      <p id="ctmp_msg" style="color:#a00;min-height:1.2em;">${message ? esc(message) : ''}</p>
      <p>
        <button class="person_button" id="ctmp_add">Add ballot</button>
        <button class="person_button" id="ctmp_another">Another player on this device</button>
      </p>
      <p>
        <button class="person_button" id="ctmp_hold"${count >= 2 ? '' : ' disabled'}>Hold election night</button>
        <button class="person_button" id="ctmp_home">Menu</button>
      </p>
      ${count >= 2 ? '' : '<p><small>You need at least two human ballots. With one, just play the normal game.</small></p>'}`);

    const copyBtn = document.getElementById('ctmp_copy');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const ta = document.getElementById('ctmp_own');
        const done = () => { copyBtn.textContent = 'Copied!'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ownCode).then(done, () => { ta.select(); document.execCommand('copy'); done(); });
        } else { ta.select(); document.execCommand('copy'); done(); }
      };
    }
    document.getElementById('ctmp_add').onclick = () => {
      const r = decodeBallot(document.getElementById('ctmp_paste').value);
      if (!r.ok) { screenBallots(ownCode, r.error); return; }
      const cur = loadStore();
      if (cur[r.ballot.candidate]) {
        screenBallots(ownCode, `${candName(r.ballot.candidate)} already has a ballot. Each candidate can have only one human player.`);
        return;
      }
      cur[r.ballot.candidate] = { code: r.code, name: r.ballot.name || candName(r.ballot.candidate), local: false };
      saveStore(cur);
      screenBallots(ownCode);
    };
    document.getElementById('ctmp_another').onclick = () => {
      try { sessionStorage.setItem(OPEN_KEY, '1'); } catch (err) { /* ignore */ }
      window.location.reload(); // a fresh page for the next player's campaign
    };
    document.getElementById('ctmp_hold').onclick = holdElectionNight;
    document.getElementById('ctmp_home').onclick = screenHome;
  }

  async function holdElectionNight() {
    const e = window.campaignTrail_temp;
    const store = loadStore();
    const entries = [];
    for (const id of CANDIDATES) {
      if (!store[id]) continue;
      const r = decodeBallot(store[id].code);
      if (!r.ok) { screenBallots(null, `Ballot for ${candName(id)}: ${r.error}`); return; }
      entries.push({ code: r.code, ...r.ballot });
    }
    if (entries.length < 2) { screenBallots(null, 'You need at least two human ballots.'); return; }

    shell('<h3>Counting ballots...</h3><p>Loading each candidate\'s question set.</p>');

    const players = [];
    let shared = null;
    try {
      for (const b of entries) {
        const url = `../static/questionset/${YEAR}_${lastName(b.candidate)}_${lastName(b.runningMate)}.html`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Could not load ${url} (${resp.status})`);
        const { tables, scalars } = parseQuestionSet(await resp.text());
        const problem = validateAgainstSet(b, tables);
        if (problem) { screenBallots(null, `The ballot for ${candName(b.candidate)} ${problem}.`); return; }
        if (!shared) shared = tables;
        players.push({
          candidate_id: b.candidate,
          answers: b.answers,
          visits: b.visits,
          running_mate_state_id: scalars.running_mate_state_id,
          name: b.name,
          tables: {
            answer_score_global_json: tables.answer_score_global_json,
            answer_score_issue_json: tables.answer_score_issue_json,
            answer_score_state_json: tables.answer_score_state_json,
            running_mate_issue_score_json: tables.running_mate_issue_score_json,
          },
        });
      }
    } catch (err) {
      screenBallots(null, `Could not load the game data: ${err.message}`);
      return;
    }

    // Tables every player shares come from the same set on every device.
    ['states_json', 'issues_json', 'state_issue_score_json',
      'candidate_issue_score_json', 'candidate_state_multiplier_json'].forEach((k) => { e[k] = shared[k]; });

    const normal = (e.difficulty_level_json || []).find((d) => d.fields.name === 'Normal');
    e.difficulty_level_multiplier = normal ? normal.fields.multiplier : 0.97;
    e.game_type_id = '1';
    e.matchup = CANDIDATES.slice();
    e.mp_players = players;
    e.primary_states = null;

    const viewer = (CTMP.viewer && store[CTMP.viewer]) ? CTMP.viewer : players[0].candidate_id;
    e.candidate_id = viewer;
    e.opponents_list = CANDIDATES.filter((c) => c !== viewer);
    e.question_number = Number(PROPS.PARAMS.question_count);

    const seed = seedFromCodes(entries.map((b) => b.code));
    const rng = mulberry32(seed);
    const realNormal = window.randomNormal;
    Math.random = rng;
    window.randomNormal = makeDeterministicNormal(rng);
    try {
      e.final_state_results = A(1);
    } finally {
      window.randomNormal = realNormal;
    }

    const evs = evTotals(e.final_state_results);
    const fingerprint = resultFingerprint(e.final_state_results);
    electionNight();
    showBanner(players, evs, fingerprint);
  }

  function showBanner(players, evs, fingerprint) {
    const old = document.getElementById('ctmp_banner');
    if (old) old.remove();
    const humans = new Set(players.map((p) => p.candidate_id));
    const line = CANDIDATES.map((id) => {
      const p = players.find((x) => x.candidate_id === id);
      return `${esc(lastName(id))} (${p ? esc(p.name) : 'computer'}): ${evs[id] || 0} EV`;
    }).join(' &nbsp;|&nbsp; ');
    const div = document.createElement('div');
    div.id = 'ctmp_banner';
    div.style.cssText = 'margin:8px auto;max-width:900px;padding:6px 10px;border:2px solid #444;background:#fff;color:#000;font-size:13px;text-align:center;';
    div.innerHTML = `<strong>1968 Multiplayer</strong> &mdash; ${line}<br>
      <small>${humans.size} human players. Result ID ${fingerprint} (should match on every device).</small>`;
    const gw = document.getElementById('game_window');
    gw.parentNode.insertBefore(div, gw);
  }

  function addMenuButton() {
    const start = document.getElementById('game_start');
    if (!start || document.getElementById('ctmp_menu_button')) return;
    const btn = document.createElement('button');
    btn.id = 'ctmp_menu_button';
    btn.type = 'button';
    btn.innerHTML = '<strong>1968 Multiplayer</strong>';
    btn.style.marginLeft = '10px';
    btn.addEventListener('click', (ev) => { ev.preventDefault(); open(); });
    const host = start.parentElement;
    host.appendChild(btn);
  }

  CTMP.open = open;
  addMenuButton();

  let autoOpen = false;
  try { autoOpen = sessionStorage.getItem(OPEN_KEY) === '1'; sessionStorage.removeItem(OPEN_KEY); } catch (err) { /* ignore */ }
  if (autoOpen) {
    const tryOpen = () => {
      if (!dataReady()) { setTimeout(tryOpen, 300); return; }
      open();
      screenPicker();
    };
    tryOpen();
  }
}());
