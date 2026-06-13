import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type RoleName = "skeptic" | "builder" | "judge";
type Confidence = "low" | "medium" | "high";
type DebateStatus = "consensus" | "max-rounds" | "stalled" | "needs-user-input";
type DecisionArea = "architecture" | "technical" | "design" | "product" | "rollout" | "other";

interface DebateTimeoutConfig {
  skepticMs: number;
  builderMs: number;
  judgeMs: number;
  roundMs: number;
  terminateGraceMs: number;
}

interface DebateChildToolConfig {
  enableWebSearch: boolean;
  webSearchToolNames: string[];
  webSearchRoles: RoleName[];
}

interface DebateConfig {
  maxRounds: number;
  writeRoundFiles: boolean;
  models: Partial<Record<RoleName, string>>;
  timeouts: DebateTimeoutConfig;
  childTools: DebateChildToolConfig;
}

interface DebateOverrides {
  rounds?: number;
  outputDir?: string;
  models?: Partial<Record<RoleName, string>>;
  availableToolNames?: string[];
  signal?: AbortSignal;
}

interface DebateRoleExecutionConfig {
  timeoutMs: number;
  terminateGraceMs: number;
  webSearchToolName?: string;
  approveProject: boolean;
  signal?: AbortSignal;
}

interface UserDecisionQuestion {
  area: DecisionArea;
  question: string;
  whyItMatters: string;
}

interface UserDecisionAnswer extends UserDecisionQuestion {
  answer: string;
}

interface UserDecisionState {
  reason: string;
  answered: boolean;
  responses: UserDecisionAnswer[];
  pendingQuestions: UserDecisionQuestion[];
}

interface JudgeDecision {
  consensus: boolean;
  summary: string;
  mustFix: string[];
  niceToHave: string[];
  confidence: Confidence;
  needsUserInput: boolean;
  userInputReason: string;
  questions: UserDecisionQuestion[];
}

interface DebateRound {
  round: number;
  skeptic: string;
  revisedSpec: string;
  judge: JudgeDecision;
  userDecision?: UserDecisionState;
}

interface DebateRunResult {
  sourcePath: string;
  outputDir: string;
  finalSpecPath: string;
  consensusPath: string;
  debatePath: string;
  rounds: DebateRound[];
  models: Record<RoleName, string | undefined>;
  status: DebateStatus;
}

const DEFAULT_CONFIG: DebateConfig = {
  maxRounds: 3,
  writeRoundFiles: true,
  models: {},
  timeouts: {
    skepticMs: 90_000,
    builderMs: 150_000,
    judgeMs: 60_000,
    roundMs: 300_000,
    terminateGraceMs: 3_000,
  },
  childTools: {
    enableWebSearch: true,
    webSearchToolNames: ["web_search"],
    webSearchRoles: ["skeptic", "judge"],
  },
};

const TOOL_SCHEMA = Type.Object({
  path: Type.String({ description: "Path to the markdown spec or feasibility document" }),
  rounds: Type.Optional(Type.Number({ description: "Maximum number of debate rounds", default: 3 })),
  outputDir: Type.Optional(Type.String({ description: "Directory to write outputs into" })),
  skepticModel: Type.Optional(Type.String({ description: "Model for the skeptic agent" })),
  builderModel: Type.Optional(Type.String({ description: "Model for the builder agent" })),
  judgeModel: Type.Optional(Type.String({ description: "Model for the judge agent" })),
});

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("spec-debate", (message, options, theme) => {
    let text = theme.fg("accent", theme.bold("spec-debate"));
    text += "\n" + message.content;

    if (options.expanded && message.details) {
      const details = message.details as Partial<DebateRunResult>;
      const rounds = details.rounds?.length ?? 0;
      if (details.outputDir) text += `\n\nOutput: ${details.outputDir}`;
      if (details.status) text += `\nStatus: ${details.status}`;
      text += `\nRounds: ${rounds}`;
    }

    return new Text(text, 0, 0);
  });

  pi.registerCommand("spec-debate", {
    description: "Run a skeptic/builder/judge loop over a markdown spec until consensus, user direction, or max rounds",
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args || "");
      if (!parsed.path) {
        ctx.ui.notify(
          "Usage: /spec-debate <file> [--rounds N] [--output-dir DIR] [--skeptic-model MODEL] [--builder-model MODEL] [--judge-model MODEL]",
          "warning",
        );
        return;
      }

      try {
        const result = await runDebate(parsed.path, ctx, {
          rounds: parsed.rounds,
          outputDir: parsed.outputDir,
          models: {
            skeptic: parsed.skepticModel,
            builder: parsed.builderModel,
            judge: parsed.judgeModel,
          },
          availableToolNames: pi.getAllTools().map((tool) => tool.name),
          signal: ctx.signal,
        });

        pi.sendMessage({
          customType: "spec-debate",
          content: buildSummary(result),
          display: true,
          details: result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        pi.sendMessage({
          customType: "spec-debate",
          content: `Failed: ${message}`,
          display: true,
          details: { error: message },
        });
      }
    },
  });

  pi.registerTool({
    name: "spec_debate",
    label: "Spec Debate",
    description: "Run a multi-model skeptic/builder/judge review loop on a markdown specification or feasibility document, asking for user direction when needed.",
    promptSnippet: "Run a skeptic/builder/judge multi-model debate over a markdown spec and write outputs to disk.",
    promptGuidelines: [
      "Use spec_debate when the user wants multiple models to challenge and revise a markdown spec until consensus.",
      "Use spec_debate for idea docs, RFCs, feasibility notes, and planning documents rather than ad-hoc single-pass reviews.",
      "spec_debate may ask the user for direction when the debate reaches an architectural, technical, design, product, or rollout choice that should not be invented.",
    ],
    parameters: TOOL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runDebate(params.path, ctx, {
        rounds: params.rounds,
        outputDir: params.outputDir,
        models: {
          skeptic: params.skepticModel,
          builder: params.builderModel,
          judge: params.judgeModel,
        },
        availableToolNames: pi.getAllTools().map((tool) => tool.name),
        signal,
      });

      return {
        content: [{ type: "text", text: buildSummary(result) }],
        details: {
          sourcePath: result.sourcePath,
          outputDir: result.outputDir,
          finalSpecPath: result.finalSpecPath,
          consensusPath: result.consensusPath,
          debatePath: result.debatePath,
          status: result.status,
          rounds: result.rounds.map((round) => ({
            round: round.round,
            consensus: round.judge.consensus,
            confidence: round.judge.confidence,
            summary: round.judge.summary,
            mustFixCount: round.judge.mustFix.length,
            needsUserInput: round.judge.needsUserInput,
            userQuestionCount: round.judge.questions.length,
          })),
          models: result.models,
        },
      };
    },
  });
}

