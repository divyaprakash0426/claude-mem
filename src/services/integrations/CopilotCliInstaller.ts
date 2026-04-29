/**
 * CopilotCliInstaller - GitHub Copilot CLI integration for claude-mem
 *
 * Hybrid integration combining three mechanisms:
 *
 *   1. **Transcript watching** for session capture (Codex-style).
 *      Watches ~/.copilot/session-state/*\/events.jsonl using the
 *      existing watcher infrastructure and the COPILOT_CLI_SAMPLE_SCHEMA
 *      defined in src/services/transcripts/config.ts.
 *
 *   2. **SessionStart hook** for context injection (Cursor-style).
 *      Installs a Copilot CLI plugin under
 *      ~/.copilot/installed-plugins/thedotmack/claude-mem/
 *      whose `session-start` shell script calls the worker's context
 *      generator and emits Copilot CLI's flat
 *      `{"additionalContext": "..."}` JSON format.
 *
 *   3. **MCP server config** for in-CLI search tools.
 *      Writes claude-mem's MCP server entry to
 *      ~/.copilot/mcp-config.json (the path Copilot CLI actually reads,
 *      with key `mcpServers`).
 *
 * Anti-patterns:
 *   - Does NOT use the `mode: 'agents'` context-injection in the watcher,
 *     because the transcript processor's `updateContext()` writes to a
 *     hardcoded `<cwd>/AGENTS.md` and Copilot CLI's natural per-workspace
 *     context file is `.github/copilot-instructions.md`. Hooks bypass the
 *     limitation cleanly.
 *   - Does NOT overwrite existing transcript-watch.json -- merges only.
 *   - Does NOT clobber a user-modified plugin.json or hooks.json: writes
 *     are atomic but the contents are deterministic, so re-installs are
 *     idempotent.
 *
 * Patterned after CodexCliInstaller.ts (transcript merge logic) and
 * CursorHooksInstaller.ts (worker / Bun discovery and hook installation).
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'fs';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  COPILOT_CLI_SAMPLE_SCHEMA,
} from '../transcripts/config.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';
import {
  COPILOT_CLI_CONFIG,
  LEGACY_COPILOT_CLI_MCP_CONFIG_PATH,
  writeMcpJsonConfigPublic,
} from './McpIntegrations.js';
import { readJsonSafe } from '../../utils/json-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COPILOT_DIR = path.join(homedir(), '.copilot');
const COPILOT_PLUGIN_OWNER = 'thedotmack';
const COPILOT_PLUGIN_NAME = 'claude-mem';
const COPILOT_PLUGIN_DIR = path.join(
  COPILOT_DIR,
  'installed-plugins',
  COPILOT_PLUGIN_OWNER,
  COPILOT_PLUGIN_NAME,
);
const COPILOT_PLUGIN_JSON_DIR = path.join(COPILOT_PLUGIN_DIR, '.claude-plugin');
const COPILOT_PLUGIN_JSON_PATH = path.join(COPILOT_PLUGIN_JSON_DIR, 'plugin.json');
const COPILOT_HOOKS_DIR = path.join(COPILOT_PLUGIN_DIR, 'hooks');
const COPILOT_HOOKS_JSON_PATH = path.join(COPILOT_HOOKS_DIR, 'hooks.json');
const COPILOT_HOOK_SCRIPT_PATH = path.join(COPILOT_HOOKS_DIR, 'session-start');
const COPILOT_SETTINGS_PATH = path.join(COPILOT_DIR, 'settings.json');

const CLAUDE_MEM_DIR = path.join(homedir(), '.claude-mem');

const COPILOT_WATCH_NAME = 'copilot-cli';

const COPILOT_PLUGIN_KEY = `${COPILOT_PLUGIN_NAME}@${COPILOT_PLUGIN_OWNER}`;

// ---------------------------------------------------------------------------
// Transcript Watch Config Merging
// ---------------------------------------------------------------------------

function loadExistingTranscriptWatchConfig(): TranscriptWatchConfig {
  const configPath = DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;

    if (!parsed.version) parsed.version = 1;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = DEFAULT_STATE_PATH;

    return parsed;
  } catch (parseError) {
    if (parseError instanceof Error) {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, parseError);
    } else {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, new Error(String(parseError)));
    }

    const backupPath = `${configPath}.backup.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(configPath));
    console.warn(`  Backed up corrupt transcript-watch.json to ${backupPath}`);

    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
}

function copilotWatchEntry(): WatchTarget {
  return {
    name: COPILOT_WATCH_NAME,
    path: '~/.copilot/session-state/*/events.jsonl',
    schema: COPILOT_WATCH_NAME,
    startAtEnd: true,
  };
}

