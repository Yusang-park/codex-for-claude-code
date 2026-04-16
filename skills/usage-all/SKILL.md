---
name: usage-all
description: Show detailed token usage for Claude and Codex modes — 5h rolling window, rate limits, session stats
---

# Token Usage Report

Run this command and display the output as-is. Do NOT add commentary or explanation.

```bash
node -e '
const fs=require("fs"),path=require("path");
const projs=path.join(require("os").homedir(),".claude","projects");
const cacheDir=path.join(require("os").homedir(),".claude","hud","last-model");
const fiveH=Date.now()-5*3600*1000;
const sums={claude:{tokens:0,turns:0},codex:{tokens:0,turns:0}};
for(const d of fs.readdirSync(projs)){try{for(const f of fs.readdirSync(path.join(projs,d))){
  if(!f.endsWith(".jsonl"))continue;
  const fp=path.join(projs,d,f);
  if(fs.statSync(fp).mtimeMs<fiveH)continue;
  for(const l of fs.readFileSync(fp,"utf8").split("\n")){if(!l)continue;try{
    const j=JSON.parse(l);if(j.type!=="assistant")continue;
    const ts=new Date(j.timestamp).getTime();if(ts<fiveH)continue;
    const m=j.message?.model||"";const o=j.message?.usage?.output_tokens||0;
    const key=/^(gpt-|o\d)/i.test(m)?"codex":/^claude-/i.test(m)?"claude":null;
    if(key){sums[key].tokens+=o;sums[key].turns++;}
  }catch{}}}}catch{}}
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":String(n);
const caches={};
try{for(const f of fs.readdirSync(cacheDir)){
  const j=JSON.parse(fs.readFileSync(path.join(cacheDir,f),"utf8"));
  const fam=f.includes("-codex")?"codex":f.includes("-claude")?"claude":null;
  if(fam)caches[fam]=j;
}}catch{}
const pctC=caches.claude?.five_hour_total_tokens?Math.round(sums.claude.tokens/caches.claude.five_hour_total_tokens*100)+"%":"\u2014";
const pctX=caches.codex?.five_hour_total_tokens?Math.round(sums.codex.tokens/caches.codex.five_hour_total_tokens*100)+"%":"\u2014";
const resetFmt=ms=>{if(!ms||ms<=Date.now())return"\u2014";const d=ms-Date.now();const h=Math.floor(d/3600000);const m=Math.round((d%3600000)/60000);return h>0?h+"h"+m+"m":m+"m";};
const rC=resetFmt(caches.claude?.five_hour_resets_at_ms);
const rX=resetFmt(caches.codex?.five_hour_resets_at_ms);
let rl="(not running)";
try{const r=JSON.parse(fs.readFileSync(path.join(require("os").homedir(),".omc","state","codex-ratelimit.json"),"utf8"));rl=fmt(r.limit_tokens)+" TPM";}catch{}
console.log("## Token Usage (5h window)\n");
console.log("|               | Claude      | Codex       |");
console.log("|---------------|-------------|-------------|");
console.log("| Output tokens | "+fmt(sums.claude.tokens).padEnd(12)+"| "+fmt(sums.codex.tokens).padEnd(12)+"|");
console.log("| Turns         | "+String(sums.claude.turns).padEnd(12)+"| "+String(sums.codex.turns).padEnd(12)+"|");
console.log("| 5h %          | "+pctC.padEnd(12)+"| "+pctX.padEnd(12)+"|");
console.log("| Resets in     | "+rC.padEnd(12)+"| "+rX.padEnd(12)+"|");
console.log("| Model         | "+(caches.claude?.label||"\u2014").padEnd(12)+"| "+(caches.codex?.label||"\u2014").padEnd(12)+"|");
console.log("| Codex proxy   |             | "+rl.padEnd(12)+"|");
'
```
