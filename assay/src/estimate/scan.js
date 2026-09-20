import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.assay', 'venv', '.venv', '__pycache__', 'target', 'vendor', 'coverage', '.turbo', '.cache']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rb', '.rs', '.java', '.kt', '.php', '.cs', '.swift', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh', '.ipynb']);
const MAX_BYTES = 1_000_000;

const ENDPOINTS = [
  { kind: 'openrouter', re: /https?:\/\/openrouter\.ai\/api\/v1/g, note: 'Drop-in: change the base URL and key.' },
  { kind: 'openai', re: /https?:\/\/api\.openai\.com\/v1/g, note: 'Change the base URL and key; model ids need a vendor prefix (gpt-4o → openai/gpt-4o).' },
];
const ENV_NAMES = /\b(OPENROUTER_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL)\b/g;
const KNOWN_VENDORS = new Set(['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'x-ai', 'qwen', 'moonshotai', 'cohere', 'nvidia', 'microsoft', 'perplexity', 'amazon', 'z-ai', 'minimax']);
const PREFIXED_MODEL = /["'`]([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*)["'`]/gi;
const BARE_MODEL = /["'`]((?:gpt|chatgpt|claude|gemini|grok|deepseek|llama|mistral|qwen|kimi|o[134])[a-z0-9._:-]*)["'`]/gi;

/**
 * @typedef {object} ScanResult
 * @property {number} filesScanned
 * @property {Array<{file:string, line:number, kind:string, match:string, note:string}>} endpoints
 * @property {Array<{file:string, name:string}>} envVars   names only; values are never read into the result
 * @property {Map<string, {count:number, files:Set<string>}>} models  raw model strings → usage
 */

/**
 * Walk a repository and find where it talks to an LLM provider.
 *
 * Privacy: only matched tokens (an endpoint URL, a model id, an env var NAME) are recorded.
 * No line contents are stored, so secrets on the same line can never leak into output.
 *
 * @param {string} root
 * @param {{maxFiles?: number, knownVendors?: Set<string>}} [opts]
 * @returns {ScanResult}
 */
export function scanRepo(root, { maxFiles = 5000, knownVendors = new Set() } = {}) {
  /** @type {ScanResult} */
  const result = { filesScanned: 0, endpoints: [], envVars: [], models: new Map() };
  const vendors = new Set([...KNOWN_VENDORS, ...knownVendors]);
  const seenEnv = new Set();

  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.filesScanned >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && isCandidate(entry.name)) {
        scanFile(full);
      }
    }
  };

  /** @param {string} file */
  const scanFile = (file) => {
    let text;
    try {
      if (statSync(file).size > MAX_BYTES) return;
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\0')) return;
    result.filesScanned += 1;
    const rel = relative(root, file) || file;
    const isEnvFile = /(^|\/)\.env/.test(rel);

    text.split('\n').forEach((line, i) => {
      for (const ep of ENDPOINTS) {
        for (const m of line.matchAll(ep.re)) result.endpoints.push({ file: rel, line: i + 1, kind: ep.kind, match: m[0], note: ep.note });
      }
      for (const m of line.matchAll(ENV_NAMES)) {
        const key = `${rel}:${m[1]}`;
        if (!seenEnv.has(key)) {
          seenEnv.add(key);
          result.envVars.push({ file: rel, name: m[1] });
        }
      }
      if (isEnvFile) return; // env files: names only, never model strings or values
      for (const m of line.matchAll(PREFIXED_MODEL)) {
        if (vendors.has(m[1].split('/')[0].toLowerCase())) bump(result.models, m[1], rel);
      }
      for (const m of line.matchAll(BARE_MODEL)) bump(result.models, m[1], rel);
    });
  };

  walk(root);
  return result;
}

/** @param {string} name */
function isCandidate(name) {
  return name.startsWith('.env') || SOURCE_EXT.has(extname(name).toLowerCase());
}

/** @param {Map<string,{count:number,files:Set<string>}>} map @param {string} id @param {string} file */
function bump(map, id, file) {
  const entry = map.get(id) ?? { count: 0, files: new Set() };
  entry.count += 1;
  entry.files.add(file);
  map.set(id, entry);
}

const canon = (s) => s.toLowerCase().replace(/^[^/]+\//, '').replace(/:.+$/, '').replace(/[._]/g, '-').replace(/-(20\d{2}-?\d{2}-?\d{2})$/, '').replace(/-latest$/, '');

/**
 * Match a string found in code to a catalog entry.
 * Exact id first, then vendor-less name with `.`/`-` and date suffixes normalised.
 *
 * @template {{id:string}} M
 * @param {string} name @param {M[]} catalog
 * @returns {M|null}
 */
export function resolveModel(name, catalog) {
  const exact = catalog.find((m) => m.id.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const target = canon(name);
  const hasVendor = name.includes('/');
  const vendor = hasVendor ? name.split('/')[0].toLowerCase() : null;
  const candidates = catalog.filter((m) => canon(m.id) === target && (!vendor || m.id.toLowerCase().startsWith(`${vendor}/`)));
  // Several vendors can host the same slug; prefer the shortest id (the original vendor).
  return candidates.sort((a, b) => a.id.length - b.id.length)[0] ?? null;
}
