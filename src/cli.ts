#!/usr/bin/env bun

import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");
const STATE_FILE = join(homedir(), ".local/share/opencode/multi-account-state.json");

const DEFAULTS = { threshold: 0.70, recover: 0.60, checkInterval: 3600000 };

// ============================================================================
// File helpers
// ============================================================================

function loadAccounts() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")).anthropic?.multiAccounts?.accounts || [];
  } catch { return []; }
}

function loadAuth() {
  if (!existsSync(AUTH_FILE)) return { anthropic: { multiAccounts: { accounts: [] } } };
  try { return JSON.parse(readFileSync(AUTH_FILE, "utf-8")); }
  catch { return { anthropic: { multiAccounts: { accounts: [] } } }; }
}

function saveAuth(data: any) {
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return {}; }
}

function saveState(state: any) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// Usage command
// ============================================================================

function progressBar(utilization: number): string {
  const pct = Math.round(utilization * 100);
  const filled = Math.floor(pct / 2);
  const half = (pct % 2 === 1) ? '▌' : '';
  return '█'.repeat(filled) + half + ' '.repeat(Math.max(0, 50 - filled - (half ? 1 : 0)));
}

function formatResetTime(ts: number | null): string {
  if (!ts) return "Unknown";
  return new Intl.DateTimeFormat('default', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(ts * 1000));
}

function colorize(text: string, util: number): string {
  if (util >= 0.7) return `\x1b[31m${text}\x1b[0m`;
  if (util >= 0.5) return `\x1b[33m${text}\x1b[0m`;
  return `\x1b[32m${text}\x1b[0m`;
}

function renderUsage(watch: boolean) {
  const accounts = loadAccounts();
  const state = loadState();
  const config = state.config || {};
  
  if (watch) process.stdout.write('\x1b[2J\x1b[H');
  
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              anthropic-multi-account                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  
  if (!accounts.length) {
    console.log("\n  No accounts configured. Run: bun src/cli.ts add <name>\n");
    return;
  }

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const c = isActive ? '\x1b[1;36m' : '';
    const r = isActive ? '\x1b[0m' : '';
    
    console.log(isActive ? `\n${c}┌─ ${account.name} ◄── ACTIVE${r}` : `\n┌─ ${account.name}`);
    
    const usage = state.usage?.[account.name];
    if (!usage) {
      console.log(`${c}│${r}  No usage data yet`);
      console.log(`${c}└─${r}`);
      continue;
    }
    
    for (const [label, key] of [['Session (5h)', 'session5h'], ['Weekly (all)', 'weekly7d'], ['Weekly (Sonnet)', 'weekly7dSonnet']] as const) {
      const u = usage[key]?.utilization || 0;
      console.log(`${c}│${r}`);
      console.log(`${c}│${r}  ${label}`);
      console.log(`${c}│${r}  ${colorize(progressBar(u), u)}  ${colorize(`${Math.round(u * 100)}%`, u)}`);
      console.log(`${c}│${r}  Resets ${formatResetTime(usage[key]?.reset)}`);
    }
    console.log(`${c}└─${r}`);
  }
  
  const threshold = config.threshold ?? DEFAULTS.threshold;
  const recover = config.recover ?? DEFAULTS.recover;
  console.log(`\n  Requests: ${state.requestCount || 0}  │  Threshold: ${Math.round(threshold * 100)}%  │  Recover: ${Math.round(recover * 100)}%`);
  
  if (watch) {
    console.log(`  Updated: ${new Date().toLocaleTimeString()}  │  Ctrl+C to exit`);
  }
}

function cmdUsage(args: string[]) {
  const watch = args.includes('--watch') || args.includes('-w');
  renderUsage(watch);
  if (watch) setInterval(() => renderUsage(true), 5000);
}

// ============================================================================
// Config command
// ============================================================================

