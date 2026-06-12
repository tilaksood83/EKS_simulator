'use strict';

/*
 * Kafka topic simulation. Time advances in 1-second ticks.
 * Models: partitions with leaders on brokers, a producer with adjustable key
 * skew, one consumer group with rebalancing pauses, broker failure with
 * leader election, and the resulting consumer lag.
 */

const KAFKA_MAX_EVENTS = 300;
const KAFKA_HISTORY = 180;
const REBALANCE_SECONDS = 6;
const ELECTION_SECONDS = 5;

class KafkaSim {
  constructor() {
    this.reset();
  }

  reset(opts = {}) {
    this.simTime = 0;
    this.speed = 1;
    this.events = [];
    this.history = [];
    this.totalProduced = 0;
    this.totalConsumed = 0;
    this.totalErrors = 0;

    this.brokerCount = opts.brokers || 3;
    this.brokers = [];
    for (let i = 0; i < this.brokerCount; i++) {
      this.brokers.push({ id: i, alive: true });
    }

    this.topic = 'orders';
    this.producer = {
      rps: opts.produceRps || 200,
      // 0 = perfectly uniform keys; 1 = every message hits partition 0
      keySkew: opts.keySkew ?? 0,
    };
    this.consumerGroup = {
      name: 'cg-checkout',
      perConsumerCapacity: opts.perConsumerCapacity || 120, // msgs/s each
      consumers: [],
      rebalanceRemaining: 0,
      generation: 0,
    };

    this.partitions = [];
    this.setPartitionCount(opts.partitions || 6, true);
    this.addConsumer(true);
    this.addConsumer(true);

    this.event('Normal', 'TopicReady',
      `topic/${this.topic}: ${this.partitions.length} partitions across ${this.brokerCount} brokers`);
  }

  event(type, reason, message) {
    this.events.push({ time: this.simTime, type, reason, message });
    if (this.events.length > KAFKA_MAX_EVENTS) this.events.splice(0, this.events.length - KAFKA_MAX_EVENTS);
  }

  // ------------------------------------------------------------ topology ops

  aliveBrokers() {
    return this.brokers.filter(b => b.alive);
  }

  setPartitionCount(n, silent = false) {
    n = Math.max(1, Math.min(12, Math.round(n)));
    if (n < this.partitions.length) {
      throw new Error('Kafka cannot reduce partition count — only increase it');
    }
    while (this.partitions.length < n) {
      const id = this.partitions.length;
      this.partitions.push({
        id,
        leader: id % this.brokerCount,
        lag: 0,
        electionRemaining: 0,
        consumer: null,
        produced: 0,
        consumed: 0,
      });
    }
    if (!silent) {
      this.event('Normal', 'PartitionsAdded', `topic/${this.topic} now has ${n} partitions`);
      this.startRebalance('partition count changed');
    }
    return n;
  }

  addConsumer(silent = false) {
    const id = `consumer-${this.consumerGroup.consumers.length + 1}`;
    this.consumerGroup.consumers.push({ id });
    if (!silent) {
      this.event('Normal', 'ConsumerJoined', `${id} joined group ${this.consumerGroup.name}`);
      this.startRebalance(`${id} joined`);
    }
    this.assignPartitions();
  }

  removeConsumer() {
    const gone = this.consumerGroup.consumers.pop();
    if (!gone) return;
    this.event('Warning', 'ConsumerLeft', `${gone.id} left group ${this.consumerGroup.name}`);
    this.startRebalance(`${gone.id} left`);
    this.assignPartitions();
  }

  startRebalance(why) {
    this.consumerGroup.rebalanceRemaining = REBALANCE_SECONDS;
    this.consumerGroup.generation++;
    this.event('Warning', 'Rebalancing',
      `group ${this.consumerGroup.name} rebalancing (${why}) — consumption paused ~${REBALANCE_SECONDS}s`);
  }

  assignPartitions() {
    const cs = this.consumerGroup.consumers;
    for (const p of this.partitions) {
      p.consumer = cs.length ? cs[p.id % cs.length].id : null;
    }
  }

  killBroker(id) {
    const b = this.brokers[id];
    if (!b || !b.alive) throw new Error(`broker ${id} is not alive`);
    if (this.aliveBrokers().length === 1) throw new Error('cannot kill the last broker');
    b.alive = false;
    this.event('Warning', 'BrokerDown', `broker-${id} crashed`);
    for (const p of this.partitions) {
      if (p.leader === id) {
        p.electionRemaining = ELECTION_SECONDS;
        this.event('Warning', 'LeaderLost',
          `partition ${p.id} lost its leader (broker-${id}); electing a new one`);
      }
    }
    return { killed: id };
  }

  restartBroker(id) {
    const b = this.brokers[id];
    if (!b || b.alive) throw new Error(`broker ${id} is not down`);
    b.alive = true;
    this.event('Normal', 'BrokerUp', `broker-${id} rejoined the cluster`);
    return { restarted: id };
  }

