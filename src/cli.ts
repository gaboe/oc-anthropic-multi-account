#!/usr/bin/env bun

import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MULTI_AUTH_FILE = join(homedir(), ".local/share/opencode/multi-account-auth.json");
const STATE_FILE = join(homedir(), ".local/share/opencode/multi-account-state.json");

const DEFAULTS = { threshold: 0.70, checkInterval: 3600000 };

type PerMetric = { session5h: number; weekly7d: number; weekly7dSonnet: number };

function normalizeThresholds(value: any, fallback: number): PerMetric {
  if (typeof value === 'number') return { session5h: value, weekly7d: value, weekly7dSonnet: value };
  if (typeof value === 'object' && value !== null) {
    return {
      session5h: value.session5h ?? fallback,
      weekly7d: value.weekly7d ?? fallback,
      weekly7dSonnet: value.weekly7dSonnet ?? fallback
    };
  }
  return { session5h: fallback, weekly7d: fallback, weekly7dSonnet: fallback };
}

function allSame(pm: PerMetric): boolean {
  return pm.session5h === pm.weekly7d && pm.weekly7d === pm.weekly7dSonnet;
}

// ============================================================================
// File helpers (atomic write + backup fallback)
// ============================================================================

function safeReadJSON<T>(filePath: string, fallback: T): T {
  for (const path of [filePath, filePath + '.bak']) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (path.endsWith('.bak')) {
        console.log(`[multi-account] Recovered ${filePath} from backup`);
      }
      return data;
    } catch {
      continue;
    }
  }
  return fallback;
}