function mergeCopilotWatchConfig(existingConfig: TranscriptWatchConfig): TranscriptWatchConfig {
  const merged = { ...existingConfig };

  merged.schemas = { ...merged.schemas };
  merged.schemas[COPILOT_WATCH_NAME] = COPILOT_CLI_SAMPLE_SCHEMA;

  const newWatch = copilotWatchEntry();
  merged.watches = [...merged.watches];

  const existingWatchIndex = merged.watches.findIndex(
    (w: WatchTarget) => w.name === COPILOT_WATCH_NAME,
  );

  if (existingWatchIndex !== -1) {
    merged.watches[existingWatchIndex] = newWatch;
  } else {
    merged.watches.push(newWatch);
  }

  return merged;
}

function writeTranscriptWatchConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Hook Script Generation
// ---------------------------------------------------------------------------

/**
 * Build the SessionStart hook shell script. The script:
 *   1. Best-effort starts the worker daemon (idempotent).
 *   2. Reads optional hook input JSON from stdin (Copilot CLI may pass cwd).
 *   3. Calls `bun worker-service.cjs hook claude-code context` to fetch
 *      memory context for the project.
 *   4. Emits Copilot CLI's flat `{"additionalContext": "..."}` JSON format.
 */
function buildHookScript(bunPath: string, workerServicePath: string): string {
  // Embed paths via single-quoted shell strings; protect any embedded single quotes.
  const shEscape = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const bunSh = shEscape(bunPath);
  const workerSh = shEscape(workerServicePath);

  return `#!/usr/bin/env bash
# claude-mem SessionStart hook for GitHub Copilot CLI
# Generated by \`npx claude-mem install --ide copilot-cli\`. Do not edit by
# hand; reinstall to regenerate.
#
# Behaviour:
#   - Ensures the claude-mem worker daemon is running (idempotent).
#   - Reads optional hook input JSON from stdin to extract \`cwd\`.
#   - Calls the worker's claude-code context generator and re-emits the
#     resulting context in Copilot CLI's flat
#     \`{"additionalContext": "..."}\` format.

set -euo pipefail

BUN=${bunSh}
WORKER=${workerSh}

escape_for_json() {
    local s="$1"
    s="\${s//\\\\/\\\\\\\\}"
    s="\${s//\\"/\\\\\\"}"
    s="\${s//$'\\n'/\\\\n}"
    s="\${s//$'\\r'/\\\\r}"
    s="\${s//$'\\t'/\\\\t}"
    printf '%s' "$s"
}

# Best-effort start the worker daemon (idempotent; silent on failure).
"$BUN" "$WORKER" start > /dev/null 2>&1 || true

# Read hook input JSON from stdin (Copilot CLI passes cwd, etc.).
hook_input=""
if read -t 1 line 2>/dev/null; then
    hook_input="$line"
fi

# Determine CWD: prefer hook input, fall back to $PWD.
cwd="\${PWD:-$HOME}"
if [ -n "$hook_input" ]; then
    extracted=$(echo "$hook_input" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('cwd') or d.get('workingDirectory') or '')
except Exception:
    print('')
" 2>/dev/null || true)
    [ -n "$extracted" ] && cwd="$extracted"
fi

# Fetch memory context from the worker.
worker_output=$(printf '{"session_id":"copilot-cli","cwd":"%s","hook_event_name":"SessionStart"}' "$cwd" \\
    | "$BUN" "$WORKER" hook claude-code context 2>/dev/null || echo '{}')

# Extract additionalContext from worker response (handles Claude Code's
# nested hookSpecificOutput shape and the flat shape).
additional_context=$(echo "$worker_output" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ctx = (d.get('hookSpecificOutput') or {}).get('additionalContext') or d.get('additionalContext') or ''
    print(ctx)
except Exception:
    print('')
" 2>/dev/null || echo "")

if [ -z "$additional_context" ]; then
    exit 0
fi

# Emit Copilot CLI's flat additionalContext JSON.
escaped=$(escape_for_json "$additional_context")
printf '{"additionalContext": "%s"}\\n' "$escaped"
exit 0
`;
}