function cmdConfig(args: string[]) {
  const state = loadState();
  
  if (args.includes('--show') || args.length === 0) {
    const cfg = state.config || {};
    console.log('\n  Current config:');
    console.log(`    Threshold:      ${Math.round((cfg.threshold ?? DEFAULTS.threshold) * 100)}%`);
    console.log(`    Recover:        ${Math.round((cfg.recover ?? DEFAULTS.recover) * 100)}%`);
    console.log(`    Check interval: ${(cfg.checkInterval ?? DEFAULTS.checkInterval) / 60000} min\n`);
    return;
  }
  
  if (args.includes('--reset')) {
    delete state.config;
    saveState(state);
    console.log('✓ Reset to defaults');
    return;
  }
  
  state.config = state.config || {};
  let changed = false;
  
  const parseArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };
  
  const t = parseArg('--threshold');
  if (t) { state.config.threshold = parseFloat(t); changed = true; }
  
  const r = parseArg('--recover');
  if (r) { state.config.recover = parseFloat(r); changed = true; }
  
  const i = parseArg('--interval');
  if (i) { state.config.checkInterval = parseInt(i) * 60000; changed = true; }
  
  if (changed) {
    saveState(state);
    console.log('✓ Config saved');
    cmdConfig(['--show']);
  }
}

// ============================================================================
// Add account command
// ============================================================================

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a.trim()); }));
}

async function cmdAdd(args: string[]) {
  const name = args[0];
  if (!name) {
    console.log('Usage: bun src/cli.ts add <account-name>');
    return;
  }

  console.log(`\n🔐 Adding account: ${name}\n`);
  const pkce = await generatePKCE();
  
  const url = new URL("https://console.anthropic.com/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback");
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  console.log("1. Open this URL in your browser:\n");
  console.log(`   ${url.toString()}\n`);
  console.log("2. Log in to your Anthropic Max account");
  console.log("3. After approval, copy the FULL URL from browser\n");

  const callbackUrl = await prompt("Paste the callback URL here: ");

  let code: string;
  try {
    const parsed = new URL(callbackUrl);
    const c = parsed.searchParams.get("code") || "";
    const s = parsed.searchParams.get("state") || "";
    code = c && s ? `${c}#${s}` : callbackUrl;
  } catch { code = callbackUrl; }

  if (!code) { console.error("\n❌ Could not extract code"); return; }

  console.log("\n⏳ Exchanging code for tokens...");
  const splits = code.split("#");
  
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0], state: splits[1], grant_type: "authorization_code",
      client_id: CLIENT_ID, redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: pkce.verifier,
    }),
  });

  if (!response.ok) {
    console.error(`\n❌ Failed: ${response.status}`);
    return;
  }

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const auth = loadAuth();
  auth.anthropic ??= {};
  auth.anthropic.multiAccounts ??= { accounts: [] };
  auth.anthropic.multiAccounts.accounts ??= [];

  const account = { name, access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
  const idx = auth.anthropic.multiAccounts.accounts.findIndex((a: any) => a.name === name);
  
  if (idx >= 0) {
    auth.anthropic.multiAccounts.accounts[idx] = account;
    console.log(`\n✅ Updated: ${name}`);
  } else {
    auth.anthropic.multiAccounts.accounts.push(account);
    console.log(`\n✅ Added: ${name}`);
  }

  saveAuth(auth);
  console.log("🎉 Restart OpenCode to use the new account.\n");
}

// ============================================================================
// Main
// ============================================================================

function printHelp() {
  console.log(`
anthropic-multi-account CLI

Usage:
  bun src/cli.ts <command> [options]

Commands:
  usage [--watch]              Show usage across all accounts
  config [--show]              Show current config
  config --threshold <0-1>     Set switch threshold (default: 0.70)
  config --recover <0-1>       Set recover threshold (default: 0.60)
  config --interval <minutes>  Set recovery check interval (default: 60)
  config --reset               Reset config to defaults
  add <account-name>           Add/update an account via OAuth

Examples:
  bun src/cli.ts usage --watch
  bun src/cli.ts config --threshold 0.80 --recover 0.70
  bun src/cli.ts add max-5x
`);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'usage': case 'u': cmdUsage(args); break;
  case 'config': case 'c': cmdConfig(args); break;
  case 'add': case 'a': cmdAdd(args); break;
  default: printHelp();
}