function safeWriteJSON(filePath: string, data: any) {
  try {
    if (existsSync(filePath)) {
      copyFileSync(filePath, filePath + '.bak');
    }
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[multi-account] Failed to save ${filePath}:`, e);
  }
}

function loadAccounts() {
  return safeReadJSON(MULTI_AUTH_FILE, { accounts: [] } as any).accounts || [];
}

function loadMultiAuth() {
  return safeReadJSON(MULTI_AUTH_FILE, { accounts: [] });
}

function saveMultiAuth(data: any) {
  safeWriteJSON(MULTI_AUTH_FILE, data);
}

function loadState() {
  return safeReadJSON(STATE_FILE, {});
}

function saveState(state: any) {
  safeWriteJSON(STATE_FILE, state);
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

const EMPTY_USAGE = {
  session5h: { utilization: 0, reset: null, status: 'allowed' },
  weekly7d: { utilization: 0, reset: null, status: 'allowed' },
  weekly7dSonnet: { utilization: 0, reset: null, status: 'allowed' },
  timestamp: null
};

function ensureAllAccountsInState(accounts: any[], state: any): boolean {
  if (!accounts?.length) return false;
  state.usage = state.usage || {};
  let changed = false;
  for (const account of accounts) {
    if (!state.usage[account.name]) {
      state.usage[account.name] = structuredClone(EMPTY_USAGE);
      changed = true;
    }
  }
  return changed;
}

function resolveStaleMetrics(state: any): boolean {
  const usage = state.usage;
  if (!usage) return false;
  const now = Date.now();
  let changed = false;
  for (const accountName of Object.keys(usage)) {
    for (const key of ['session5h', 'weekly7d', 'weekly7dSonnet'] as const) {
      const metric = usage[accountName]?.[key];
      if (metric?.reset && metric.reset * 1000 < now && metric.utilization > 0) {
        metric.utilization = 0;
        metric.status = 'allowed';
        changed = true;
      }
    }
  }
  return changed;
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
  
  const accountsChanged = ensureAllAccountsInState(accounts, state);
  const staleResolved = resolveStaleMetrics(state);
  if (accountsChanged || staleResolved) {
    autoEvaluate(state);
    saveState(state);
  }
  
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
    
    const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);
    const thresholdMap = { session5h: t.session5h, weekly7d: t.weekly7d, weekly7dSonnet: t.weekly7dSonnet } as const;
    
    for (const [label, key] of [['Session (5h)', 'session5h'], ['Weekly (all)', 'weekly7d'], ['Weekly (Sonnet)', 'weekly7dSonnet']] as const) {
      const u = usage[key]?.utilization || 0;
      const th = thresholdMap[key];
      const thLabel = `\x1b[2m(threshold ${Math.round(th * 100)}%)\x1b[0m`;
      console.log(`${c}│${r}`);
      console.log(`${c}│${r}  ${label}  ${thLabel}`);
      console.log(`${c}│${r}  ${colorize(progressBar(u), u)}  ${colorize(`${Math.round(u * 100)}%`, u)}`);
      console.log(`${c}│${r}  Resets ${formatResetTime(usage[key]?.reset)}`);
    }
    console.log(`${c}└─${r}`);
  }
  
  console.log('');
  
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
    const t = normalizeThresholds(cfg.threshold, DEFAULTS.threshold);
    
    console.log('\n  Current config:');
    if (allSame(t)) {
      console.log(`    Threshold:      ${Math.round(t.session5h * 100)}%`);
    } else {
      console.log(`    Threshold:`);
      console.log(`      Session (5h):    ${Math.round(t.session5h * 100)}%`);
      console.log(`      Weekly (all):    ${Math.round(t.weekly7d * 100)}%`);
      console.log(`      Weekly (Sonnet): ${Math.round(t.weekly7dSonnet * 100)}%`);
    }
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
  
  function ensureThresholdObject() {
    const current = state.config.threshold;
    if (typeof current === 'number') {
      state.config.threshold = { session5h: current, weekly7d: current, weekly7dSonnet: current };
    } else if (!current || typeof current !== 'object') {
      state.config.threshold = { session5h: DEFAULTS.threshold, weekly7d: DEFAULTS.threshold, weekly7dSonnet: DEFAULTS.threshold };
    }
  }
  
  const t = parseArg('--threshold');
  if (t) { state.config.threshold = parseFloat(t); changed = true; }
  
  // --thresholds 95,80,90 → session=95%, weekly=80%, sonnet=90%
  const ta = parseArg('--thresholds');
  if (ta) {
    const parts = ta.split(',').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      console.error('Usage: --thresholds <session>,<weekly>,<sonnet>  (e.g. --thresholds 95,80,90)');
      return;
    }
    state.config.threshold = { session5h: parts[0] / 100, weekly7d: parts[1] / 100, weekly7dSonnet: parts[2] / 100 };
    changed = true;
  }
  
  const ts = parseArg('--threshold-session');
  if (ts) { ensureThresholdObject(); state.config.threshold.session5h = parseFloat(ts); changed = true; }
  
  const tw = parseArg('--threshold-weekly');
  if (tw) { ensureThresholdObject(); state.config.threshold.weekly7d = parseFloat(tw); changed = true; }
  
  const tso = parseArg('--threshold-sonnet');
  if (tso) { ensureThresholdObject(); state.config.threshold.weekly7dSonnet = parseFloat(tso); changed = true; }
  
  const i = parseArg('--interval');
  if (i) { state.config.checkInterval = parseInt(i) * 60000; changed = true; }
  
  // Clean up legacy recover config
  delete state.config.recover;
  
  if (changed) {
    autoEvaluate(state);
    saveState(state);
    console.log('✓ Config saved');
    cmdConfig(['--show']);
  }
}

function autoEvaluate(state: any) {
  const accounts = loadAccounts();
  if (accounts.length < 2 || !state.currentAccount) return;
  
  const config = state.config || {};
  const t = normalizeThresholds(config.threshold, DEFAULTS.threshold);
  
  function isOverThreshold(usage: any): boolean {
    if (!usage) return false;
    return (
      (usage.session5h?.utilization || 0) > t.session5h ||
      (usage.weekly7d?.utilization || 0) > t.weekly7d ||
      (usage.weekly7dSonnet?.utilization || 0) > t.weekly7dSonnet
    );
  }
  
  const primary = accounts[0];
  const currentAccount = state.currentAccount;
  const primaryUsage = state.usage?.[primary.name];
  
  if (currentAccount === primary.name) {
    if (isOverThreshold(primaryUsage)) {
      for (const fallback of accounts.slice(1)) {
        if (!isOverThreshold(state.usage?.[fallback.name])) {
          state.currentAccount = fallback.name;
          console.log(`  ⚡ Auto-switch: ${primary.name} → ${fallback.name} (exceeds new thresholds)`);
          return;
        }
      }
    }
  } else {
    if (!isOverThreshold(primaryUsage)) {
      state.currentAccount = primary.name;
      console.log(`  ⚡ Auto-switch: ${currentAccount} → ${primary.name} (under new thresholds)`);
    }
  }
}

// ============================================================================
// Add account command
// ============================================================================

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a.trim()); }));
}

// Extract state (verifier) from auth URL
function extractStateFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.searchParams.get("state");
  } catch {
    return null;
  }
}

// Parse auth code - handles "code#state" or just "code"
function parseAuthCode(input: string): { code: string; state?: string } {
  if (input.includes("#")) {
    const [code, state] = input.split("#");
    return { code, state };
  }
  return { code: input };
}

async function cmdAdd(args: string[]) {
  const name = args[0];
  const authUrl = args[1];  // The authorization URL (contains state/verifier)
  const authCode = args[2]; // The auth code from callback

  if (!name) {
    console.log('Usage:');
    console.log('  bun src/cli.ts add <name>                    # Interactive mode');
    console.log('  bun src/cli.ts add <name> <auth-url> <code>  # Direct mode');
    console.log('  bun src/cli.ts add <name> <auth-url> <code#state>');
    return;
  }

  console.log(`\n🔐 Adding account: ${name}\n`);

  let code: string;
  let verifier: string;

  // Direct mode - URL and code provided
  if (authUrl && authCode) {
    const state = extractStateFromUrl(authUrl);
    const parsed = parseAuthCode(authCode);

    code = parsed.code;
    // Use state from auth code if present, otherwise from URL
    verifier = parsed.state || state || "";

    if (!verifier) {
      console.error("❌ Could not extract state/verifier from URL or code");
      return;
    }
  } else {
    // Interactive mode - generate PKCE and show auth URL
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

    const input = await prompt("Paste the callback URL here: ");

    // Try to parse as URL
    try {
      const parsed = new URL(input);
      code = parsed.searchParams.get("code") || input;
    } catch {
      code = input;
    }

    verifier = pkce.verifier;
  }

  console.log("⏳ Exchanging code for tokens...");

  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      state: verifier,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`\n❌ Failed: ${response.status} - ${text}`);
    return;
  }

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const multiAuth = loadMultiAuth();
  multiAuth.accounts ??= [];

  const account = { name, access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
  const idx = multiAuth.accounts.findIndex((a: any) => a.name === name);

  if (idx >= 0) {
    multiAuth.accounts[idx] = account;
    console.log(`\n✅ Updated: ${name}`);
  } else {
    multiAuth.accounts.push(account);
    console.log(`\n✅ Added: ${name}`);
  }

  saveMultiAuth(multiAuth);
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
  usage [--watch]                     Show usage across all accounts
  config [--show]                     Show current config
  config --threshold <0-1>            Set threshold for all metrics (default: 0.70)
  config --thresholds <s>,<w>,<so>   Set all thresholds at once (e.g. 95,80,90)
  config --threshold-session <0-1>    Set threshold for session (5h)
  config --threshold-weekly <0-1>     Set threshold for weekly (7d)
  config --threshold-sonnet <0-1>     Set threshold for weekly Sonnet (7d)
  config --interval <minutes>         Set recovery check interval (default: 60)
  config --reset                      Reset config to defaults
  add <name>                          Add account (interactive OAuth)
  add <name> <auth-url> <code>        Add account directly with URL + code

Examples:
  bun src/cli.ts usage --watch
  bun src/cli.ts config --thresholds 95,80,90
  bun src/cli.ts config --threshold 0.95
  bun src/cli.ts add max-5x
  bun src/cli.ts add max-20x "https://...?state=xyz" "code#state"
`);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'usage': case 'u': cmdUsage(args); break;
  case 'config': case 'c': cmdConfig(args); break;
  case 'add': case 'a': cmdAdd(args); break;
  default: printHelp();
}