async function runDebate(specPathArg: string, ctx: ExtensionCommandContext | ExtensionContext, overrides: DebateOverrides): Promise<DebateRunResult> {
  const specPath = resolvePath(ctx.cwd, specPathArg);
  const sourceText = await readFile(specPath, "utf8");
  const config = await loadConfig(ctx);
  const models = resolveModels(ctx, config, overrides);
  const maxRounds = overrides.rounds ?? config.maxRounds;

  if (!Number.isFinite(maxRounds) || maxRounds < 1) {
    throw new Error(`Invalid rounds value: ${maxRounds}`);
  }

  validateTimeoutConfig(config.timeouts);

  const roleExecution = resolveRoleExecutionConfig(ctx, config, overrides);
  const outputDir = overrides.outputDir
    ? resolvePath(ctx.cwd, overrides.outputDir)
    : defaultOutputDirFor(specPath);

  await mkdir(outputDir, { recursive: true });

  let currentSpec = sourceText.trimEnd() + "\n";
  const rounds: DebateRound[] = [];
  let status: DebateStatus = "max-rounds";

  setStatus(ctx, `starting ${path.basename(specPath)}`);

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const roundControl = createTimeoutAbortControl(config.timeouts.roundMs, `debate round ${round}`);
      const roundSignal = combineAbortSignals([overrides.signal, roundControl.signal]);

      try {
        setStatus(ctx, `round ${round}/${maxRounds}: skeptic`);
        const skeptic = await runRole({
          cwd: path.dirname(specPath),
          model: models.skeptic,
          systemPrompt: skepticSystemPrompt(),
          prompt: buildSkepticPrompt(currentSpec, rounds, round, maxRounds),
          label: `skeptic round ${round}`,
          ...roleExecution.skeptic,
          signal: roundSignal,
        });

        setStatus(ctx, `round ${round}/${maxRounds}: builder`);
        let revisedSpec = stripWrappingCodeFence(
          await runRole({
            cwd: path.dirname(specPath),
            model: models.builder,
            systemPrompt: builderSystemPrompt(),
            prompt: buildBuilderPrompt(currentSpec, skeptic, rounds, round, maxRounds),
            label: `builder round ${round}`,
            ...roleExecution.builder,
            signal: roundSignal,
          }),
        ).trimEnd() + "\n";

        setStatus(ctx, `round ${round}/${maxRounds}: judge`);
        let judge = parseJudgeDecision(
          await runRole({
            cwd: path.dirname(specPath),
            model: models.judge,
            systemPrompt: judgeSystemPrompt(),
            prompt: buildJudgePrompt(currentSpec, skeptic, revisedSpec, rounds, round, maxRounds),
            label: `judge round ${round}`,
            ...roleExecution.judge,
            signal: roundSignal,
          }),
        );

        let userDecision: UserDecisionState | undefined;

        if (judge.needsUserInput) {
          const questions = judge.questions.length > 0 ? judge.questions : fallbackUserDecisionQuestions(judge);
          judge = { ...judge, questions };

          if (ctx.hasUI) {
            setStatus(ctx, `round ${round}/${maxRounds}: awaiting user direction`);
            const responses = await collectUserDecisionResponses(ctx, specPath, round, maxRounds, judge);

            if (responses.length > 0) {
              userDecision = {
                reason: judge.userInputReason || judge.summary || "User direction was required.",
                answered: true,
                responses,
                pendingQuestions: [],
              };

              setStatus(ctx, `round ${round}/${maxRounds}: integrating user direction`);
              revisedSpec = stripWrappingCodeFence(
                await runRole({
                  cwd: path.dirname(specPath),
                  model: models.builder,
                  systemPrompt: builderSystemPrompt(),
                  prompt: buildUserDecisionIntegrationPrompt(currentSpec, skeptic, revisedSpec, judge, responses, rounds, round, maxRounds),
                  label: `builder user-direction round ${round}`,
                  ...roleExecution.builder,
                  signal: roundSignal,
                }),
              ).trimEnd() + "\n";

              setStatus(ctx, `round ${round}/${maxRounds}: re-judge after user direction`);
              judge = parseJudgeDecision(
                await runRole({
                  cwd: path.dirname(specPath),
                  model: models.judge,
                  systemPrompt: judgeSystemPrompt(),
                  prompt: buildJudgePrompt(currentSpec, skeptic, revisedSpec, rounds, round, maxRounds),
                  label: `judge after user direction round ${round}`,
                  ...roleExecution.judge,
                  signal: roundSignal,
                }),
              );

              if (judge.needsUserInput && judge.questions.length === 0) {
                judge = { ...judge, questions: fallbackUserDecisionQuestions(judge) };
              }

              if (judge.needsUserInput && userDecision) {
                userDecision.reason = judge.userInputReason || userDecision.reason;
                userDecision.pendingQuestions = judge.questions;
              }
            } else {
              userDecision = {
                reason: judge.userInputReason || judge.summary || "User direction was required.",
                answered: false,
                responses: [],
                pendingQuestions: questions,
              };
            }
          } else {
            userDecision = {
              reason: judge.userInputReason || judge.summary || "User direction was required.",
              answered: false,
              responses: [],
              pendingQuestions: questions,
            };
          }
        }

        const result: DebateRound = { round, skeptic: skeptic.trim(), revisedSpec, judge, userDecision };
        rounds.push(result);

        if (config.writeRoundFiles) {
          await writeRoundFiles(outputDir, result);
        }

        const previousSpec = currentSpec;
        currentSpec = revisedSpec;

        if (judge.consensus) {
          status = "consensus";
          break;
        }

        if (judge.needsUserInput || userDecision?.answered === false) {
          status = "needs-user-input";
          break;
        }

        if (normalizeForComparison(previousSpec) === normalizeForComparison(currentSpec)) {
          status = "stalled";
          break;
        }
      } finally {
        roundControl.dispose();
      }
    }

    const finalSpecPath = path.join(outputDir, "final.md");
    const consensusPath = path.join(outputDir, "consensus.md");
    const debatePath = path.join(outputDir, "debate.md");

    await writeFile(finalSpecPath, currentSpec, "utf8");
    await writeFile(consensusPath, buildConsensusReport(specPath, rounds, status, models), "utf8");
    await writeFile(debatePath, buildDebateLog(specPath, sourceText, rounds, status, models), "utf8");

    return {
      sourcePath: specPath,
      outputDir,
      finalSpecPath,
      consensusPath,
      debatePath,
      rounds,
      models,
      status,
    };
  } finally {
    setStatus(ctx, undefined);
  }
}

