'use strict';

/*
 * Daily Incident: one hidden fault per UTC day, the SAME for every visitor —
 * the scenario is picked with a date-seeded RNG, so there is no backend and
 * no cost. Tracks guesses and time, keeps a local streak, and produces a
 * shareable emoji result card.
 */
(() => {
  const { SCENARIOS, call } = window.INCIDENTS;

  // ---- date math: one puzzle per UTC day ----
  const EPOCH_DAY = Date.UTC(2026, 6, 2) / 86400000; // #1 = 2026-07-02 UTC
  const now = new Date();
  const todayDay = Math.floor(Date.now() / 86400000);
  const puzzleNo = todayDay - EPOCH_DAY + 1;
  const todayKey = new Date(todayDay * 86400000).toISOString().slice(0, 10);

  // deterministic RNG seeded from the day — same scenario worldwide
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(todayDay * 2654435761);
  const scenario = SCENARIOS[Math.floor(rng() * SCENARIOS.length)];

  function seededShuffle(arr, rand) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const options = seededShuffle([scenario.correct, ...scenario.wrong], rng);

  // ---- local history: streak + today's result ----
  const store = {
    load() {
      try { return JSON.parse(localStorage.getItem('daily-incident') || '{}'); }
      catch { return {}; }
    },
    save(data) { localStorage.setItem('daily-incident', JSON.stringify(data)); },
  };

  let state = store.load();
  let attempts = 0;
  let wrongGuesses = [];
  const startedAt = Date.now();

  function recordResult(won, seconds) {
    // streak: increments if the last win was yesterday, resets otherwise
    const prev = state.lastWonDay;
    const streak = won ? ((prev === todayDay - 1 ? (state.streak || 0) : 0) + 1) : 0;
    state = {
      ...state,
      streak,
      lastWonDay: won ? todayDay : state.lastWonDay,
      [todayKey]: { won, attempts, seconds, wrong: wrongGuesses.length },
    };
    store.save(state);
  }

  function fmtDuration(s) {
    s = Math.max(0, Math.round(Number(s) || 0)); // stored values are untrusted
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }

  function shareText(result) {
    // coerce stored (user-editable) values before they reach any HTML
    const wrong = Math.min(10, Math.max(0, Math.round(Number(result.wrong) || 0)));
    const attempts = Math.max(1, Math.round(Number(result.attempts) || 1));
    const squares = '🟥'.repeat(wrong) + (result.won ? '🟩' : '⬛');
    return `🚨 Daily Incident #${puzzleNo} — ${result.won ? `diagnosed in ${attempts} guess${attempts > 1 ? 'es' : ''}, ${fmtDuration(result.seconds)}` : 'stumped me'}\n${squares}\n👉 https://learnwithts.in/daily/`;
  }

  function countdown() {
    const next = (todayDay + 1) * 86400000;
    const left = Math.max(0, next - Date.now());
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  // ------------------------------------------------------------------ UI

  const css = document.createElement('style');
  css.textContent = `
    #incident-panel {
      position: fixed; right: 14px; bottom: 14px; width: 330px; z-index: 50;
      background: var(--panel); border: 1px solid var(--red); border-radius: 10px;
      padding: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.5); font-size: .88rem;
    }
    #incident-panel h3 { margin: 0 0 8px; color: var(--red); font-size: 1rem; }
    #incident-panel.solved { border-color: var(--green); }
    #incident-panel.solved h3 { color: var(--green); }
    #incident-panel label { display: block; margin: 6px 0; cursor: pointer; }
    #incident-panel .clue { color: var(--dim); font-style: italic; margin: 8px 0; }
    #incident-panel .explain { background: var(--panel2); border-radius: 6px; padding: 8px; margin: 8px 0; }
    #incident-panel .verdict { font-weight: 600; margin: 8px 0; }
    #incident-panel .row2 { display: flex; gap: 8px; }
    #incident-panel button { flex: 1; }
    #incident-panel .meta { float: right; color: var(--dim); font-size: .8rem; }
    #incident-panel .share-box { background: var(--panel2); border-radius: 6px; padding: 8px; margin: 8px 0; white-space: pre-wrap; font-family: monospace; font-size: .8rem; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('div');
  panel.id = 'incident-panel';
  document.body.appendChild(panel);

  function renderQuiz() {
    panel.className = '';
    panel.innerHTML = `
      <h3>🗓 Daily Incident #${puzzleNo} <span class="meta">streak: ${Math.max(0, Math.round(Number(state.streak) || 0))}</span></h3>
      <div>"${scenario.report}"</div>
      <div class="clue">💡 ${scenario.clue}</div>
      <div><b>${scenario.question}</b></div>
      ${options.map(o => `<label><input type="radio" name="diag" value="${encodeURIComponent(o)}"> ${o}</label>`).join('')}
      <div class="verdict" id="daily-verdict"></div>
      <div class="row2">
        <button id="daily-submit">Submit diagnosis</button>
        <button id="daily-giveup" class="danger" title="Give up — breaks your streak!">Give up</button>
      </div>`;
    panel.querySelector('#daily-submit').addEventListener('click', onSubmit);
    panel.querySelector('#daily-giveup').addEventListener('click', () => {
      recordResult(false, Math.round((Date.now() - startedAt) / 1000));
      renderDone(state[todayKey]);
    });
  }

  function onSubmit() {
    const sel = panel.querySelector('input[name="diag"]:checked');
    const verdict = panel.querySelector('#daily-verdict');
    if (!sel) { verdict.textContent = 'Pick an option first.'; return; }
    attempts++;
    if (decodeURIComponent(sel.value) === scenario.correct) {
      recordResult(true, Math.round((Date.now() - startedAt) / 1000));
      renderDone(state[todayKey]);
    } else {
      wrongGuesses.push(sel.value);
      sel.parentElement.style.opacity = '0.45';
      sel.disabled = true;
      verdict.textContent = `❌ Not it. (guess ${attempts})`;
      verdict.style.color = 'var(--red)';
    }
  }

  function renderDone(result) {
    const attempts = Math.max(1, Math.round(Number(result.attempts) || 1));
    const streak = Math.max(0, Math.round(Number(state.streak) || 0));
    panel.className = 'solved';
    panel.innerHTML = `
      <h3>${result.won ? `✅ #${puzzleNo} solved — ${attempts} guess${attempts > 1 ? 'es' : ''}, ${fmtDuration(result.seconds)}` : `📖 Daily Incident #${puzzleNo}`} <span class="meta">streak: ${streak}</span></h3>
      <div class="verdict">${scenario.correct}</div>
      <div class="explain">${scenario.explain}</div>
      <div class="share-box" id="daily-share-text">${shareText(result)}</div>
      <div class="row2">
        <button id="daily-share">📋 Copy result</button>
        <button id="daily-fix">🔧 Apply the fix</button>
      </div>
      <div class="clue">⏳ Next incident in ${countdown()} · <a href="/incident/" style="color:var(--blue)">practice more in the Incident Room</a></div>`;
    panel.querySelector('#daily-share').addEventListener('click', e => {
      navigator.clipboard.writeText(shareText(result)).then(() => { e.target.textContent = '✅ Copied!'; });
    });
    panel.querySelector('#daily-fix').addEventListener('click', async e => {
      await scenario.fix();
      e.target.disabled = true;
      e.target.textContent = '🩺 Fix applied';
    });
  }

  async function start() {
    await call('POST', '/api/reset');
    await scenario.inject();
    await call('POST', '/api/speed', { speed: 5 });
    await call('POST', '/api/advance', { seconds: 45 });
    const played = state[todayKey];
    if (played) renderDone(played);  // already played today — show result + countdown
    else renderQuiz();
  }

  start();
})();
