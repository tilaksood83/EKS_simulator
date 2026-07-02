'use strict';

/*
 * Guided lesson engine. A sim page includes this plus a lessons.js that
 * defines window.LESSONS (lesson id -> {title, steps}) and
 * window.LESSON_ADAPTER ({getState}). If the URL has ?lesson=<id>, an
 * interactive walkthrough panel appears and drives the simulation.
 *
 * Step shape: {
 *   say:   string (HTML) — what to explain,
 *   do:    optional async fn — setup executed when the step starts,
 *   until: optional fn(state) -> bool — Next unlocks when true (polled 1s),
 *   watch: optional string — what to look at while waiting,
 * }
 */
(() => {
  const id = new URLSearchParams(location.search).get('lesson');
  if (!id) return;
  const lesson = (window.LESSONS || {})[id];
  const adapter = window.LESSON_ADAPTER;
  if (!lesson || !adapter) return;

  const css = document.createElement('style');
  css.textContent = `
    #lesson-panel {
      position: fixed; left: 14px; bottom: 14px; width: 360px; z-index: 60;
      background: var(--panel); border: 1px solid var(--blue); border-radius: 10px;
      padding: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.5); font-size: .9rem;
    }
    #lesson-panel h3 { margin: 0 0 4px; color: var(--blue); font-size: 1rem; }
    #lesson-panel .progress { color: var(--dim); font-size: .78rem; margin-bottom: 8px; }
    #lesson-panel .step-text { line-height: 1.5; }
    #lesson-panel .watch { color: var(--amber); font-style: italic; margin-top: 8px; }
    #lesson-panel .watch.done { color: var(--green); font-style: normal; }
    #lesson-panel .row2 { display: flex; gap: 8px; margin-top: 12px; }
    #lesson-panel button { flex: 1; }
    #lesson-panel button:disabled { opacity: .45; cursor: not-allowed; }
    #lesson-panel .bar { height: 4px; background: var(--panel2); border-radius: 2px; margin: 8px 0; overflow: hidden; }
    #lesson-panel .bar i { display: block; height: 100%; background: var(--blue); transition: width .3s; }
    #lesson-panel code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('div');
  panel.id = 'lesson-panel';
  document.body.appendChild(panel);

  let idx = 0;
  let satisfied = false;
  let pollTimer = null;

  async function enterStep() {
    const step = lesson.steps[idx];
    satisfied = !step.until;
    render();
    if (step.do) {
      try { await step.do(); } catch (err) { console.error('lesson step setup failed:', err); }
    }
    clearInterval(pollTimer);
    if (step.until) {
      pollTimer = setInterval(async () => {
        try {
          const state = await adapter.getState();
          if (step.until(state)) {
            satisfied = true;
            clearInterval(pollTimer);
            render();
          }
        } catch { /* sim mid-reset; retry next poll */ }
      }, 1000);
    }
  }

  function render() {
    const step = lesson.steps[idx];
    const total = lesson.steps.length;
    const last = idx === total - 1;
    panel.innerHTML = `
      <h3>🎓 ${lesson.title}</h3>
      <div class="progress">step ${idx + 1} of ${total}</div>
      <div class="bar"><i style="width:${((idx + (satisfied ? 1 : 0.4)) / total) * 100}%"></i></div>
      <div class="step-text">${step.say}</div>
      ${step.watch ? `<div class="watch ${satisfied ? 'done' : ''}">${satisfied ? '✅ it happened — carry on!' : `👀 ${step.watch}`}</div>` : ''}
      <div class="row2">
        <button id="lesson-next" ${satisfied ? '' : 'disabled'}>${last ? '🎉 Finish' : 'Next →'}</button>
        <button id="lesson-exit" class="danger" title="Leave the lesson">Exit</button>
      </div>`;
    panel.querySelector('#lesson-next').addEventListener('click', () => {
      if (last) return finish();
      idx++;
      enterStep();
    });
    panel.querySelector('#lesson-exit').addEventListener('click', () => { location.href = '/learn/'; });
  }

  function finish() {
    clearInterval(pollTimer);
    panel.innerHTML = `
      <h3>🎉 Lesson complete</h3>
      <div class="step-text">${lesson.done || 'Nice work — you didn\'t just read it, you watched it happen.'}</div>
      <div class="row2">
        <button onclick="location.href='/learn/'">📚 More lessons</button>
        <button onclick="document.querySelector('#lesson-panel').remove()">🧪 Keep playing</button>
      </div>`;
  }

  enterStep();
})();