function setStatus(ctx: ExtensionCommandContext | ExtensionContext, text: string | undefined) {
  if (ctx.hasUI) ctx.ui.setStatus("spec-debate", text);
}

function resolveModels(
  ctx: ExtensionCommandContext | ExtensionContext,
  config: DebateConfig,
  overrides: DebateOverrides,
): Record<RoleName, string | undefined> {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  return {
    skeptic: overrides.models?.skeptic ?? config.models.skeptic ?? current,
    builder: overrides.models?.builder ?? config.models.builder ?? current,
    judge: overrides.models?.judge ?? config.models.judge ?? current,
  };
}

async function loadConfig(ctx: ExtensionCommandContext | ExtensionContext): Promise<DebateConfig> {
  let config = mergeConfig(DEFAULT_CONFIG, undefined);
  config = mergeConfig(config, await readConfigFile(path.join(getAgentDir(), "spec-debate.json")));

  if (ctx.isProjectTrusted()) {
    config = mergeConfig(config, await readConfigFile(path.join(ctx.cwd, ".pi", "spec-debate.json")));
  }

  return mergeConfig(config, envConfig());
}

function envConfig(): Partial<DebateConfig> {
  const models: Partial<Record<RoleName, string>> = {};
  if (process.env.PI_SPEC_DEBATE_SKEPTIC_MODEL) models.skeptic = process.env.PI_SPEC_DEBATE_SKEPTIC_MODEL;
  if (process.env.PI_SPEC_DEBATE_BUILDER_MODEL) models.builder = process.env.PI_SPEC_DEBATE_BUILDER_MODEL;
  if (process.env.PI_SPEC_DEBATE_JUDGE_MODEL) models.judge = process.env.PI_SPEC_DEBATE_JUDGE_MODEL;

  const timeouts = filterDefined({
    skepticMs: parseOptionalInt(process.env.PI_SPEC_DEBATE_SKEPTIC_TIMEOUT_MS),
    builderMs: parseOptionalInt(process.env.PI_SPEC_DEBATE_BUILDER_TIMEOUT_MS),
    judgeMs: parseOptionalInt(process.env.PI_SPEC_DEBATE_JUDGE_TIMEOUT_MS),
    roundMs: parseOptionalInt(process.env.PI_SPEC_DEBATE_ROUND_TIMEOUT_MS),
    terminateGraceMs: parseOptionalInt(process.env.PI_SPEC_DEBATE_TERMINATE_GRACE_MS),
  });

  return {
    maxRounds: parseOptionalInt(process.env.PI_SPEC_DEBATE_MAX_ROUNDS),
    models,
    timeouts: Object.keys(timeouts).length > 0 ? timeouts : undefined,
    childTools: {
      enableWebSearch: parseOptionalBoolean(process.env.PI_SPEC_DEBATE_ENABLE_WEB_SEARCH),
      webSearchToolNames: parseOptionalList(process.env.PI_SPEC_DEBATE_WEB_SEARCH_TOOLS),
      webSearchRoles: parseOptionalRoleList(process.env.PI_SPEC_DEBATE_WEB_SEARCH_ROLES),
    } as Partial<DebateChildToolConfig>,
  };
}

