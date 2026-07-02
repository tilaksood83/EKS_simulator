'use strict';

/*
 * Incident Room: injects a hidden fault into the (local, in-browser) EKS sim
 * and challenges the player to diagnose it from events, logs and metrics.
 * Runs on top of solo-mode machinery: the engine + fetch shim + normal UI.
 * Scenario definitions live in scenarios.js (shared with the Daily Incident).
 */
(() => {
  const { SCENARIOS, call } = window.INCIDENTS;

  let current = null;
  let attempts = 0;
  let streak = 0;

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
    #incident-streak { float: right; color: var(--dim); font-size: .8rem; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('div');
  panel.id = 'incident-panel';
  document.body.appendChild(panel);

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderQuiz() {
    const opts = shuffle([current.correct, ...current.wrong]);
    panel.className = '';
    panel.innerHTML = `
      <h3>🚨 Incident in progress <span id="incident-streak">streak: ${streak}</span></h3>
      <div>"${current.report}"</div>
      <div class="clue">💡 ${current.clue}</div>
      <div><b>${current.question}</b></div>
      ${opts.map(o => `<label><input type="radio" name="diag" value="${encodeURIComponent(o)}"> ${o}</label>`).join('')}
      <div class="verdict" id="incident-verdict"></div>
      <div class="row2">
        <button id="incident-submit">Submit diagnosis</button>
        <button id="incident-skip" class="danger" title="Give up and reveal the answer">Reveal</button>
      </div>`;
    panel.querySelector('#incident-submit').addEventListener('click', onSubmit);
    panel.querySelector('#incident-skip').addEventListener('click', () => { streak = 0; reveal(false); });
  }

  function onSubmit() {
    const sel = panel.querySelector('input[name="diag"]:checked');
    const verdict = panel.querySelector('#incident-verdict');
    if (!sel) { verdict.textContent = 'Pick an option first.'; return; }
    attempts++;
    if (decodeURIComponent(sel.value) === current.correct) {
      streak++;
      reveal(true);
    } else {
      verdict.textContent = `❌ Not quite — look again at the events and logs. (attempt ${attempts})`;
      verdict.style.color = 'var(--red)';
    }
  }

  function reveal(won) {
    panel.className = 'solved';
    panel.innerHTML = `
      <h3>${won ? `✅ Diagnosed in ${attempts} attempt${attempts > 1 ? 's' : ''}` : '📖 The answer'} <span id="incident-streak">streak: ${streak}</span></h3>
      <div class="verdict">${current.correct}</div>
      <div class="explain">${current.explain}</div>
      <div class="row2">
        <button id="incident-fix">🔧 Apply the fix</button>
        <button id="incident-next">🎲 New incident</button>
      </div>
      <div class="clue" id="incident-recovery"></div>`;
    panel.querySelector('#incident-fix').addEventListener('click', async e => {
      await current.fix();
      e.target.disabled = true;
      panel.querySelector('#incident-recovery').textContent =
        '🩺 Fix applied — watch the cluster recover in the charts and events.';
    });
    panel.querySelector('#incident-next').addEventListener('click', startIncident);
  }

  async function startIncident() {
    attempts = 0;
    await call('POST', '/api/reset');
    current = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    await current.inject();
    await call('POST', '/api/speed', { speed: 5 }); // make symptoms develop fast
    await call('POST', '/api/advance', { seconds: 45 }); // symptoms already visible
    renderQuiz();
  }

  startIncident();
})();
