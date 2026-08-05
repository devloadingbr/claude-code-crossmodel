// `classify` suite: closed-set triage, IN BATCH.
//
// This is the use case OpenAI cites for Luna (routing, classification, extraction),
// and the one we want to offload at volume. It tests in batch on purpose: that's how
// it would actually be used, and a batch exposes an error that a single item doesn't
// — the model losing alignment between input and output partway through the list.

const CATEGORIES = ['scheduling', 'billing', 'technical', 'complaint', 'other'];

export default [
  {
    id: 'triage-10',
    difficulty: 'medium',
    items: [
      ['I need to move my onboarding call to Thursday', 'scheduling'],
      ['The September invoice came in with the wrong amount', 'billing'],
      ['Exports have been failing with an error since last night', 'technical'],
      ['I waited 50 minutes and no one helped me, unacceptable', 'complaint'],
      ['Do you have a mobile app?', 'other'],
      ['Can we move my demo call up to next week?', 'scheduling'],
      ['I want to cancel my plan and get a refund', 'billing'],
      ['The dashboard keeps crashing after the latest update', 'technical'],
      ['I was treated very rudely by support today', 'complaint'],
      ['What are your business hours on holidays?', 'other'],
    ],
    buildPrompt(items) {
      const list = items.map(([txt], i) => `${i + 1}. ${txt}`).join('\n');
      return `Classify each message into ONE category from this closed list:
${CATEGORIES.join(', ')}

Answer with ONLY a JSON: {"result": ["category1", "category2", ...]}
The array must have EXACTLY ${items.length} items, in the SAME order as the messages.
No backticks, no explanation.

Messages:
${list}`;
    },
    verify(obj, items) {
      if (!obj || !Array.isArray(obj.result)) {
        return { score: 0, detail: 'no "result" array in the JSON' };
      }
      const r = obj.result;
      if (r.length !== items.length) {
        return { score: 0, detail: `returned ${r.length} items, expected ${items.length} (lost alignment)` };
      }
      let correct = 0; const errors = [];
      items.forEach(([txt, expected], i) => {
        const got = String(r[i] ?? '').toLowerCase().trim();
        if (got === expected) correct++;
        else errors.push(`#${i + 1} ${got || 'empty'}≠${expected}`);
      });
      return {
        score: correct / items.length,
        detail: errors.length ? errors.join(', ').slice(0, 130) : 'ok',
      };
    },
  },

  {
    id: 'triage-ambiguous',
    difficulty: 'hard',
    items: [
      ['I booked a demo for Tuesday but got charged the wrong amount', 'billing'],
      // ground truth fixed on 2026-08-05: the tie-break rule is about the ACTION
      // requested, not the underlying subject — "charged the wrong amount" is a
      // billing ask even though the message opens on a scheduling detail.
      ['The update you shipped broke my integration, I want my money back', 'billing'],
      ['I need to cancel my onboarding call, we shut the project down', 'scheduling'],
      ['Do you offer installment plans for the annual subscription?', 'billing'],
      ['The onboarding call was great, just wanted to compliment Ana from support', 'other'],
      ["It's been lagging ever since yesterday's support call", 'technical'],
    ],
    buildPrompt(items) {
      const list = items.map(([txt], i) => `${i + 1}. ${txt}`).join('\n');
      return `Classify each message into ONE category from this closed list:
${CATEGORIES.join(', ')}

Tie-break rule: choose the category of the ACTION the customer wants, not the
underlying subject. A compliment is not a complaint — it goes under "other".

Answer with ONLY a JSON: {"result": ["category1", ...]}
Exactly ${items.length} items, in the same order. No backticks, no explanation.

Messages:
${list}`;
    },
    verify(obj, items) {
      if (!obj || !Array.isArray(obj.result)) return { score: 0, detail: 'no "result" array' };
      const r = obj.result;
      if (r.length !== items.length) return { score: 0, detail: `returned ${r.length}, expected ${items.length}` };
      let correct = 0; const errors = [];
      items.forEach(([, expected], i) => {
        const got = String(r[i] ?? '').toLowerCase().trim();
        if (got === expected) correct++; else errors.push(`#${i + 1} ${got || 'empty'}≠${expected}`);
      });
      return { score: correct / items.length, detail: errors.length ? errors.join(', ').slice(0, 130) : 'ok' };
    },
  },
];