async function readConfigFile(filePath: string): Promise<Partial<DebateConfig> | undefined> {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<DebateConfig>;
  return parsed;
}

function mergeConfig(base: DebateConfig, override: Partial<DebateConfig> | undefined): DebateConfig {
  if (!override) {
    return {
      ...base,
      models: { ...base.models },
      timeouts: { ...base.timeouts },
      childTools: {
        ...base.childTools,
        webSearchToolNames: [...base.childTools.webSearchToolNames],
        webSearchRoles: [...base.childTools.webSearchRoles],
      },
    };
  }

  return {
    maxRounds: override.maxRounds ?? base.maxRounds,
    writeRoundFiles: override.writeRoundFiles ?? base.writeRoundFiles,
    models: {
      ...base.models,
      ...(override.models ?? {}),
    },
    timeouts: {
      ...base.timeouts,
      ...filterDefined(override.timeouts ?? {}),
    },
    childTools: {
      enableWebSearch: override.childTools?.enableWebSearch ?? base.childTools.enableWebSearch,
      webSearchToolNames:
        override.childTools?.webSearchToolNames && override.childTools.webSearchToolNames.length > 0
          ? [...override.childTools.webSearchToolNames]
          : [...base.childTools.webSearchToolNames],
      webSearchRoles:
        override.childTools?.webSearchRoles && override.childTools.webSearchRoles.length > 0
          ? [...override.childTools.webSearchRoles]
          : [...base.childTools.webSearchRoles],
    },
  };
}

function filterDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined),
  ) as Partial<T>;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseOptionalRoleList(value: string | undefined): RoleName[] | undefined {
  const items = parseOptionalList(value);
  if (!items) return undefined;

  const roles = items.filter(isRoleName);
  return roles.length > 0 ? roles : undefined;
}

function isRoleName(value: string): value is RoleName {
  return value === "skeptic" || value === "builder" || value === "judge";
}

function validateTimeoutConfig(timeouts: DebateTimeoutConfig) {
  const entries = Object.entries(timeouts) as Array<[keyof DebateTimeoutConfig, number]>;
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`Invalid timeout value for ${name}: ${value}`);
    }
  }
}

function resolveRoleExecutionConfig(
  ctx: ExtensionCommandContext | ExtensionContext,
  config: DebateConfig,
  overrides: DebateOverrides,
): Record<RoleName, Omit<DebateRoleExecutionConfig, "signal">> {
  const availableTools = new Set(overrides.availableToolNames ?? []);
  const webSearchToolName = config.childTools.enableWebSearch
    ? config.childTools.webSearchToolNames.find((name) => availableTools.has(name))
    : undefined;
  const approveProject = Boolean(webSearchToolName && ctx.isProjectTrusted());

  const forRole = (role: RoleName, timeoutMs: number): Omit<DebateRoleExecutionConfig, "signal"> => ({
    timeoutMs,
    terminateGraceMs: config.timeouts.terminateGraceMs,
    webSearchToolName:
      webSearchToolName && config.childTools.webSearchRoles.includes(role)
        ? webSearchToolName
        : undefined,
    approveProject,
  });

  return {
    skeptic: forRole("skeptic", config.timeouts.skepticMs),
    builder: forRole("builder", config.timeouts.builderMs),
    judge: forRole("judge", config.timeouts.judgeMs),
  };
}

