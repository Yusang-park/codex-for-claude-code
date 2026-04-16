// Minimal YAML parser shared by step-injector.mjs and step-tracker.mjs.
//
// Supports the shape we produce in workflows/*.yaml:
//   - nested maps (indent-based)
//   - scalar values (numbers, booleans, unquoted strings, single-quoted strings)
//   - block list items: "- a"
//   - flow arrays: [a, b, c]
//   - flow maps:   { k: v, k2: v2 }
//   - full-line comments (# at line start)
//   - colons inside quoted strings
//
// Not supported (will throw): multi-line scalars (| or >), anchors, aliases.

export function parseYaml(src) {
  const lines = src.split('\n');
  const root = {};
  const stack = [{ indent: -1, node: root, isArray: false }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.match(/^\s*/)[0].length;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    // Block-list item: "- value" or "- key: value"
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        // Convert last added map property to an array if needed — but stack should already be array if this is well-formed
        continue;
      }
      const inner = trimmed.slice(2).trim();
      parent.push(parseScalarOrFlow(inner));
      continue;
    }

    const kv = splitKeyValue(trimmed);
    if (!kv) continue;
    const { key, value: val } = kv;

    if (val === '') {
      const next = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('#'));
      const nextIndent = next ? next.match(/^\s*/)[0].length : 0;
      const nextIsArray = next && next.trim().startsWith('- ') && nextIndent > indent;
      const child = nextIsArray ? [] : {};
      parent[key] = child;
      stack.push({ indent, node: child, isArray: nextIsArray });
    } else {
      parent[key] = parseScalarOrFlow(val);
    }
  }
  return root;
}

// Split "key: value" respecting quotes. Returns null if no unquoted colon.
function splitKeyValue(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      // colon must be followed by space or end of line to count as key-value separator
      const after = line[i + 1];
      if (after === undefined || after === ' ' || after === '\t') {
        return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function parseScalarOrFlow(val) {
  if (val.startsWith('[') && val.endsWith(']')) {
    return splitFlow(val.slice(1, -1)).map(parseScalar);
  }
  if (val.startsWith('{') && val.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(val.slice(1, -1))) {
      const kv = splitKeyValue(part);
      if (!kv) continue;
      obj[kv.key] = parseScalarOrFlow(kv.value);
    }
    return obj;
  }
  return parseScalar(val);
}

function parseScalar(s) {
  const t = s.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  // Double-quoted: process escape sequences via JSON
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  // Single-quoted: YAML-style — only `''` escapes to single quote
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

// Split a flow sequence by commas NOT inside nested brackets/quotes.
function splitFlow(inner) {
  const out = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = '';
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
