import { JUDGE_MARKER } from '../bench/judge.js';

/**
 * Simulated skill of each mock model on the sample support-ticket dataset (share of triage
 * prompts answered correctly). A big model, a good cheap model, and a cheap model that falls apart.
 */
export const DEMO_SKILL = {
  'openai/gpt-6-astra': 0.99,
  'anthropic/claude-opus-5': 0.99,
  'anthropic/claude-haiku-4.5': 0.97,
  'google/gemini-3.8-flash': 0.93,
  'x-ai/grok-4.6': 0.9,
  'openai/gpt-6-mini': 0.8,
  'deepseek/deepseek-v4-flash': 0.6,
};

const CATEGORIES = ['billing', 'bug', 'feature_request', 'account_access', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** Stable pseudo-random number in [0,1) from a string. */
export function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/**
 * Build a `respond` hook for the mock gateway. It answers triage prompts correctly with
 * probability equal to the model's skill (deterministically per model and prompt), writes
 * replies whose quality tracks skill, and acts as a slightly position-biased judge.
 *
 * @param {import('../bench/dataset.js').BenchItem[]} items
 * @param {Record<string, number>} [skill]
 */
export function createBenchResponder(items, skill = DEMO_SKILL) {
  const byPrompt = new Map(items.map((it) => [lastUser(it.messages), it]));

  return ({ model, messages }) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';

    // Judge: prefer the longer answer, call it a tie when they are close, lean toward "A" on ties.
    if (system.includes(JUDGE_MARKER)) {
      const text = lastUser(messages);
      const a = /Answer A:\n([\s\S]*?)\n\nAnswer B:/.exec(text)?.[1] ?? '';
      const b = /Answer B:\n([\s\S]*?)\n\nWhich answer/.exec(text)?.[1] ?? '';
      const ratio = a.length / Math.max(1, b.length);
      const winner = ratio > 1.3 ? 'A' : ratio < 0.77 ? 'B' : hash01(text) < 0.25 ? 'A' : 'tie';
      return JSON.stringify({ winner });
    }

    const item = byPrompt.get(lastUser(messages));
    if (!item) return null; // preflight and anything else: plain "ok"
    const p = skill[model] ?? 0.7;
    const roll = hash01(`${model}|${item.id}`);

    if (item.judge && !item.expect?.fields) {
      const reply = 'Thanks for reaching out, and I am sorry about the trouble.';
      const detail = ' I have escalated this to the right team and you will hear back from us with an update as soon as we have one.';
      const close = ' Please reply here if anything changes on your side.';
      return p >= 0.9 ? reply + detail + close : p >= 0.75 ? reply + detail : 'Ok, we will look into it.';
    }

    const gold = item.expect?.fields;
    if (!gold) return 'ok';
    if (roll < p) {
      const json = JSON.stringify(gold);
      return roll > p * 0.9 ? `Here is the triage result:\n\`\`\`json\n${json}\n\`\`\`` : json; // some models add prose; extraction tolerates it
    }
    // A plausible wrong answer: change the priority for most misses, the category for the rest.
    const wrong = { ...gold };
    if (hash01(`${item.id}|${model}|kind`) < 0.65) wrong.priority = PRIORITIES[(PRIORITIES.indexOf(gold.priority) + 1) % PRIORITIES.length];
    else wrong.category = CATEGORIES[(CATEGORIES.indexOf(gold.category) + 2) % CATEGORIES.length];
    return JSON.stringify(wrong);
  };
}