function createTimeoutAbortControl(timeoutMs: number, label: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${formatDuration(timeoutMs)}`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason ?? new Error("Operation cancelled"));
    cleanup();
  };
  const cleanup = () => {
    for (const signal of active) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? new Error("Operation cancelled"));
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function formatDuration(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function abortMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function runRole(input: {
  cwd: string;
  model: string | undefined;
  systemPrompt: string;
  prompt: string;
  label: string;
  timeoutMs: number;
  terminateGraceMs: number;
  webSearchToolName?: string;
  approveProject: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-spec-debate-"));
  const promptPath = path.join(tempDir, "prompt.md");
  await writeFile(promptPath, input.prompt, "utf8");

  const args = ["-p", "--no-session"];

  if (input.webSearchToolName) {
    args.push(
      "--no-builtin-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--exclude-tools",
      "spec_debate",
      "--tools",
      input.webSearchToolName,
    );
    if (input.approveProject) args.push("--approve");
  } else {
    args.push("--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files");
  }

  args.push("--system-prompt", input.systemPrompt);

  if (input.model) args.push("--model", input.model);
  args.push(`@${promptPath}`);

  const timeoutControl = createTimeoutAbortControl(input.timeoutMs, input.label);
  const signal = combineAbortSignals([input.signal, timeoutControl.signal]);

  try {
    const output = await runPi(args, input.cwd, {
      signal,
      terminateGraceMs: input.terminateGraceMs,
      label: input.label,
    });
    if (!output.trim()) {
      throw new Error(`Empty response from ${input.label}`);
    }
    return output.trim();
  } finally {
    timeoutControl.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runPi(args: string[], cwd: string, options: { signal?: AbortSignal; terminateGraceMs: number; label: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let forcedKillTimer: NodeJS.Timeout | undefined;

    const settle = (handler: () => void, preserveKillTimer = false) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (forcedKillTimer && !preserveKillTimer) clearTimeout(forcedKillTimer);
      handler();
    };

    const isRunning = () => proc.exitCode === null && proc.signalCode === null;

    const onAbort = () => {
      const message = abortMessage(options.signal?.reason, `${options.label} cancelled`);

      if (isRunning()) {
        proc.kill("SIGTERM");
        forcedKillTimer = setTimeout(() => {
          if (isRunning()) proc.kill("SIGKILL");
        }, options.terminateGraceMs);
      }

      settle(() => {
        reject(new Error(message));
      }, true);
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      if (settled) return;
      settle(() => {
        reject(new Error(`Failed to start pi subprocess: ${error.message}`));
      });
    });

    proc.on("close", (code) => {
      if (settled) {
        if (forcedKillTimer) clearTimeout(forcedKillTimer);
        return;
      }

      settle(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
        reject(new Error(`pi subprocess failed (${code}). ${detail || "No output."}`));
      });
    });
  });
}

function parseJudgeDecision(raw: string): JudgeDecision {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as Partial<JudgeDecision> & {
    questions?: Array<Partial<UserDecisionQuestion>>;
  };

  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .map((question) => {
          const text = typeof question.question === "string" ? question.question.trim() : "";
          if (!text) return undefined;
          return {
            area: normalizeDecisionArea(question.area),
            question: text,
            whyItMatters: typeof question.whyItMatters === "string" ? question.whyItMatters.trim() : "",
          } as UserDecisionQuestion;
        })
        .filter((question): question is UserDecisionQuestion => Boolean(question))
    : [];

  return {
    consensus: Boolean(parsed.consensus),
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    mustFix: Array.isArray(parsed.mustFix) ? parsed.mustFix.map(String) : [],
    niceToHave: Array.isArray(parsed.niceToHave) ? parsed.niceToHave.map(String) : [],
    confidence:
      parsed.confidence === "low" || parsed.confidence === "medium" || parsed.confidence === "high"
        ? parsed.confidence
        : "medium",
    needsUserInput: Boolean(parsed.needsUserInput),
    userInputReason: typeof parsed.userInputReason === "string" ? parsed.userInputReason : "",
    questions,
  };
}

function normalizeDecisionArea(value: unknown): DecisionArea {
  switch (String(value || "").trim().toLowerCase()) {
    case "architecture":
      return "architecture";
    case "technical":
      return "technical";
    case "design":
      return "design";
    case "product":
      return "product";
    case "rollout":
      return "rollout";
    default:
      return "other";
  }
}

function fallbackUserDecisionQuestions(judge: JudgeDecision): UserDecisionQuestion[] {
  if (judge.questions.length > 0) return judge.questions;
  return [
    {
      area: "other",
      question: "What direction should this spec take to resolve the outstanding decision?",
      whyItMatters: judge.userInputReason || judge.summary || "The debate could not responsibly choose a direction on its own.",
    },
  ];
}

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1).trim();

  throw new Error(`Could not find JSON in judge output:\n${text}`);
}

function stripWrappingCodeFence(text: string): string {
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced?.[1] ?? text;
}

function skepticSystemPrompt(): string {
  return [
    "You are the skeptic in a spec review loop.",
    "Be critical but constructive.",
    "Find hidden assumptions, feasibility gaps, unclear scope, rollout risks, missing decisions, and contradictions.",
    "Return markdown with the exact headings: ## Blocking Issues, ## Major Risks, ## Ambiguities, ## Questions, ## Suggested Revisions.",
  ].join(" ");
}

function builderSystemPrompt(): string {
  return [
    "You are the builder in a spec review loop.",
    "Rewrite the spec to address the critique while preserving the intent.",
    "When the user provides direction on a decision, treat it as authoritative and reflect it explicitly in the document.",
    "Do not silently invent architectural, technical, design, product, or rollout decisions that clearly need owner input.",
    "Return only the full revised markdown document.",
    "Do not add commentary, prefaces, or code fences.",
  ].join(" ");
}

function judgeSystemPrompt(): string {
  return [
    "You are the judge in a spec review loop.",
    "Decide whether the revised draft is coherent and ready enough to stop the debate.",
    'Return JSON only: {"consensus":boolean,"summary":string,"mustFix":string[],"niceToHave":string[],"confidence":"low|medium|high","needsUserInput":boolean,"userInputReason":string,"questions":[{"area":"architecture|technical|design|product|rollout|other","question":string,"whyItMatters":string}]}.',
    "Set consensus=true when remaining issues are minor and the document is specific enough to proceed.",
    "Set needsUserInput=true only when the draft cannot responsibly choose among materially different options without owner direction.",
    "Do not ask for user input for minor wording, routine implementation detail, or issues the builder could resolve directly.",
    "When needsUserInput=false, return questions as an empty array and userInputReason as an empty string.",
  ].join(" ");
}

function buildSkepticPrompt(currentSpec: string, previousRounds: DebateRound[], round: number, maxRounds: number): string {
  return [
    `Round ${round} of ${maxRounds}.`,
    "Review the following document as a feasibility/spec note.",
    "Focus on what would make implementation or approval fail.",
    previousRounds.length > 0 ? `Prior judge summaries:\n${judgeSummaryBlock(previousRounds)}` : "",
    "# Current spec",
    currentSpec,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildBuilderPrompt(
  currentSpec: string,
  skeptic: string,
  previousRounds: DebateRound[],
  round: number,
  maxRounds: number,
): string {
  return [
    `Round ${round} of ${maxRounds}.`,
    "Rewrite the spec to resolve as many issues as possible without changing the core objective.",
    "Prefer concrete scope, assumptions, risks, rollout notes, and open questions over vague prose.",
    "If a choice still requires owner direction, keep that decision explicit instead of making one up.",
    previousRounds.length > 0 ? `Prior judge summaries:\n${judgeSummaryBlock(previousRounds)}` : "",
    "# Current spec",
    currentSpec,
    "# Skeptic critique",
    skeptic,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserDecisionIntegrationPrompt(
  previousSpec: string,
  skeptic: string,
  revisedSpec: string,
  judge: JudgeDecision,
  responses: UserDecisionAnswer[],
  previousRounds: DebateRound[],
  round: number,
  maxRounds: number,
): string {
  return [
    `Round ${round} of ${maxRounds}.`,
    "Integrate the authoritative user direction below into the spec.",
    "Make the chosen direction explicit in scope, assumptions, architecture, design, rollout, or tradeoff sections where relevant.",
    "Preserve the intent of the document and resolve the decision without adding commentary outside the spec.",
    previousRounds.length > 0 ? `Prior judge summaries:\n${judgeSummaryBlock(previousRounds)}` : "",
    "# Previous spec",
    previousSpec,
    "# Skeptic critique",
    skeptic,
    "# Current revised spec",
    revisedSpec,
    "# Judge request for user direction",
    formatUserDecisionRequest(judge),
    "# User answers",
    formatUserDecisionAnswers(responses),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildJudgePrompt(
  previousSpec: string,
  skeptic: string,
  revisedSpec: string,
  previousRounds: DebateRound[],
  round: number,
  maxRounds: number,
): string {
  return [
    `Round ${round} of ${maxRounds}.`,
    "Decide if the revised draft is good enough to stop.",
    "Consensus means the document is coherent, actionable, and missing only minor refinements.",
    "If the draft now depends on a human owner choosing between materially different valid directions, set needsUserInput=true.",
    previousRounds.length > 0 ? `Prior judge summaries:\n${judgeSummaryBlock(previousRounds)}` : "",
    "# Previous spec",
    previousSpec,
    "# Skeptic critique",
    skeptic,
    "# Revised spec",
    revisedSpec,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function judgeSummaryBlock(rounds: DebateRound[]): string {
  return rounds
    .map((round) => {
      const userSuffix = round.judge.needsUserInput ? "; needsUserInput=true" : "";
      return `- Round ${round.round}: consensus=${round.judge.consensus}; confidence=${round.judge.confidence}; summary=${round.judge.summary}${userSuffix}`;
    })
    .join("\n");
}

async function collectUserDecisionResponses(
  ctx: ExtensionCommandContext | ExtensionContext,
  specPath: string,
  round: number,
  maxRounds: number,
  judge: JudgeDecision,
): Promise<UserDecisionAnswer[]> {
  if (!ctx.hasUI) return [];

  const responses: UserDecisionAnswer[] = [];
  for (const [index, question] of judge.questions.entries()) {
    const answer = await ctx.ui.editor(
      [
        `Spec debate needs direction for ${path.basename(specPath)}`,
        `Round ${round} of ${maxRounds}`,
        `Question ${index + 1} of ${judge.questions.length}`,
        "",
        `[${question.area}] ${question.question}`,
        question.whyItMatters ? `Why it matters: ${question.whyItMatters}` : "",
        "",
        "Enter your answer below.",
      ]
        .filter(Boolean)
        .join("\n"),
      "",
    );

    const trimmed = answer?.trim();
    if (!trimmed) return [];

    responses.push({
      ...question,
      answer: trimmed,
    });
  }

  return responses;
}

async function writeRoundFiles(outputDir: string, round: DebateRound) {
  const prefix = `round-${String(round.round).padStart(2, "0")}`;
  await writeFile(path.join(outputDir, `${prefix}-skeptic.md`), round.skeptic + "\n", "utf8");
  await writeFile(path.join(outputDir, `${prefix}-builder.md`), round.revisedSpec, "utf8");
  await writeFile(path.join(outputDir, `${prefix}-judge.json`), JSON.stringify(round.judge, null, 2) + "\n", "utf8");

  if (round.userDecision) {
    await writeFile(path.join(outputDir, `${prefix}-user.md`), buildUserDecisionRoundFile(round.userDecision), "utf8");
  }
}

function buildUserDecisionRoundFile(userDecision: UserDecisionState): string {
  return [
    "# User Direction",
    "",
    `- Answered: ${userDecision.answered ? "yes" : "no"}`,
    `- Reason: ${userDecision.reason || "No reason provided."}`,
    "",
    "## Questions",
    ...(userDecision.pendingQuestions.length
      ? userDecision.pendingQuestions.flatMap((question) => [
          `- [${question.area}] ${question.question}`,
          question.whyItMatters ? `  - Why it matters: ${question.whyItMatters}` : undefined,
        ])
      : ["- None"]),
    "",
    "## Answers",
    ...(userDecision.responses.length
      ? userDecision.responses.flatMap((response) => [
          `- [${response.area}] ${response.question}`,
          response.whyItMatters ? `  - Why it matters: ${response.whyItMatters}` : undefined,
          `  - Answer: ${response.answer}`,
        ])
      : ["- None"]),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n") + "\n";
}

function buildConsensusReport(
  specPath: string,
  rounds: DebateRound[],
  status: DebateStatus,
  models: Record<RoleName, string | undefined>,
): string {
  const last = rounds[rounds.length - 1];
  return [
    `# Consensus Report: ${path.basename(specPath)}`,
    "",
    `- Status: ${status}`,
    `- Rounds completed: ${rounds.length}`,
    `- Skeptic model: ${models.skeptic ?? "default"}`,
    `- Builder model: ${models.builder ?? "default"}`,
    `- Judge model: ${models.judge ?? "default"}`,
    "",
    "## Final Judge Summary",
    last?.judge.summary ?? "No summary available.",
    "",
    "## Must Fix",
    ...(last?.judge.mustFix.length ? last.judge.mustFix.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Nice To Have",
    ...(last?.judge.niceToHave.length ? last.judge.niceToHave.map((item) => `- ${item}`) : ["- None"]),
    "",
    ...buildFinalUserDirectionSection(last),
  ].join("\n");
}

