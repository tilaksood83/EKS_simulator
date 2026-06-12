'use strict';

/*
 * Retry-storm / resilience simulation. Time advances in 1-second ticks.
 *
 * A fixed call chain:   client -> web -> api -> db
 * Each hop has caller-side knobs (timeout, retries, backoff, circuit breaker).
 * Failures downstream trigger retries upstream, which AMPLIFY load downstream,
 * which causes more failures: the retry storm. Circuit breakers cut the loop.
 * Feedback uses the previous tick's state, so storms build and decay visibly.
 */

const RES_MAX_EVENTS = 300;
const RES_HISTORY = 180;

const BACKOFF_FACTOR = { none: 1.0, fixed: 0.7, exp: 0.45, 'exp+jitter': 0.3 };

class ResilienceSim {
  constructor() {
    this.reset();
  }

  reset() {
    this.simTime = 0;
    this.speed = 1;
    this.events = [];
    this.history = [];

    // services in call order; client load enters at web
    this.services = {
      web: { capacity: 1200, baseLatency: 20, injLatency: 0, injErrorPct: 0, load: 0, latency: 20, pFail: 0 },
      api: { capacity: 900,  baseLatency: 30, injLatency: 0, injErrorPct: 0, load: 0, latency: 30, pFail: 0 },
      db:  { capacity: 500,  baseLatency: 25, injLatency: 0, injErrorPct: 0, load: 0, latency: 25, pFail: 0 },
    };

    // caller-side policy for each downstream hop
    this.hops = {
      'web->api': this.defaultHop(),
      'api->db': this.defaultHop(),
    };

    this.clientRps = 300;
    this.event('Normal', 'SystemReady', 'client -> web -> api -> db chain is up');
  }

  defaultHop() {
    return {
      timeoutMs: 1000,
      retries: 2,
      backoff: 'none',
      breakerEnabled: false,
      breakerThreshold: 0.5, // open when failure rate exceeds this
      breakerCooldown: 15,   // seconds open before half-open probe
      breakerState: 'closed', // closed | open | half-open
      breakerRemaining: 0,
      measuredFail: 0,
    };
  }

  event(type, reason, message) {
    this.events.push({ time: this.simTime, type, reason, message });
    if (this.events.length > RES_MAX_EVENTS) this.events.splice(0, this.events.length - RES_MAX_EVENTS);
  }

  // ----------------------------------------------------------------- knobs

  setClientRps(v) { this.clientRps = Math.max(0, Math.min(2000, Number(v))); return this.clientRps; }

  setHop(name, patch) {
    const hop = this.hops[name];
    if (!hop) throw new Error(`unknown hop ${name}`);
    if (patch.timeoutMs !== undefined) hop.timeoutMs = Math.max(50, Math.min(5000, Number(patch.timeoutMs)));
    if (patch.retries !== undefined) hop.retries = Math.max(0, Math.min(5, Math.round(patch.retries)));
    if (patch.backoff !== undefined && BACKOFF_FACTOR[patch.backoff] !== undefined) hop.backoff = patch.backoff;
    if (patch.breakerEnabled !== undefined) {
      hop.breakerEnabled = !!patch.breakerEnabled;
      if (!hop.breakerEnabled) { hop.breakerState = 'closed'; hop.breakerRemaining = 0; }
      this.event('Normal', 'PolicyChange',
        `${name}: circuit breaker ${hop.breakerEnabled ? 'ENABLED' : 'disabled'}`);
    }
    return hop;
  }

  inject(svcName, patch) {
    const svc = this.services[svcName];
    if (!svc) throw new Error(`unknown service ${svcName}`);
    if (patch.injLatency !== undefined) svc.injLatency = Math.max(0, Math.min(3000, Number(patch.injLatency)));
    if (patch.injErrorPct !== undefined) svc.injErrorPct = Math.max(0, Math.min(100, Number(patch.injErrorPct)));
    return svc;
  }

  healAll() {
    for (const s of Object.values(this.services)) { s.injLatency = 0; s.injErrorPct = 0; }
    this.event('Normal', 'Healed', 'all injected faults removed');
  }

  setSpeed(v) {
    this.speed = [0, 1, 2, 5, 10].includes(Number(v)) ? Number(v) : 1;
    return this.speed;
  }

  advance(seconds) {
    const n = Math.max(1, Math.min(600, Math.round(seconds || 60)));
    for (let i = 0; i < n; i++) this.tick();
    return { advanced: n };
  }

  // ------------------------------------------------------------------ tick

  // expected attempts per request given failure prob p and r retries
  attempts(p, r) {
    if (p >= 0.999) return r + 1;
    return (1 - Math.pow(p, r + 1)) / (1 - p);
  }

  // failure probability of a service at given load (uses last tick's latency)
  serviceFail(svc, hopTimeout) {
    const util = svc.load / svc.capacity;
    // congestion drives latency up sharply past ~80% utilization
    const congestion = util <= 0.8 ? 1 : 1 + Math.pow((util - 0.8) * 5, 2);
    svc.latency = Math.round((svc.baseLatency + svc.injLatency) * congestion);
    const pTimeout = hopTimeout ? Math.max(0, Math.min(1, (svc.latency / hopTimeout) - 1)) : 0;
    const pErr = svc.injErrorPct / 100;
    return Math.max(0, Math.min(1, pErr + pTimeout * (1 - pErr)));
  }

