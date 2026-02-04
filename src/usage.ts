#!/usr/bin/env bun

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");
const STATE_FILE = join(homedir(), ".local/share/opencode/multi-account-state.json");
const WATCH_INTERVAL = 5000; // 5 seconds

function loadAccounts() {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    return data.anthropic?.multiAccounts?.accounts || [];
  } catch {
    return [];
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// Format progress bar (50 chars)
function progressBar(utilization: number): string {
  const percentage = Math.round(utilization * 100);
  const filled = Math.floor(percentage / 2);
  const halfBlock = (percentage % 2 === 1) ? '▌' : '';
  const empty = 50 - filled - (halfBlock ? 1 : 0);
  return '█'.repeat(filled) + halfBlock + ' '.repeat(Math.max(0, empty));
}

// Format reset time
function formatResetTime(unixTimestamp: number | null): string {
  if (!unixTimestamp) return "Unknown";
  const date = new Date(unixTimestamp * 1000);
  return new Intl.DateTimeFormat('default', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

// Color based on utilization
function colorize(text: string, utilization: number): string {
  if (utilization >= 0.7) return `\x1b[31m${text}\x1b[0m`; // Red
  if (utilization >= 0.5) return `\x1b[33m${text}\x1b[0m`; // Yellow
  return `\x1b[32m${text}\x1b[0m`; // Green
}

function render(watchMode: boolean) {
  const accounts = loadAccounts();
  const state = loadState();
  
  if (watchMode) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              anthropic-multi-account usage                       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  
  if (!accounts.length) {
    console.log("\n  No multi-account configuration found");
    return;
  }

  for (const account of accounts) {
    const isActive = state.currentAccount === account.name;
    const marker = isActive ? ' \x1b[1;36m◄── ACTIVE\x1b[0m' : '';
    console.log(`\n┌─ ${isActive ? '\x1b[1;37m' : ''}${account.name}\x1b[0m${marker}`);
    
    const usage = state.usage?.[account.name];
    if (!usage) {
      console.log('│  No usage data yet');
      console.log('└─');
      continue;
    }
    
    // Session (5h)
    const sessionUtil = usage.session5h?.utilization || 0;
    const sessionPct = Math.round(sessionUtil * 100);
    console.log('│');
    console.log(`│  Session (5h)`);
    console.log(`│  ${colorize(progressBar(sessionUtil), sessionUtil)}  ${colorize(`${sessionPct}%`, sessionUtil)}`);
    console.log(`│  Resets ${formatResetTime(usage.session5h?.reset)}`);
    
    // Weekly (all)
    const weeklyUtil = usage.weekly7d?.utilization || 0;
    const weeklyPct = Math.round(weeklyUtil * 100);
    console.log('│');
    console.log(`│  Weekly (all models)`);
    console.log(`│  ${colorize(progressBar(weeklyUtil), weeklyUtil)}  ${colorize(`${weeklyPct}%`, weeklyUtil)}`);
    console.log(`│  Resets ${formatResetTime(usage.weekly7d?.reset)}`);
    
    // Weekly (Sonnet)
    const sonnetUtil = usage.weekly7dSonnet?.utilization || 0;
    const sonnetPct = Math.round(sonnetUtil * 100);
    console.log('│');
    console.log(`│  Weekly (Sonnet)`);
    console.log(`│  ${colorize(progressBar(sonnetUtil), sonnetUtil)}  ${colorize(`${sonnetPct}%`, sonnetUtil)}`);
    console.log(`│  Resets ${formatResetTime(usage.weekly7dSonnet?.reset)}`);
    console.log('└─');
  }
  
  console.log(`\n  Requests: ${state.requestCount || 0}`);
  
  if (watchMode) {
    console.log(`  Updated: ${new Date().toLocaleTimeString()}`);
    console.log(`\n  Press Ctrl+C to exit`);
  }
}

const args = process.argv.slice(2);
const watchMode = args.includes('--watch') || args.includes('-w');

if (watchMode) {
  render(true);
  setInterval(() => render(true), WATCH_INTERVAL);
} else {
  render(false);
}