function buildFinalUserDirectionSection(last: DebateRound | undefined): string[] {
  if (!last) {
    return ["## User Direction", "- None"];
  }

  const sections: string[] = [];

  if (last.userDecision?.responses.length) {
    sections.push(
      "## User Direction Applied In Final Round",
      ...last.userDecision.responses.flatMap((response) => [
        `- [${response.area}] ${response.question}`,
        `  - Answer: ${response.answer}`,
      ]),
      "",
    );
  }

  if (last.judge.needsUserInput || last.userDecision?.pendingQuestions.length) {
    const pending = last.userDecision?.pendingQuestions.length ? last.userDecision.pendingQuestions : last.judge.questions;
    sections.push(
      "## User Direction Needed",
      last.userDecision?.reason || last.judge.userInputReason || "The debate needs a human decision before it should continue.",
      "",
      ...pending.flatMap((question) => [
        `- [${question.area}] ${question.question}`,
        question.whyItMatters ? `  - Why it matters: ${question.whyItMatters}` : undefined,
      ]).filter((line): line is string => typeof line === "string"),
    );
  }

  if (sections.length === 0) {
    return ["## User Direction", "- None"];
  }

  return sections;
}

function buildDebateLog(
  specPath: string,
  sourceText: string,
  rounds: DebateRound[],
  status: DebateStatus,
  models: Record<RoleName, string | undefined>,
): string {
  const lines: string[] = [
    `# Debate Log: ${path.basename(specPath)}`,
    "",
    `- Status: ${status}`,
    `- Skeptic model: ${models.skeptic ?? "default"}`,
    `- Builder model: ${models.builder ?? "default"}`,
    `- Judge model: ${models.judge ?? "default"}`,
    "",
    "## Original Spec",
    sourceText.trimEnd(),
  ];

  for (const round of rounds) {
    lines.push(
      "",
      `## Round ${round.round}`,
      "",
      "### Skeptic",
      round.skeptic,
      "",
      "### Judge",
      `- Consensus: ${round.judge.consensus}`,
      `- Confidence: ${round.judge.confidence}`,
      `- Summary: ${round.judge.summary}`,
      `- Needs user input: ${round.judge.needsUserInput}`,
      ...(round.judge.userInputReason ? [`- User input reason: ${round.judge.userInputReason}`] : []),
      ...(round.judge.mustFix.length ? ["- Must fix:", ...round.judge.mustFix.map((item) => `  - ${item}`)] : ["- Must fix: none"]),
      ...(round.judge.niceToHave.length
        ? ["- Nice to have:", ...round.judge.niceToHave.map((item) => `  - ${item}`)]
        : ["- Nice to have: none"]),
    );

    if (round.judge.questions.length > 0) {
      lines.push(
        "- User questions:",
        ...round.judge.questions.flatMap((question) => [
          `  - [${question.area}] ${question.question}`,
          question.whyItMatters ? `    - Why it matters: ${question.whyItMatters}` : "",
        ]).filter(Boolean),
      );
    }

    if (round.userDecision) {
      lines.push(
        "",
        "### User Direction",
        `- Answered: ${round.userDecision.answered}`,
        `- Reason: ${round.userDecision.reason || "No reason provided."}`,
      );

      if (round.userDecision.responses.length > 0) {
        lines.push(
          "- Answers:",
          ...round.userDecision.responses.map((response) => `  - [${response.area}] ${response.question}: ${response.answer}`),
        );
      }

      if (round.userDecision.pendingQuestions.length > 0) {
        lines.push(
          "- Pending questions:",
          ...round.userDecision.pendingQuestions.map((question) => `  - [${question.area}] ${question.question}`),
        );
      }
    }

    lines.push("", "### Revised Spec", round.revisedSpec.trimEnd());
  }

  return lines.join("\n");
}

