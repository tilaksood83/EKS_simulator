'use strict';

/* Guided lesson for the Kafka sim. Drives the global `sim` directly. */
(() => {
  const lastH = s => s.history[s.history.length - 1] || {};

  window.LESSON_ADAPTER = {
    getState: () => Promise.resolve(sim.getState()),
  };

  window.LESSONS = {
    'lag-101': {
      title: 'Consumer lag, skew & rebalancing',
      done: 'Lag is a race between produce and consume rates; partitions cap parallelism; rebalances pause everything; and a hot key can\'t be fixed by adding consumers. That\'s 80% of real-world Kafka firefighting.',
      steps: [
        {
          say: 'One topic, <b>6 partitions</b>, spread across 3 brokers. A consumer group with <b>2 consumers</b>, each processing <b>120 msg/s</b> — so total drain capacity is <b>240 msg/s</b>. Keep that number in mind.',
          do: () => { sim.reset(); sim.setSpeed(2); },
        },
        {
          say: 'I\'m turning the producer up to <b>400 msg/s</b> — more than the 240 the group can drain. The difference (160/s) has to pile up somewhere. It piles up as <b>lag</b>.',
          do: () => { sim.setProducer({ rps: 400 }); },
          until: s => lastH(s).totalLag > 1500,
          watch: 'watch the Total lag stat climb — that\'s unprocessed messages accumulating…',
        },
        {
          say: 'Lag isn\'t an error — nothing is "down". It\'s <b>debt</b>: every message will still be processed, just later and later. Now let\'s add a third consumer (+120 capacity)… but watch what happens FIRST.',
          do: () => { sim.addConsumer(); },
          until: s => s.consumerGroup.rebalanceRemaining === 0 && s.consumerGroup.generation >= 2,
          watch: 'the group is REBALANCING — notice consumption stops completely…',
        },
        {
          say: 'That pause was the <b>rebalance</b>: when membership changes, the group stops, reassigns partitions, then resumes. Lag JUMPED during it. This is why a flapping consumer (crash-looping pod!) can be worse than a missing one.',
        },
        {
          say: 'Three consumers = 360 msg/s vs 400 produced. Still losing. One more consumer takes us to 480 — finally faster than the producer.',
          do: () => { sim.addConsumer(); },
          until: s => lastH(s).consumeRate > lastH(s).produceRate && lastH(s).totalLag < 3000,
          watch: 'consume rate now beats produce rate — lag is draining…',
        },
        {
          say: 'Now the classic trap. I\'m making <b>70% of messages use one hot key</b>. Same total volume — but keys decide partitions, and one partition is about to eat most of the traffic.',
          do: () => { sim.setProducer({ keySkew: 0.7 }); },
          until: s => s.partitions[0].lag > 2000,
          watch: 'watch partition P0 🔥 drown while its neighbors sit at zero…',
        },
        {
          say: 'Here\'s the kicker: <b>adding consumers cannot fix this.</b> A partition belongs to at most ONE consumer — P0\'s lag is one consumer\'s problem no matter how many teammates it has. The fix is in the <i>data</i>: better key choice, or salting the hot key. Try adding consumers now and watch it not help.',
        },
      ],
    },
  };
})();