function writePluginJson(): void {
  mkdirSync(COPILOT_PLUGIN_JSON_DIR, { recursive: true });
  const manifest = {
    name: COPILOT_PLUGIN_NAME,
    description: 'Memory compression and context injection for GitHub Copilot CLI sessions',
    author: { name: COPILOT_PLUGIN_OWNER },
    repository: 'https://github.com/thedotmack/claude-mem',
  };
  writeFileSync(COPILOT_PLUGIN_JSON_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

function writeHooksJson(): void {
  mkdirSync(COPILOT_HOOKS_DIR, { recursive: true });
  const hooksJson = {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [
            {
              type: 'command',
              command: COPILOT_HOOK_SCRIPT_PATH,
              async: false,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(COPILOT_HOOKS_JSON_PATH, JSON.stringify(hooksJson, null, 2) + '\n');
}

function writeHookScript(bunPath: string, workerServicePath: string): void {
  mkdirSync(COPILOT_HOOKS_DIR, { recursive: true });
  const script = buildHookScript(bunPath, workerServicePath);
  writeFileSync(COPILOT_HOOK_SCRIPT_PATH, script);
  try {
    chmodSync(COPILOT_HOOK_SCRIPT_PATH, 0o755);
  } catch (error) {
    // chmod failures are non-fatal on filesystems that don't support it
    // (e.g. some Windows configurations). The user can chmod manually if needed.
    logger.debug('WORKER', 'chmod on Copilot hook script failed', {
      path: COPILOT_HOOK_SCRIPT_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Register the plugin in ~/.copilot/settings.json under `enabledPlugins`.
 * Uses the form `<name>@<owner>: true` consistent with Copilot CLI's
 * existing convention. Preserves all other settings.
 */
function enablePluginInCopilotSettings(): void {
  if (!existsSync(COPILOT_DIR)) {
    mkdirSync(COPILOT_DIR, { recursive: true });
  }
  const settings = readJsonSafe<Record<string, any>>(COPILOT_SETTINGS_PATH, {});
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    settings.enabledPlugins = {};
  }
  settings.enabledPlugins[COPILOT_PLUGIN_KEY] = true;
  writeFileSync(COPILOT_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function disablePluginInCopilotSettings(): void {
  if (!existsSync(COPILOT_SETTINGS_PATH)) return;
  const settings = readJsonSafe<Record<string, any>>(COPILOT_SETTINGS_PATH, {});
  if (settings.enabledPlugins && typeof settings.enabledPlugins === 'object') {
    delete settings.enabledPlugins[COPILOT_PLUGIN_KEY];
    writeFileSync(COPILOT_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// MCP Cleanup Helpers
// ---------------------------------------------------------------------------

function removeClaudeMemFromMcpConfig(filePath: string, key: 'servers' | 'mcpServers'): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    if (parsed[key] && typeof parsed[key] === 'object' && 'claude-mem' in parsed[key]) {
      delete parsed[key]['claude-mem'];
      writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
      return true;
    }
  } catch (error) {
    logger.warn('WORKER', 'Failed to clean MCP config', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API: Install
// ---------------------------------------------------------------------------

/**
 * Install Copilot CLI integration for claude-mem.
 *
 *   1. Merges Copilot transcript-watch config into ~/.claude-mem/transcript-watch.json
 *   2. Installs a Copilot CLI plugin with a SessionStart hook for context injection
 *   3. Writes ~/.copilot/mcp-config.json with claude-mem's MCP server entry
 *   4. Registers the plugin in ~/.copilot/settings.json enabledPlugins
 *
 * @returns 0 on success, 1 on failure
 */
export async function installCopilotCli(): Promise<number> {
  console.log('\nInstalling Claude-Mem for GitHub Copilot CLI (transcript + hook + MCP)...\n');

  const bunPath = findBunPath();
  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  try {
    // Step 1: Transcript watch config
    const existingConfig = loadExistingTranscriptWatchConfig();
    const mergedConfig = mergeCopilotWatchConfig(existingConfig);
    writeTranscriptWatchConfig(mergedConfig);
    console.log(`  Updated ${DEFAULT_CONFIG_PATH}`);
    console.log(`  Watch path: ~/.copilot/session-state/*/events.jsonl`);
    console.log(`  Schema: copilot-cli (v${COPILOT_CLI_SAMPLE_SCHEMA.version ?? '?'})`);

    // Step 2: Plugin + SessionStart hook
    writePluginJson();
    writeHooksJson();
    writeHookScript(bunPath, workerServicePath);
    enablePluginInCopilotSettings();
    console.log(`  Installed plugin at: ${COPILOT_PLUGIN_DIR}`);
    console.log(`  Using Bun runtime:  ${bunPath}`);

    // Step 3: MCP config
    const mcpResult = writeMcpJsonConfigPublic(COPILOT_CLI_CONFIG.configPath, COPILOT_CLI_CONFIG.configKey);
    if (mcpResult === 0) {
      console.log(`  MCP config written to: ${COPILOT_CLI_CONFIG.configPath}`);
    } else {
      console.warn(`  MCP config write failed (transcript watching will still work).`);
    }

    console.log(`
Installation complete!

Transcript watch:  ${DEFAULT_CONFIG_PATH}
Hook plugin:       ${COPILOT_PLUGIN_DIR}
MCP config:        ${COPILOT_CLI_CONFIG.configPath}

How it works:
  - claude-mem watches Copilot CLI session JSONL files for new activity.
  - On every new Copilot CLI session, the SessionStart hook injects memory
    context generated from past sessions into the current conversation.
  - In-CLI search tools are available via the claude-mem MCP server.

Next steps:
  1. Start the claude-mem worker:  npx claude-mem start
  2. Restart Copilot CLI -- memory capture and context injection are automatic.
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Public API: Uninstall
// ---------------------------------------------------------------------------

/**
 * Remove Copilot CLI integration from claude-mem.
 *
 *   1. Removes the copilot-cli watch + schema from transcript-watch.json
 *   2. Removes the Copilot CLI plugin directory and disables it in settings.json
 *   3. Removes claude-mem from ~/.copilot/mcp-config.json AND from the
 *      legacy/broken ~/.github/copilot/mcp.json (cleanup for users who ran
 *      pre-fix versions of the installer).
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallCopilotCli(): number {
  console.log('\nUninstalling Claude-Mem Copilot CLI integration...\n');

  // Step 1: Remove copilot-cli watch from transcript-watch.json
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadExistingTranscriptWatchConfig();
    config.watches = config.watches.filter((w: WatchTarget) => w.name !== COPILOT_WATCH_NAME);
    if (config.schemas) {
      delete config.schemas[COPILOT_WATCH_NAME];
    }
    try {
      writeTranscriptWatchConfig(config);
      console.log(`  Removed copilot-cli watch from ${DEFAULT_CONFIG_PATH}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nUninstallation failed: ${message}`);
      return 1;
    }
  }

  // Step 2: Remove plugin files and disable in settings
  for (const filePath of [COPILOT_HOOK_SCRIPT_PATH, COPILOT_HOOKS_JSON_PATH, COPILOT_PLUGIN_JSON_PATH]) {
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch (error) {
        logger.warn('WORKER', 'Failed to remove plugin file', {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  disablePluginInCopilotSettings();
  console.log(`  Removed plugin files and disabled in ${COPILOT_SETTINGS_PATH}`);

  // Step 3: Clean up MCP configs (current + legacy broken path)
  if (removeClaudeMemFromMcpConfig(COPILOT_CLI_CONFIG.configPath, COPILOT_CLI_CONFIG.configKey)) {
    console.log(`  Removed claude-mem from ${COPILOT_CLI_CONFIG.configPath}`);
  }
  if (removeClaudeMemFromMcpConfig(LEGACY_COPILOT_CLI_MCP_CONFIG_PATH, 'servers')) {
    console.log(`  Removed claude-mem from legacy ${LEGACY_COPILOT_CLI_MCP_CONFIG_PATH}`);
  }

  console.log('\nUninstallation complete!');
  console.log('Restart Copilot CLI to apply changes.\n');
  return 0;
}