function buildSummary(result: DebateRunResult): string {
  const pendingQuestions = getPendingUserQuestions(result.rounds);
  return [
    result.status === "consensus"
      ? `Consensus reached after ${result.rounds.length} round(s).`
      : result.status === "needs-user-input"
        ? `Debate paused for user input after ${result.rounds.length} round(s).`
        : `Debate finished after ${result.rounds.length} round(s).`,
    `Source: ${result.sourcePath}`,
    `Output: ${result.outputDir}`,
    `Final spec: ${result.finalSpecPath}`,
    `Report: ${result.consensusPath}`,
    `Debate log: ${result.debatePath}`,
    ...(pendingQuestions.length > 0 ? [`Pending questions: ${pendingQuestions.length}`] : []),
  ].join("\n");
}

function getPendingUserQuestions(rounds: DebateRound[]): UserDecisionQuestion[] {
  const last = rounds[rounds.length - 1];
  if (!last) return [];
  if (last.userDecision?.pendingQuestions.length) return last.userDecision.pendingQuestions;
  return last.judge.needsUserInput ? last.judge.questions : [];
}

function formatUserDecisionRequest(judge: JudgeDecision): string {
  return [
    judge.userInputReason ? `Reason: ${judge.userInputReason}` : "",
    ...judge.questions.flatMap((question) => [
      `- [${question.area}] ${question.question}`,
      question.whyItMatters ? `  - Why it matters: ${question.whyItMatters}` : undefined,
    ]),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function formatUserDecisionAnswers(responses: UserDecisionAnswer[]): string {
  return responses
    .flatMap((response) => [
      `- [${response.area}] ${response.question}`,
      response.whyItMatters ? `  - Why it matters: ${response.whyItMatters}` : undefined,
      `  - Answer: ${response.answer}`,
    ])
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function defaultOutputDirFor(specPath: string): string {
  const ext = path.extname(specPath);
  const base = path.basename(specPath, ext);
  return path.join(path.dirname(specPath), `${base}.spec-debate`);
}

function resolvePath(cwd: string, input: string): string {
  const normalized = input.startsWith("@") ? input.slice(1) : input;
  return path.resolve(cwd, normalized);
}

function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseCommandArgs(input: string): {
  path?: string;
  rounds?: number;
  outputDir?: string;
  skepticModel?: string;
  builderModel?: string;
  judgeModel?: string;
} {
  const tokens = tokenize(input);
  const result: {
    path?: string;
    rounds?: number;
    outputDir?: string;
    skepticModel?: string;
    builderModel?: string;
    judgeModel?: string;
  } = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "--rounds" && tokens[i + 1]) {
      result.rounds = Number.parseInt(tokens[++i], 10);
      continue;
    }
    if (token.startsWith("--rounds=")) {
      result.rounds = Number.parseInt(token.slice("--rounds=".length), 10);
      continue;
    }

    if (token === "--output-dir" && tokens[i + 1]) {
      result.outputDir = tokens[++i];
      continue;
    }
    if (token.startsWith("--output-dir=")) {
      result.outputDir = token.slice("--output-dir=".length);
      continue;
    }

    if (token === "--skeptic-model" && tokens[i + 1]) {
      result.skepticModel = tokens[++i];
      continue;
    }
    if (token.startsWith("--skeptic-model=")) {
      result.skepticModel = token.slice("--skeptic-model=".length);
      continue;
    }

    if (token === "--builder-model" && tokens[i + 1]) {
      result.builderModel = tokens[++i];
      continue;
    }
    if (token.startsWith("--builder-model=")) {
      result.builderModel = token.slice("--builder-model=".length);
      continue;
    }

    if (token === "--judge-model" && tokens[i + 1]) {
      result.judgeModel = tokens[++i];
      continue;
    }
    if (token.startsWith("--judge-model=")) {
      result.judgeModel = token.slice("--judge-model=".length);
      continue;
    }

    if (!result.path) {
      result.path = token;
    }
  }

  return result;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && i + 1 < input.length) {
      current += input[++i];
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}
