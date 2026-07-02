'use strict';

/* Guided lesson for the resilience sim. Drives the global `sim` directly. */
(() => {
  const lastH = s => s.history[s.history.length - 1] || {};

  window.LESSON_ADAPTER = {
    getState: () => Promise.resolve(sim.getState()),
  };

  window.LESSONS = {
    'storm-101': {
      title: 'Anatomy of a retry storm',
      done: 'Slow dependency + naive retries = amplified load = worse slowness: the loop feeds itself. Backoff weakens the loop; a circuit breaker cuts it. Timeouts, retries, backoff and breakers are one system — tune them together.',
      steps: [
        {
          say: 'A three-service chain: <b>client → web → api → db</b>. The db can handle <b>500 req/s</b>. Everything is healthy and boring. Let\'s fix that.',
          do: () => { sim.reset(); sim.setSpeed(2); sim.setClientRps(600); },
          until: s => lastH(s).clientSuccess >= 99,
          watch: 'confirm the baseline: client success ~100%, db load ~600…',
        },
        {
          say: 'I\'ve armed the trap: the api→db hop now has <b>3 retries, no backoff, 600ms timeout</b>. Individually each choice sounds reasonable — "of course we retry!" Now I\'m making the db slow (+800ms), like a brownout during a backup job.',
          do: () => {
            sim.setHop('api->db', { retries: 3, backoff: 'none', timeoutMs: 600 });
            sim.inject('db', { injLatency: 800 });
          },
          until: s => lastH(s).dbLoad > 1800,
          watch: 'watch the db load chart EXPLODE past its 500 capacity…',
        },
        {
          say: 'Study what just happened: db slow → requests exceed the 600ms timeout → api retries each one up to 3 times → db now receives <b>~4× the load</b> → which makes it slower → which causes more timeouts. The failure feeds itself. <b>Nobody attacked you; your own retries did this.</b>',
          until: s => lastH(s).clientSuccess < 20,
          watch: 'client success collapsing toward 0%…',
        },
        {
          say: 'First aid: <b>exponential backoff with jitter</b> on the same hop. Retries still happen, but spread out instead of stampeding — watch the amplification drop.',
          do: () => { sim.setHop('api->db', { backoff: 'exp+jitter' }); },
          until: s => lastH(s).dbLoad < 1500,
          watch: 'db load easing as retries spread out…',
        },
        {
          say: 'Better — but the db is still slow and users still suffer. The decisive tool is the <b>circuit breaker</b>: when the failure rate is high, stop calling the db entirely and fail FAST. Enabling it now.',
          do: () => { sim.setHop('api->db', { breakerEnabled: true }); },
          until: s => s.hops['api->db'].breakerState === 'open',
          watch: 'watch the CB badge on the api→db arrow flip to OPEN…',
        },
        {
          say: 'Breaker open: users get instant errors instead of 3-second hangs, and the db\'s load dropped to ~zero — it finally has room to breathe. Now let\'s "fix the database" (ending the brownout) and watch the breaker discover it.',
          do: () => { sim.inject('db', { injLatency: 0 }); },
          until: s => s.hops['api->db'].breakerState === 'closed' && lastH(s).clientSuccess > 90,
          watch: 'open → half-open probe → closed… then success recovers…',
        },
        {
          say: 'Full recovery, no human in the loop: the breaker probed with 10% traffic (<b>half-open</b>), saw health, and closed. The system healed itself — because failing fast gave the db the quiet it needed to recover.',
        },
      ],
    },
  };
})();
