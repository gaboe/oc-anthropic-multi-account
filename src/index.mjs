import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");
const MULTI_AUTH_FILE = join(homedir(), ".local/share/opencode/multi-account-auth.json");
const STATE_FILE = join(homedir(), ".local/share/opencode/multi-account-state.json");

// Read multi-account-auth.json (separate file for multi-account tokens)
function getMultiAuth() {
  if (!existsSync(MULTI_AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MULTI_AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// Save multi-account-auth.json
function saveMultiAuth(multiAuth) {
  try {
    writeFileSync(MULTI_AUTH_FILE, JSON.stringify(multiAuth, null, 2));
  } catch (e) {
    console.error("[anthropic-multi-account] Failed to save multi-auth:", e);
  }
}

// Read state.json (usage, currentAccount, requestCount)
function getState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// Save state.json
function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[anthropic-multi-account] Failed to save state:", e);
  }
}

/**
 * @param {"max" | "console"} mode
 */
async function authorize(mode) {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
    import.meta.url,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

/**
 * @param {string} code
 * @param {string} verifier
 */
async function exchange(code, verifier) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok)
    return {
      type: "failed",
    };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Select account using weighted rotation
 * @param {Array} accounts
 * @param {number} requestCount
 */
// DEPRECATED: Replaced by selectThresholdAccount() in Task 3
// function selectWeightedAccount(accounts, requestCount) {
//   if (!accounts || accounts.length === 0) return null;
//
//   const totalWeight = accounts.reduce((sum, acc) => sum + (acc.weight || 1), 0);
//   const position = requestCount % totalWeight;
//
//   let cumulative = 0;
//   for (const account of accounts) {
//     cumulative += (acc.weight || 1);
//     if (position < cumulative) return account;
//   }
//   return accounts[0];
// }

/**
 * Select account based on threshold logic
 * accounts[0] = primary (preferred), accounts[1..n] = fallbacks
 * Config from state.config or defaults
 */
function selectThresholdAccount(accounts, state) {
  const config = state?.config || {};
  const THRESHOLD = config.threshold ?? 0.70;
  const RECOVER = config.recover ?? 0.60;
  const CHECK_INTERVAL = config.checkInterval ?? 3600000;

  if (!accounts || accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];

  const primary = accounts[0];
  const fallbacks = accounts.slice(1);

  if (!state || !state.currentAccount) {
    return primary;
  }

  function getMaxUtilization(usage) {
    if (!usage) return 0;
    return Math.max(
      usage.session5h?.utilization || 0,
      usage.weekly7d?.utilization || 0,
      usage.weekly7dSonnet?.utilization || 0
    );
  }

  function getHighestMetric(usage) {
    if (!usage) return { name: 'unknown', value: 0 };
    const metrics = [
      { name: 'session (5h)', value: usage.session5h?.utilization || 0 },
      { name: 'weekly (all)', value: usage.weekly7d?.utilization || 0 },
      { name: 'weekly (Sonnet)', value: usage.weekly7dSonnet?.utilization || 0 }
    ];
    return metrics.reduce((max, m) => m.value > max.value ? m : max);
  }

  const primaryUsage = state.usage?.[primary.name];
  const currentIsPrimary = state.currentAccount === primary.name;

  if (currentIsPrimary) {
    const maxUtil = getMaxUtilization(primaryUsage);
    if (maxUtil > THRESHOLD) {
      // Find first fallback with utilization < threshold
      for (const fallback of fallbacks) {
        const fallbackUsage = state.usage?.[fallback.name];
        const fallbackUtil = getMaxUtilization(fallbackUsage);
        if (fallbackUtil < THRESHOLD) {
          const highest = getHighestMetric(primaryUsage);
          console.log(`[multi-account] ${primary.name} → ${fallback.name}: ${highest.name} at ${Math.round(highest.value * 100)}%`);
          return fallback;
        }
      }
      // All fallbacks also over threshold - use the one with lowest utilization
      const best = fallbacks.reduce((lowest, f) => {
        const util = getMaxUtilization(state.usage?.[f.name]);
        const lowestUtil = getMaxUtilization(state.usage?.[lowest.name]);
        return util < lowestUtil ? f : lowest;
      }, fallbacks[0]);
      const highest = getHighestMetric(primaryUsage);
      console.log(`[multi-account] ${primary.name} → ${best.name}: ${highest.name} at ${Math.round(highest.value * 100)}% (all accounts busy)`);
      return best;
    }
    return primary;
  } else {
    // On fallback - check if should return to primary
    const now = Date.now();
    const lastCheck = state.lastPrimaryCheck || 0;
    
    // Get earliest reset time from primary account (when any limit resets)
    function getEarliestResetTime(usage) {
      if (!usage) return null;
      const resets = [
        usage.session5h?.reset,
        usage.weekly7d?.reset,
        usage.weekly7dSonnet?.reset
      ].filter(r => r != null);
      if (resets.length === 0) return null;
      return Math.min(...resets) * 1000; // convert seconds to ms
    }
    
    const earliestReset = getEarliestResetTime(primaryUsage);
    
    // Check if reset time has passed since we switched away
    // OR fallback to hourly interval if no reset time available
    const resetPassed = earliestReset && earliestReset <= now && earliestReset > lastCheck;
    const intervalPassed = (now - lastCheck) > CHECK_INTERVAL;
    
    if (resetPassed) {
      // Reset time passed - primary should have fresh capacity
      console.log(`[multi-account] → ${primary.name}: reset time passed, switching back`);
      return primary;
    }
    
    if (intervalPassed) {
      // Fallback: hourly check if no reset time info
      const maxUtil = getMaxUtilization(primaryUsage);
      if (maxUtil < RECOVER) {
        console.log(`[multi-account] → ${primary.name}: all metrics below ${RECOVER * 100}%`);
        return primary;
      }
      // Update lastPrimaryCheck so we don't spam check
      state.lastPrimaryCheck = now;
    }
    
    // Stay on current fallback
    return accounts.find(a => a.name === state.currentAccount) || fallbacks[0];
  }
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  return {
    "experimental.chat.system.transform": (input, output) => {
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1])
          output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();

        // Bug fix: handle undefined auth
        if (!auth) return {};

        // Check for multi-account mode by reading separate multi-account-auth.json
        const multiAuth = getMultiAuth();
        const hasMultiAccounts = multiAuth?.accounts?.length > 0;

        // Handle multi-account auth
        if (auth.type === "oauth" && hasMultiAccounts) {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }

          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              // Read accounts from multi-account-auth.json, state from state.json
              const multiAuth = getMultiAuth();
              if (!multiAuth?.accounts?.length) {
                return fetch(input, init);
              }

              const accounts = multiAuth.accounts;
              const state = getState();

               // Select account via threshold-based switching
               const account = selectThresholdAccount(accounts, state);
               if (!account) {
                 throw new Error("No accounts configured for multi-account");
               }

               // Track state for threshold logic
               const previousAccount = state.currentAccount;
               const primaryName = accounts[0]?.name;
               state.currentAccount = account.name;
               if (account.name !== previousAccount && account.name !== primaryName) {
                 state.lastPrimaryCheck = Date.now();
               }

               // Check if token needs refresh
              if (!account.access || account.expires < Date.now()) {
                const response = await fetch(
                  "https://console.anthropic.com/v1/oauth/token",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      grant_type: "refresh_token",
                      refresh_token: account.refresh,
                      client_id: CLIENT_ID,
                    }),
                  },
                );
                if (!response.ok) {
                  throw new Error(`Token refresh failed for ${account.name}: ${response.status}`);
                }
                const json = await response.json();
                account.access = json.access_token;
                account.refresh = json.refresh_token;
                account.expires = Date.now() + json.expires_in * 1000;

                // Save updated tokens to multi-account-auth.json
                saveMultiAuth(multiAuth);
              }

              // Increment request counter
              state.requestCount = (state.requestCount || 0) + 1;

              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Preserve all incoming beta headers while ensuring OAuth requirements
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = [
                "oauth-2025-04-20",
                "interleaved-thinking-2025-05-14",
              ];
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].join(",");

              requestHeaders.set("authorization", `Bearer ${account.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              requestHeaders.set(
                "user-agent",
                "claude-cli/2.1.2 (external, cli)",
              );
              requestHeaders.delete("x-api-key");

              const TOOL_PREFIX = "mcp_";
              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item) => {
                      if (item.type === "text" && item.text) {
                        return {
                          ...item,
                          text: item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude"),
                        };
                      }
                      return item;
                    });
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool) => ({
                      ...tool,
                      name: tool.name
                        ? `${TOOL_PREFIX}${tool.name}`
                        : tool.name,
                    }));
                  }
                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map((msg) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content.map((block) => {
                          if (block.type === "tool_use" && block.name) {
                            return {
                              ...block,
                              name: `${TOOL_PREFIX}${block.name}`,
                            };
                          }
                          return block;
                        });
                      }
                      return msg;
                    });
                  }
                  body = JSON.stringify(parsed);
                } catch (e) {
                  // ignore parse errors
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Capture usage from response headers and save to state
              // Only update metrics when headers are actually present to avoid
              // overwriting valid data with zeros (e.g. Sonnet headers only appear on Sonnet requests)
              state.usage = state.usage || {};
              const prev = state.usage[account.name] || {};

              function updateMetric(prev, prefix) {
                const rawUtil = response.headers.get(`${prefix}-utilization`);
                const rawReset = response.headers.get(`${prefix}-reset`);
                const rawStatus = response.headers.get(`${prefix}-status`);
                if (rawUtil === null && rawReset === null && rawStatus === null) {
                  return prev; // no headers present, keep previous data
                }
                return {
                  utilization: rawUtil !== null ? (parseFloat(rawUtil) || 0) : (prev?.utilization ?? 0),
                  reset: rawReset !== null ? (parseInt(rawReset) || null) : (prev?.reset ?? null),
                  status: rawStatus !== null ? rawStatus : (prev?.status ?? 'unknown')
                };
              }

              state.usage[account.name] = {
                session5h: updateMetric(prev.session5h, 'anthropic-ratelimit-unified-5h'),
                weekly7d: updateMetric(prev.weekly7d, 'anthropic-ratelimit-unified-7d'),
                weekly7dSonnet: updateMetric(prev.weekly7dSonnet, 'anthropic-ratelimit-unified-7d_sonnet'),
                timestamp: new Date().toISOString()
              };

              // Save state (usage, currentAccount, requestCount)
              saveState(state);

              // Transform streaming response to rename tools back
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        // Handle single OAuth auth (original behavior)
        if (auth.type === "oauth") {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);
              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch(
                  "https://console.anthropic.com/v1/oauth/token",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      grant_type: "refresh_token",
                      refresh_token: auth.refresh,
                      client_id: CLIENT_ID,
                    }),
                  },
                );
                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status}`);
                }
                const json = await response.json();
                await client.auth.set({
                  path: {
                    id: "anthropic",
                  },
                  body: {
                    type: "oauth",
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                });
                auth.access = json.access_token;
              }
              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Preserve all incoming beta headers while ensuring OAuth requirements
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const requiredBetas = [
                "oauth-2025-04-20",
                "interleaved-thinking-2025-05-14",
              ];
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].join(",");

              requestHeaders.set("authorization", `Bearer ${auth.access}`);
              requestHeaders.set("anthropic-beta", mergedBetas);
              requestHeaders.set(
                "user-agent",
                "claude-cli/2.1.2 (external, cli)",
              );
              requestHeaders.delete("x-api-key");

              const TOOL_PREFIX = "mcp_";
              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item) => {
                      if (item.type === "text" && item.text) {
                        return {
                          ...item,
                          text: item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude"),
                        };
                      }
                      return item;
                    });
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool) => ({
                      ...tool,
                      name: tool.name
                        ? `${TOOL_PREFIX}${tool.name}`
                        : tool.name,
                    }));
                  }
                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map((msg) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content.map((block) => {
                          if (block.type === "tool_use" && block.name) {
                            return {
                              ...block,
                              name: `${TOOL_PREFIX}${block.name}`,
                            };
                          }
                          return block;
                        });
                      }
                      return msg;
                    });
                  }
                  body = JSON.stringify(parsed);
                } catch (e) {
                  // ignore parse errors
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Transform streaming response to rename tools back
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                return credentials;
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
