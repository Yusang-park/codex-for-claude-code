#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, cpSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDirArg = process.argv[2];

if (!outDirArg) {
  console.error('Usage: node scripts/create-codex-split.mjs <output-dir>');
  process.exit(1);
}

const outDir = resolve(process.cwd(), outDirArg);
mkdirSync(outDir, { recursive: true });

const copiedDirs = [
  'dist',
  'skills',
  'agents',
  'workflows',
  'commands',
  'steps',
  'presets',
  'scripts',
  'hooks',
  'rules-lib',
];

for (const rel of copiedDirs) {
  const source = join(repoRoot, rel);
  const target = join(outDir, rel);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(target, { recursive: true, force: true });
    } else {
      rmSync(target, { force: true });
    }
  }
  cpSync(source, target, { recursive: true });
}

const packageJson = {
  name: 'codex-for-claude-code',
  version: '0.1.0',
  description: 'Use Codex models inside Claude Code with a user-focused workflow layer.',
  type: 'module',
  main: 'dist/src/index.js',
  types: 'dist/src/index.d.ts',
  bin: {
    codex: 'dist/bin/cli.js',
  },
  engines: {
    node: '>=20.0.0',
  },
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'https://github.com/yusang-park/codex-for-claude-code.git',
  },
  homepage: 'https://github.com/yusang-park/codex-for-claude-code#readme',
  bugs: {
    url: 'https://github.com/yusang-park/codex-for-claude-code/issues',
  },
  keywords: ['claude-code', 'codex', 'workflow', 'agents', 'tdd'],
  author: 'Yusang Park',
  scripts: {
    test: 'node scripts/test-codex-split.mjs',
  },
};

const pluginJson = {
  name: 'codex-for-claude-code',
  version: '1.0.0',
  description: 'Open-source Codex-style workflows for Claude Code',
  hooks: 'hooks/hooks.json',
  author: 'Yusang Park',
  homepage: 'https://github.com/yusang-park/codex-for-claude-code',
  repository: 'https://github.com/yusang-park/codex-for-claude-code',
  license: 'MIT',
  tags: ['claude-code', 'codex', 'workflow'],
};

const readme = `# Codex for Claude Code

Use Codex models inside Claude Code with a user-focused workflow layer.

## Why

Claude Code is excellent for day-to-day work, but long sessions can hit usage limits or need a different execution style. Codex for Claude Code gives you a focused split repo you can package, version, and publish separately while still reusing the proven Smelter runtime underneath.

## What you get

- A standalone repo shell for Codex-oriented distribution
- User-facing package and plugin metadata
- Claude Code compatible hooks and workflow assets
- A separate Git repository you can commit and publish independently

## Install

\`\`\`bash
git clone https://github.com/yusang-park/codex-for-claude-code.git
cd codex-for-claude-code
\`\`\`

## Quick start

\`\`\`bash
codex run --preset feat \"add dark mode\"
codex run --preset qa \"fix login error text\"
codex run --preset tasker \"plan onboarding flow\"
\`\`\`

## How it works

This repo is a thin standalone package around the workflow runtime, prompts, hooks, and assets needed to run Codex-style workflows in Claude Code. The split keeps distribution metadata and documentation user-focused while the linked runtime directories stay in sync with the source project.

## Requirements

- Node.js 20+
- Claude Code
- Git

## License

MIT
`;

const gitignore = `node_modules/
dist/
.smt/
.DS_Store
.env
.env.*
*.log
`;

const mitLicense = `MIT License

Copyright (c) 2026 Yusang Park

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(join(outDir, 'plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`);
writeFileSync(join(outDir, 'README.md'), readme);
writeFileSync(join(outDir, '.gitignore'), gitignore);
writeFileSync(join(outDir, 'LICENSE'), mitLicense);

if (!existsSync(join(outDir, '.git'))) {
  execFileSync('git', ['init'], { cwd: outDir, stdio: 'pipe' });
}

console.log(outDir);
