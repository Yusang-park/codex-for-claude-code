#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TIMEOUT_MS = 20000;
const CACHE_FILE = 'keyword-cache.json';

function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function resolveClaudeBinary() {
  const versionsDir = join(homedir(), '.local', 'share', 'claude', 'versions');
  const versions = readdirSync(versionsDir).sort(semverCompare).reverse();
  for (const v of versions) {
    const p = join(versionsDir, v);
    try {
      const s = statSync(p);
      if (s.size > 0 && (s.mode & 0o111)) return p;
    } catch {}
  }
  throw new Error(`No valid Claude versions found in ${versionsDir}`);
}

const CLAUDE_BINARY = resolveClaudeBinary();

function extractInnerJson(text) {
  // Strip markdown code fences if present
  const stripped = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Try direct parse first
  try { return JSON.parse(stripped); } catch {}
  // Try each line (last valid JSON wins)
  const lines = stripped.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('no json object in text: ' + stripped.slice(0, 120));
}

function normalizeClaudeJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('empty output');
  // Claude CLI --output-format json wraps output in an envelope: { result: "...", ... }
  // Try parsing the outer envelope first, then extract the inner result field
  let outer;
  try { outer = JSON.parse(trimmed); } catch {}
  if (outer && typeof outer.result === 'string') {
    return extractInnerJson(outer.result);
  }
  // Fallback: try direct parse of the whole string
  return extractInnerJson(trimmed);
}

function invokeClaude(prompt) {
  return execFileSync(CLAUDE_BINARY, ['-p', '--model', 'haiku', '--output-format', 'json', prompt], {
    timeout: TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
}

const CLASSIFICATION_PROMPT = `You are a command classifier for a CLI tool called "smelter". Classify the user's prompt as either a command or a question/explanation request.

Commands available: tasker (planning), feat (full dev workflow), qa (bug fix / simple edit), cancel, queue.

Rules:
- If the user is ASKING about a command (e.g. "how does tasker work?", "explain plan") → question
- If the user WANTS TO EXECUTE something → command
- If the user describes a problem to SOLVE, FIX, BUILD, or IMPLEMENT → command (not question)
- If ambiguous but the prompt describes broken behavior, errors, or work to do → default to command

Strong qa signals (any of these → command:qa):
  EN: fix, bug, error, crash, broken, failing, deploy fail, build fail, ELIFECYCLE, exit code, resolve, patch, hotfix, regression, not working
  KO: 버그, 고쳐, 터지, 에러, 수정, 해결해, 안됨, 안돼, 깨짐, 실패, 오류, 장애, 배포실패
  ZH: 修复, 错误, 崩溃, 失败, 坏了, 报错, 部署失败, 不工作
  JA: バグ, 修正, エラー, クラッシュ, 壊れた, 失敗, 動かない, デプロイ失敗
  ES: arreglar, error, fallo, roto, despliegue fallido, no funciona, corregir
  DE: Fehler, kaputt, reparieren, Absturz, fehlgeschlagen, funktioniert nicht, beheben

Strong feat signals (any of these → command:feat):
  EN: add, create, build, implement, new feature, develop, integrate, migrate, refactor
  KO: 추가, 만들어, 새 기능, 구현, 개발, 리팩토링, 마이그레이션
  ZH: 添加, 创建, 新功能, 实现, 开发, 重构
  JA: 追加, 作成, 新機能, 実装, 開発, リファクタ
  ES: agregar, crear, nueva funcionalidad, implementar, desarrollar
  DE: hinzufügen, erstellen, neue Funktion, implementieren, entwickeln

Strong tasker signals (any of these → command:tasker):
  EN: plan, design, scope, architect, spec, requirements, breakdown, estimate
  KO: 설계, 계획, 기획, 스펙, 요구사항, 분석
  ZH: 计划, 设计, 需求, 规划, 架构
  JA: 計画, 設計, 要件, スコープ, 見積もり
  ES: planificar, diseñar, requisitos, alcance, arquitectura
  DE: planen, entwerfen, Anforderungen, Umfang, Architektur

Branch hints for commands:
- feat + "extend/add to/덧붙여/확장" → branch: "extend"
- feat + "new feature/새 기능" → branch: "new-feature"
- qa + "fix/bug/버그/고쳐/터지/에러" → branch: "bug"
- qa + "style/typo/i18n/텍스트/색상" → branch: "style"

Return ONLY valid JSON (no markdown, no explanation):
{"intent":"command"|"question","command":"<name>","branch":"<hint-or-empty>","reason":"<short>"}`;

function promptHash(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function readCache(stateDir, sessionId) {
  const path = join(stateDir, CACHE_FILE);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data._session !== sessionId) return {};
    return data;
  } catch { return {}; }
}

function writeCache(stateDir, sessionId, cache) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, CACHE_FILE), JSON.stringify({ ...cache, _session: sessionId }));
}

let claudeAvailable = null;
function isClaudeAvailable() {
  if (claudeAvailable !== null) return claudeAvailable;
  try {
    execFileSync(CLAUDE_BINARY, ['--version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 });
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
  }
  return claudeAvailable;
}

export function classifyPrompt(prompt, { cwd = process.cwd(), sessionId = '' } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const hash = promptHash(prompt);
  const cache = readCache(stateDir, sessionId);

  if (cache[hash]) return cache[hash];
  if (!isClaudeAvailable()) {
    throw new Error('Claude binary is unavailable for prompt classification');
  }

  const fullPrompt = `${CLASSIFICATION_PROMPT}\n\nUser prompt: "${prompt}"`;
  const parsed = normalizeClaudeJson(invokeClaude(fullPrompt));
  if (parsed.intent !== 'command' && parsed.intent !== 'question') {
    throw new Error(`Invalid classifier response: ${JSON.stringify(parsed)}`);
  }

  const result = {
    intent: parsed.intent,
    command: parsed.command || '',
    branch: parsed.branch || '',
    reason: parsed.reason || '',
  };

  cache[hash] = result;
  try { writeCache(stateDir, sessionId, cache); } catch {}
  return result;
}
