# oc-anthropic-multi-account

[![npm version](https://img.shields.io/npm/v/oc-anthropic-multi-account)](https://www.npmjs.com/package/oc-anthropic-multi-account)

Never hit a Claude rate limit again with proactive multi-account switching for OpenCode.

## Installation

### 1. Add plugin to OpenCode config

Add to your `opencode.json` (global or project-level):

```json
{
  "plugin": [
    "oc-anthropic-multi-account@latest"
  ]
}
```

OpenCode will install the plugin automatically on next launch.

### 2. Disable default Anthropic plugin

Add this to your `~/.zshrc` or `~/.bashrc`:

MacOS
```bash
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
```
Windows
```bash
setx OPENCODE_DISABLE_DEFAULT_PLUGINS true #spustit v CMD
```


Without this, the built-in Anthropic plugin will override the custom fetch wrapper.

### 3. Configure accounts

The CLI (`src/cli.ts`) isn't bundled in the npm package. Clone the repo to use it:

```bash
git clone git@github.com:gaboe/oc-anthropic-multi-account.git
cd oc-anthropic-multi-account
bun install
```

Add accounts (the first account added is the primary):

```bash
bun src/cli.ts add primary
bun src/cli.ts add fallback1
bun src/cli.ts add fallback2
```

You can name accounts anything, such as `work`, `personal`, or `backup`. The CLI will guide you through OAuth authentication for each account.

Each account requires a separate Anthropic Max subscription.

<details>
<summary>Manual configuration (advanced)</summary>

Tokens are stored in `~/.config/opencode/anthropic-multi-account-accounts.json`:

```json
{
  "accounts": [
    {
      "name": "primary",
      "access": "your-access-token",
      "refresh": "your-refresh-token",
      "expires": 1234567890000
    }
  ]
}
```

Tokens are automatically refreshed when expired.
</details>

### 4. Restart OpenCode

```bash
opencode
```

## Why This Plugin?

Claude Max subscriptions have strict rate limits. Hitting them kills your flow and forces you to wait minutes or hours before you can work again. This plugin manages multiple accounts and automatically switches between them based on real-time usage metrics.

### What This Plugin Does Differently

- Proactive switching reads rate limit headers from every response and switches before you hit a 429 error.
- Tracks 3 independent metrics: session (5h), weekly (all models), and weekly (Sonnet).
- Per-metric configurable thresholds allow fine-grained control over when to switch.
- Mid-session switching ensures you aren't stuck with a depleted account.
- Primary-first logic with automatic recovery switches back when your main account recovers.
- Atomic file writes with backups ensure crash-safe state persistence.
- Works with any number of accounts and subscription tiers (5x, 20x, or a mix).
- Live usage dashboard via CLI provides full visibility into your account status.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      Request Flow                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Request  ──►  Check primary metrics  ──►  Route request  │
│                        │                        │           │
│                        ▼                        ▼           │
│               Any metric > 70%?         Use selected        │
│                   │       │              account            │
│                  YES      NO                 │              │
│                   │       │                  ▼              │
│                   ▼       ▼           Capture response      │
│            Use fallback  Use primary    headers             │
│                                              │              │
│                                              ▼              │
│                                        Update usage         │
│                                        metrics              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Account Priority

- **accounts[0]** = Primary (always preferred)
- **accounts[1..n]** = Fallbacks (in order of preference)

### Threshold Logic

Each metric (session, weekly, sonnet) can have its own threshold.

| Condition | Action |
|-----------|--------|
| Any primary metric > its **threshold** | Switch to first fallback under thresholds |
| All primary metrics < their **thresholds** | Switch back to primary |
| On fallback | Check recovery every **1 hour** or on rate limit window reset |

### Metrics Tracked

Anthropic sends these headers with every response (no extra API calls needed):

- `anthropic-ratelimit-unified-5h-utilization` - 5-hour rolling window
- `anthropic-ratelimit-unified-7d-utilization` - 7-day rolling window  
- `anthropic-ratelimit-unified-7d_sonnet-utilization` - 7-day Sonnet-specific

## CLI

All commands via unified CLI:

```bash
bun src/cli.ts usage              # show usage
bun src/cli.ts usage --watch      # live updates (5s)
bun src/cli.ts config             # show config
bun src/cli.ts config --thresholds 95,80,90   # session, weekly, sonnet
bun src/cli.ts config --threshold 0.80        # same value for all metrics
bun src/cli.ts config --interval 30           # recovery check interval (minutes)
bun src/cli.ts add <account-name>             # add account via OAuth
```

Example output:

```
╔══════════════════════════════════════════════════════════════════╗
║              oc-anthropic-multi-account                          ║
╚══════════════════════════════════════════════════════════════════╝

┌─ max-5x ◄── ACTIVE
│
│  Session (5h)  (threshold 95%)
│  █████████                                           18%
│  Resets Feb 4 at 5:00 PM
│
│  Weekly (all)  (threshold 80%)
│  ██                                                  4%
│  Resets Feb 11 at 9:00 AM
│
│  Weekly (Sonnet)  (threshold 90%)
│  █                                                   2%
│  Resets Feb 16 at 8:00 AM
└─

┌─ max-20x
│  ...
└─

  Requests: 473
```

Colors: 🟢 < 50% │ 🟡 50-70% │ 🔴 > 70% │ 🔵 active

## Configuration

Configure via CLI (saved to state file):

```bash
bun src/cli.ts config --thresholds 95,80,90   # set session, weekly, sonnet thresholds
bun src/cli.ts config --threshold 0.80         # same threshold for all metrics
bun src/cli.ts config --threshold-session 0.95  # set individual metric
bun src/cli.ts config --threshold-weekly 0.80
bun src/cli.ts config --threshold-sonnet 0.90
bun src/cli.ts config --interval 30             # check recovery every 30 min
bun src/cli.ts config --reset                   # reset to defaults
```

Defaults: threshold=70%, interval=60min

Changing config auto-evaluates whether the active account should switch.

## Data Storage

Data is split into two files to prevent corruption from frequent writes:

**`~/.config/opencode/anthropic-multi-account-accounts.json`** - Tokens (changes rarely)
- `accounts` - Array of accounts with access/refresh tokens

**`~/.config/opencode/anthropic-multi-account-state.json`** - Runtime state (changes frequently)
- `currentAccount` - Currently active account name
- `usage` - Per-account usage metrics with timestamps
- `requestCount` - Total requests made through the plugin
- `lastPrimaryCheck` - Timestamp of last recovery check

## Comparison

| Tool | Multi-Account | Proactive Switching | Header-Based Metrics | Mid-Session Switch | OpenCode Plugin |
|------|--------------|--------------------|--------------------|-------------------|----------------|
| **oc-anthropic-multi-account** | Yes (unlimited) | Yes (threshold-based) | Yes (3 metrics) | Yes | Yes |
| anthropic-multi-auth | Yes | No (session-sticky) | No (quota API check) | No | Yes |
| OpenCode built-in | Single account | No | No | N/A | Yes |

## License

MIT