  stepBreaker(name, hop, pFail) {
    if (!hop.breakerEnabled) return;
    hop.measuredFail = pFail;
    if (hop.breakerState === 'closed' && pFail > hop.breakerThreshold) {
      hop.breakerState = 'open';
      hop.breakerRemaining = hop.breakerCooldown;
      this.event('Warning', 'BreakerOpen',
        `${name}: failure rate ${(pFail * 100).toFixed(0)}% > ${(hop.breakerThreshold * 100).toFixed(0)}% — failing fast for ${hop.breakerCooldown}s`);
    } else if (hop.breakerState === 'open') {
      hop.breakerRemaining--;
      if (hop.breakerRemaining <= 0) {
        hop.breakerState = 'half-open';
        this.event('Normal', 'BreakerHalfOpen', `${name}: sending 10% probe traffic`);
      }
    } else if (hop.breakerState === 'half-open') {
      if (pFail < hop.breakerThreshold / 2) {
        hop.breakerState = 'closed';
        this.event('Normal', 'BreakerClosed', `${name}: downstream healthy again — closing breaker`);
      } else {
        hop.breakerState = 'open';
        hop.breakerRemaining = hop.breakerCooldown;
        this.event('Warning', 'BreakerReopen', `${name}: probe failed — reopening for ${hop.breakerCooldown}s`);
      }
    }
  }

  tick() {
    this.simTime++;
    const { web, api, db } = this.services;
    const hWA = this.hops['web->api'];
    const hAD = this.hops['api->db'];

    // ---- load propagation (top-down, using last tick's failure rates)
    web.load = this.clientRps;

    let apiDemand = web.load; // each web request makes one api call
    let apiPassFactor = 1;    // share of demand actually sent (breaker gating)
    if (hWA.breakerEnabled && hWA.breakerState === 'open') apiPassFactor = 0;
    else if (hWA.breakerEnabled && hWA.breakerState === 'half-open') apiPassFactor = 0.1;
    const ampWA = 1 + (this.attempts(api.pFail, hWA.retries) - 1) * BACKOFF_FACTOR[hWA.backoff];
    api.load = apiDemand * apiPassFactor * ampWA;

    let dbDemand = api.load;
    let dbPassFactor = 1;
    if (hAD.breakerEnabled && hAD.breakerState === 'open') dbPassFactor = 0;
    else if (hAD.breakerEnabled && hAD.breakerState === 'half-open') dbPassFactor = 0.1;
    const ampAD = 1 + (this.attempts(db.pFail, hAD.retries) - 1) * BACKOFF_FACTOR[hAD.backoff];
    db.load = dbDemand * dbPassFactor * ampAD;

    // ---- failure rates at the new load levels
    db.pFail = this.serviceFail(db, hAD.timeoutMs);
    api.pFail = this.serviceFail(api, hWA.timeoutMs);
    web.pFail = this.serviceFail(web, null);

    // ---- circuit breakers react to what they observed
    this.stepBreaker('api->db', hAD, db.pFail);
    this.stepBreaker('web->api', hWA, api.pFail);

    // ---- end-to-end success
    const hopSuccess = (p, r, hop) => {
      if (hop.breakerEnabled && hop.breakerState === 'open') return 0; // fail fast
      const probe = hop.breakerEnabled && hop.breakerState === 'half-open' ? 0.1 : 1;
      return probe * (1 - Math.pow(p, r + 1));
    };
    const sDb = hopSuccess(db.pFail, hAD.retries, hAD);
    const sApi = hopSuccess(api.pFail, hWA.retries, hWA) * sDb;
    const clientSuccess = (1 - web.pFail) * sApi;

    const e2eLatency = web.latency + api.latency + db.latency;

    if (db.load > db.capacity * 1.5 && this.simTime % 8 === 0) {
      this.event('Warning', 'RetryStorm',
        `db receiving ${Math.round(db.load)} req/s against capacity ${db.capacity} — retries are amplifying load ${ampAD.toFixed(1)}x`);
    }

    this.history.push({
      time: this.simTime,
      clientSuccess: Math.round(clientSuccess * 100),
      webLoad: Math.round(web.load),
      apiLoad: Math.round(api.load),
      dbLoad: Math.round(db.load),
      e2eLatency,
    });
    if (this.history.length > RES_HISTORY) this.history.splice(0, this.history.length - RES_HISTORY);
  }

  getState() {
    const svc = name => {
      const s = this.services[name];
      return {
        name,
        capacity: s.capacity,
        load: Math.round(s.load),
        util: Math.round((s.load / s.capacity) * 100),
        latency: s.latency,
        pFail: Math.round(s.pFail * 100),
        injLatency: s.injLatency,
        injErrorPct: s.injErrorPct,
      };
    };
    return {
      simTime: this.simTime,
      speed: this.speed,
      clientRps: this.clientRps,
      services: [svc('web'), svc('api'), svc('db')],
      hops: Object.fromEntries(Object.entries(this.hops).map(([k, h]) => [k, { ...h }])),
      events: this.events.slice(-200),
      history: this.history,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ResilienceSim };
} else if (typeof window !== 'undefined') {
  window.ResilienceSim = ResilienceSim;
}
