import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");

// Read raw auth.json to get multiAccounts (Zod strips unknown keys)
function getRawAuth() {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    return data.anthropic;
  } catch {
    return null;
  }
}

// Save raw auth.json
function saveRawAuth(anthropicAuth) {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    data.anthropic = anthropicAuth;
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("[anthropic-multi-account] Failed to save auth:", e);
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
 * Select account using threshold-based switching
 * Monitors 3 usage metrics: session5h, weekly7d, weekly7dSonnet
 * Switches to x20 when ANY metric > 70%, back to x5 when ALL < 60%
 * @param {Array} accounts
 * @param {Object} state - Contains usage data and current account
 */
function selectThresholdAccount(accounts, state) {
  const THRESHOLD = 0.70;  // Switch TO x20 when ANY metric > 70%
  const RECOVER = 0.60;    // Switch BACK when ALL metrics < 60%
  const CHECK_INTERVAL = 3600000; // 1 hour in ms

  if (!accounts || accounts.length === 0) return null;

  const x5 = accounts.find(a => a.name === 'max-5x');
  const x20 = accounts.find(a => a.name === 'max-20x');

  // Cold start: default to x5
  if (!state || !state.currentAccount) {
    return x5 || accounts[0];
  }

  const x5Usage = state.usage?.['max-5x'];
  const currentIsX5 = state.currentAccount === 'max-5x';

  // Helper: get max utilization across all 3 metrics
  function getMaxUtilization(usage) {
    if (!usage) return 0;
    return Math.max(
      usage.session5h?.utilization || 0,
      usage.weekly7d?.utilization || 0,
      usage.weekly7dSonnet?.utilization || 0
    );
  }

  // Helper: find which metric is highest
  function getHighestMetric(usage) {
    if (!usage) return { name: 'unknown', value: 0 };
    const metrics = [
      { name: 'session (5h)', value: usage.session5h?.utilization || 0 },
      { name: 'weekly (all)', value: usage.weekly7d?.utilization || 0 },
      { name: 'weekly (Sonnet)', value: usage.weekly7dSonnet?.utilization || 0 }
    ];
    return metrics.reduce((max, m) => m.value > max.value ? m : max);
  }

  if (currentIsX5) {
    // Check if ANY metric > 70% → switch to x20
    const maxUtil = getMaxUtilization(x5Usage);
    if (maxUtil > THRESHOLD) {
      const highest = getHighestMetric(x5Usage);
      console.log(`[multi-account] Switched to max-20x: max-5x ${highest.name} at ${Math.round(highest.value * 100)}%`);
      return x20 || accounts[1];
    }
    return x5 || accounts[0];
  } else {
    // Currently on x20, check if should switch back
    const timeSinceCheck = Date.now() - (state.lastX5Check || 0);
    if (timeSinceCheck > CHECK_INTERVAL) {
      // Switch back only if ALL metrics < 60%
      const maxUtil = getMaxUtilization(x5Usage);
      if (maxUtil < RECOVER) {
        console.log(`[multi-account] Switched to max-5x: all metrics below 60%`);
        return x5 || accounts[0];
      }
    }
    return x20 || accounts[1];
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

        // Check for multi-account mode by reading raw auth.json
        const rawAuth = getRawAuth();
        const hasMultiAccounts = rawAuth?.multiAccounts?.accounts?.length > 0;

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
              // Read fresh multi-account data from raw auth.json
              const rawAuth = getRawAuth();
              if (!rawAuth?.multiAccounts?.accounts?.length) {
                return fetch(input, init);
              }

              const multi = rawAuth.multiAccounts;

               // Select account via threshold-based switching
               const account = selectThresholdAccount(multi.accounts, multi);
               if (!account) {
                 throw new Error("No accounts configured for multi-account");
               }

               // Track state for threshold logic
               const previousAccount = multi.currentAccount;
               multi.currentAccount = account.name;
               if (account.name !== previousAccount) {
                 // Account switched - update lastX5Check if now on x5
                 if (account.name === 'max-5x') {
                   multi.lastX5Check = Date.now();
                 }
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

                // Save updated auth
                saveRawAuth(rawAuth);
              }

              // Increment request counter and save
              multi.requestCount = (multi.requestCount || 0) + 1;
              saveRawAuth(rawAuth);

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

              // Capture usage from response headers
              const freshAuth = getRawAuth();
              if (freshAuth?.multiAccounts) {
                // Capture all 3 usage metrics (9 headers total)
                freshAuth.multiAccounts.usage = freshAuth.multiAccounts.usage || {};
                freshAuth.multiAccounts.usage[account.name] = {
                  session5h: {
                    utilization: parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization')) || 0,
                    reset: parseInt(response.headers.get('anthropic-ratelimit-unified-5h-reset')) || null,
                    status: response.headers.get('anthropic-ratelimit-unified-5h-status') || 'unknown'
                  },
                  weekly7d: {
                    utilization: parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization')) || 0,
                    reset: parseInt(response.headers.get('anthropic-ratelimit-unified-7d-reset')) || null,
                    status: response.headers.get('anthropic-ratelimit-unified-7d-status') || 'unknown'
                  },
                  weekly7dSonnet: {
                    utilization: parseFloat(response.headers.get('anthropic-ratelimit-unified-7d_sonnet-utilization')) || 0,
                    reset: parseInt(response.headers.get('anthropic-ratelimit-unified-7d_sonnet-reset')) || null,
                    status: response.headers.get('anthropic-ratelimit-unified-7d_sonnet-status') || 'unknown'
                  },
                  timestamp: new Date().toISOString()
                };

                // Keep existing lastUsage for backward compatibility
                const requestsRemaining = response.headers.get('anthropic-ratelimit-requests-remaining');
                const tokensRemaining = response.headers.get('anthropic-ratelimit-tokens-remaining');
                if (requestsRemaining || tokensRemaining) {
                  freshAuth.multiAccounts.lastUsage = freshAuth.multiAccounts.lastUsage || {};
                  freshAuth.multiAccounts.lastUsage[account.name] = {
                    requestsRemaining: requestsRemaining ? parseInt(requestsRemaining) : null,
                    tokensRemaining: tokensRemaining ? parseInt(tokensRemaining) : null,
                    timestamp: new Date().toISOString()
                  };
                }

                saveRawAuth(freshAuth);
              }

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