  setProducer({ rps, keySkew }) {
    if (rps !== undefined) this.producer.rps = Math.max(0, Math.min(3000, Number(rps)));
    if (keySkew !== undefined) this.producer.keySkew = Math.max(0, Math.min(1, Number(keySkew)));
    return this.producer;
  }

  setConsumerCapacity(v) {
    this.consumerGroup.perConsumerCapacity = Math.max(10, Math.min(1000, Number(v)));
    return this.consumerGroup.perConsumerCapacity;
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

  // ----------------------------------------------------------------- tick

  tick() {
    this.simTime++;
    const cg = this.consumerGroup;

    // leader elections complete
    for (const p of this.partitions) {
      if (p.electionRemaining > 0) {
        p.electionRemaining--;
        if (p.electionRemaining === 0) {
          const alive = this.aliveBrokers();
          p.leader = alive[p.id % alive.length].id;
          this.event('Normal', 'LeaderElected',
            `partition ${p.id}: broker-${p.leader} is the new leader`);
        }
      }
    }

    // ---- produce: split rps across partitions with key skew
    const P = this.partitions.length;
    const hot = this.producer.rps * this.producer.keySkew;
    const uniform = (this.producer.rps - hot) / P;
    let producedNow = 0, errorsNow = 0;
    for (const p of this.partitions) {
      const want = uniform + (p.id === 0 ? hot : 0);
      if (!this.brokers[p.leader].alive || p.electionRemaining > 0) {
        errorsNow += want; // NotLeaderForPartition until election completes
      } else {
        p.lag += want;
        p.produced += want;
        producedNow += want;
      }
    }
    if (errorsNow > 0 && this.simTime % 5 === 0) {
      this.event('Warning', 'ProduceErrors',
        `~${Math.round(errorsNow)} msg/s failing (partition leader unavailable)`);
    }

    // ---- consume: paused entirely during a rebalance
    let consumedNow = 0;
    if (cg.rebalanceRemaining > 0) {
      cg.rebalanceRemaining--;
      if (cg.rebalanceRemaining === 0) {
        this.assignPartitions();
        this.event('Normal', 'RebalanceComplete',
          `group ${cg.name} generation ${cg.generation}: partitions reassigned`);
      }
    } else if (cg.consumers.length > 0) {
      for (const c of cg.consumers) {
        const mine = this.partitions.filter(p => p.consumer === c.id && this.brokers[p.leader].alive && p.electionRemaining === 0);
        let budget = cg.perConsumerCapacity;
        // drain highest-lag partitions first, one consumer thread per partition
        mine.sort((a, b) => b.lag - a.lag);
        for (const p of mine) {
          if (budget <= 0) break;
          const take = Math.min(budget, p.lag);
          p.lag -= take;
          p.consumed += take;
          budget -= take;
          consumedNow += take;
        }
      }
    }

    this.totalProduced += producedNow;
    this.totalConsumed += consumedNow;
    this.totalErrors += errorsNow;

    const totalLag = this.partitions.reduce((s, p) => s + p.lag, 0);
    if (totalLag > 5000 && this.simTime % 10 === 0) {
      this.event('Warning', 'LagAlert',
        `total consumer lag is ${Math.round(totalLag)} messages and growing — consumers cannot keep up`);
    }

    this.history.push({
      time: this.simTime,
      produceRate: Math.round(producedNow),
      consumeRate: Math.round(consumedNow),
      errors: Math.round(errorsNow),
      totalLag: Math.round(totalLag),
    });
    if (this.history.length > KAFKA_HISTORY) this.history.splice(0, this.history.length - KAFKA_HISTORY);
  }

  // ----------------------------------------------------------------- state

  getState() {
    return {
      simTime: this.simTime,
      speed: this.speed,
      topic: this.topic,
      brokers: this.brokers.map(b => ({ ...b })),
      producer: { ...this.producer },
      consumerGroup: {
        name: this.consumerGroup.name,
        perConsumerCapacity: this.consumerGroup.perConsumerCapacity,
        rebalanceRemaining: this.consumerGroup.rebalanceRemaining,
        generation: this.consumerGroup.generation,
        consumers: this.consumerGroup.consumers.map(c => ({ ...c })),
      },
      partitions: this.partitions.map(p => ({
        id: p.id,
        leader: p.leader,
        lag: Math.round(p.lag),
        electing: p.electionRemaining > 0,
        consumer: p.consumer,
      })),
      totals: {
        produced: Math.round(this.totalProduced),
        consumed: Math.round(this.totalConsumed),
        errors: Math.round(this.totalErrors),
      },
      events: this.events.slice(-200),
      history: this.history,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KafkaSim };
} else if (typeof window !== 'undefined') {
  window.KafkaSim = KafkaSim;
}
