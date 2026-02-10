# anthropic-multi-account

OpenCode plugin for managing multiple Anthropic Max subscription accounts with automatic failover based on rate limit utilization.

## Why?

Anthropic Max subscriptions have rate limits. This plugin automatically switches between multiple accounts based on usage - keeping your primary account as long as possible while failing over to backups when needed.

**Works with any number of accounts** - 2x 5x, 3x 5x, 5x + 20x, etc.

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

## Installation

### 1. Clone and install

```bash
git clone git@github.com:gaboe/anthropic-multi-account.git
cd anthropic-multi-account
bun install
```

### 2. Symlink to OpenCode plugins

```bash
mkdir -p ~/.config/opencode/plugins
ln -s $(pwd) ~/.config/opencode/plugins/anthropic-multi-account
```

### 3. Disable default Anthropic plugin

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
```

**Important**: Without this, the built-in Anthropic plugin will override the custom fetch wrapper.

### 4. Configure accounts

Add accounts using the CLI (first = primary, rest = fallbacks):

```bash
bun src/cli.ts add primary
bun src/cli.ts add fallback1
bun src/cli.ts add fallback2
```

Name accounts whatever you want - `work`, `personal`, `max-5x`, `backup`, etc.

The CLI will guide you through OAuth authentication for each account.

**Important**: Each account requires a **separate Anthropic Max subscription**.

<details>
<summary>Manual configuration (advanced)</summary>

Tokens are stored in `~/.local/share/opencode/multi-account-auth.json`:

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

### 5. Restart OpenCode

```bash
opencode
```

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
║              anthropic-multi-account                             ║
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

**`~/.local/share/opencode/multi-account-auth.json`** - Tokens (changes rarely)
- `accounts` - Array of accounts with access/refresh tokens

**`~/.local/share/opencode/multi-account-state.json`** - Runtime state (changes frequently)
- `currentAccount` - Currently active account name
- `usage` - Per-account usage metrics with timestamps
- `requestCount` - Total requests made through the plugin
- `lastPrimaryCheck` - Timestamp of last recovery check

## License

MIT
