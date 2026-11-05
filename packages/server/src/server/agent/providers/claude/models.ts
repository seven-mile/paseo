import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  buildClaudeEffortThinkingOptions,
  CLAUDE_DEFAULT_THINKING_OPTION_ID,
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  harnessModels: readonly ModelInfo[] = [],
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeModels(claudeCodeVersion);
  const settingsModels = (await readClaudeSettingsModels(logger, configDir)).map((model) =>
    withAliasEffort(model, harnessModels),
  );
  const models = [...hardcodedModels];

  for (const model of [...buildClaudeHarnessModels(harnessModels), ...settingsModels]) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    models.push(model);
  }

  return models;
}

/**
 * Concrete models from Claude Code's own model list (`supportedModels()`, what `/model` shows).
 * Alias rows such as `default` or `opus` resolve to another model and are skipped.
 */
function buildClaudeHarnessModels(harnessModels: readonly ModelInfo[]): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  for (const info of harnessModels) {
    const id = info.value.trim();
    if (!id || isClaudeAliasRow(info)) continue;
    const model: AgentModelDefinition = {
      provider: "claude",
      id,
      label: info.displayName || id,
      description: info.description,
    };
    const thinkingOptions = info.supportedEffortLevels?.length
      ? buildClaudeEffortThinkingOptions(info.supportedEffortLevels)
      : undefined;
    if (thinkingOptions) {
      model.thinkingOptions = thinkingOptions;
      model.defaultThinkingOptionId = CLAUDE_DEFAULT_THINKING_OPTION_ID;
    }
    models.push(model);
  }
  return models;
}

/** An alias row (`opus`) resolves to another model; a `[1m]` row resolves to its own base id. */
function isClaudeAliasRow(info: ModelInfo): boolean {
  if (info.resolvedModel === undefined) return false;
  return info.resolvedModel !== stripContextSuffix(info.value);
}

/**
 * Claude Code drops a model from its concrete rows once an alias such as `opus` points at it, and
 * keeps that model's effort levels only on the alias row. Give them back to the settings model the
 * alias resolves to, so it stays tunable whichever way the aliases are wired.
 */
function withAliasEffort(
  model: AgentModelDefinition,
  harnessModels: readonly ModelInfo[],
): AgentModelDefinition {
  const target = stripContextSuffix(model.id);
  const alias = harnessModels.find(
    (info) => isClaudeAliasRow(info) && info.resolvedModel === target,
  );
  const thinkingOptions = alias?.supportedEffortLevels?.length
    ? buildClaudeEffortThinkingOptions(alias.supportedEffortLevels)
    : undefined;
  if (!thinkingOptions) return model;
  return { ...model, thinkingOptions, defaultThinkingOptionId: CLAUDE_DEFAULT_THINKING_OPTION_ID };
}

function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "");
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir: string,
): Promise<AgentModelDefinition[]> {
  const settingsPath = path.join(configDir, "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return [];
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return [];
  }

  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
