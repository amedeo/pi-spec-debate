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

interface DebateConfigOverride {
  maxRounds?: number;
  writeRoundFiles?: boolean;
  models?: Partial<Record<RoleName, string>>;
  timeouts?: Partial<DebateTimeoutConfig>;
  childTools?: Partial<DebateChildToolConfig>;
}

interface DebateProgressUpdate {
  current: string;
  elapsedMs: number;
  history: string[];
  activity?: string;
  outputLabel?: string;
  outputPreview?: string;
}

interface DebateOverrides {
  rounds?: number;
  outputDir?: string;
  models?: Partial<Record<RoleName, string>>;
  availableToolNames?: string[];
  signal?: AbortSignal;
  onProgress?: (update: DebateProgressUpdate) => void;
}

interface DebateProgressTracker {
  lines: string[];
  current: string;
  activity?: string;
  outputLabel?: string;
  outputPreview: string;
  spinnerIndex: number;
  startedAt: number;
  lastRenderedAt: number;
  lastPublishedAt: number;
  timer?: ReturnType<typeof setInterval>;
}

interface DebateRoleExecutionConfig {
  timeoutMs: number;
  terminateGraceMs: number;
  webSearchToolName?: string;
  approveProject: boolean;
  signal?: AbortSignal;
}

interface TimeoutAbortControl {
  signal?: AbortSignal;
  dispose(): void;
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
    skepticMs: 300_000,
    builderMs: 600_000,
    judgeMs: 300_000,
    roundMs: 0,
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
      const details = message.details as Partial<DebateRunResult> & { error?: string };
      const extra = buildExpandedMessageDetails(details);
      if (extra) text += `\n\n${extra}`;
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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
        onProgress: (update) => {
          onUpdate?.({
            content: [{ type: "text", text: buildProgressUpdateText(update) }],
            details: { status: "running", ...update },
          });
        },
      });

      return {
        content: [{ type: "text", text: buildSummary(result) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("spec_debate "));
      text += theme.fg("muted", args.path);
      if (args.rounds) text += theme.fg("dim", ` · up to ${args.rounds} rounds`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const content = toolResultText(result.content);

      if (isPartial) {
        const update = result.details as (Partial<DebateProgressUpdate> & { status?: string }) | undefined;
        let text = theme.fg("warning", update?.current ?? "spec-debate running");
        if (typeof update?.elapsedMs === "number") {
          text += theme.fg("dim", ` · ${formatElapsed(update.elapsedMs)}`);
        }
        if (update?.activity) text += `\n${theme.fg("dim", update.activity)}`;
        if (update?.outputPreview?.trim()) {
          text += `\n\n${theme.fg("muted", `${update.outputLabel ?? "Model"} output (live):`)}`;
          text += `\n${update.outputPreview.trimEnd()}`;
        }
        return new Text(text, 0, 0);
      }

      const details = result.details as Partial<DebateRunResult> | undefined;
      let text = content;
      if (expanded && details) {
        const extra = buildExpandedMessageDetails(details);
        if (extra) text += `\n\n${extra}`;
      }
      return new Text(text, 0, 0);
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
  await rm(path.join(outputDir, "failure.md"), { force: true });

  let currentSpec = sourceText.trimEnd() + "\n";
  const rounds: DebateRound[] = [];
  let status: DebateStatus = "max-rounds";
  const progress = createProgressTracker();

  const timeoutSummary = [
    `skeptic ${formatTimeout(config.timeouts.skepticMs)}`,
    `builder ${formatTimeout(config.timeouts.builderMs)}`,
    `judge ${formatTimeout(config.timeouts.judgeMs)}`,
    `round ${formatTimeout(config.timeouts.roundMs)}`,
  ].join(" · ");
  reportProgress(ctx, progress, `starting ${path.basename(specPath)} · ${timeoutSummary}`, overrides);
  startProgressTicker(ctx, progress, overrides);

  try {
    for (let round = 1; round <= maxRounds; round++) {
      let roundControl = createTimeoutAbortControl(config.timeouts.roundMs, `debate round ${round}`);
      let roundSignal = combineAbortSignals([overrides.signal, roundControl.signal]);

      const resetRoundTimeout = () => {
        roundControl.dispose();
        roundControl = createTimeoutAbortControl(config.timeouts.roundMs, `debate round ${round}`);
        roundSignal = combineAbortSignals([overrides.signal, roundControl.signal]);
        reportProgress(ctx, progress, `round ${round}/${maxRounds}: timeout reset after user direction`, overrides);
      };

      const pauseRoundTimeout = () => {
        roundControl.dispose();
        roundSignal = combineAbortSignals([overrides.signal]);
        reportProgress(ctx, progress, `round ${round}/${maxRounds}: timeout paused for user direction`, overrides);
      };

      try {
        beginRoleProgress(
          ctx,
          progress,
          `round ${round}/${maxRounds}: skeptic · ${models.skeptic ?? "default model"}`,
          "Skeptic",
          overrides,
        );
        const skeptic = await runRole({
          cwd: path.dirname(specPath),
          model: models.skeptic,
          systemPrompt: skepticSystemPrompt(),
          prompt: buildSkepticPrompt(currentSpec, rounds, round, maxRounds),
          label: `skeptic round ${round}`,
          ...roleExecution.skeptic,
          signal: roundSignal,
          onTextDelta: (delta) => reportRoleOutput(ctx, progress, delta, overrides),
          onActivity: (activity) => reportRoleActivity(ctx, progress, activity, overrides),
        });
        if (config.writeRoundFiles) await writeSkepticRoundFile(outputDir, round, skeptic);
        reportProgress(ctx, progress, `round ${round}/${maxRounds}: skeptic complete`, overrides);

        beginRoleProgress(
          ctx,
          progress,
          `round ${round}/${maxRounds}: builder · ${models.builder ?? "default model"}`,
          "Builder",
          overrides,
        );
        let revisedSpec = stripWrappingCodeFence(
          await runRole({
            cwd: path.dirname(specPath),
            model: models.builder,
            systemPrompt: builderSystemPrompt(),
            prompt: buildBuilderPrompt(currentSpec, skeptic, rounds, round, maxRounds),
            label: `builder round ${round}`,
            ...roleExecution.builder,
            signal: roundSignal,
            onTextDelta: (delta) => reportRoleOutput(ctx, progress, delta, overrides),
            onActivity: (activity) => reportRoleActivity(ctx, progress, activity, overrides),
          }),
        ).trimEnd() + "\n";
        if (config.writeRoundFiles) await writeBuilderRoundFile(outputDir, round, revisedSpec);
        reportProgress(ctx, progress, `round ${round}/${maxRounds}: builder complete`, overrides);

        beginRoleProgress(
          ctx,
          progress,
          `round ${round}/${maxRounds}: judge · ${models.judge ?? "default model"}`,
          "Judge",
          overrides,
        );
        const judgeRaw = await runRole({
          cwd: path.dirname(specPath),
          model: models.judge,
          systemPrompt: judgeSystemPrompt(),
          prompt: buildJudgePrompt(skeptic, revisedSpec, rounds, round, maxRounds),
          label: `judge round ${round}`,
          ...roleExecution.judge,
          signal: roundSignal,
          onTextDelta: (delta) => reportRoleOutput(ctx, progress, delta, overrides),
          onActivity: (activity) => reportRoleActivity(ctx, progress, activity, overrides),
        });
        let judge = parseJudgeDecision(judgeRaw);
        if (config.writeRoundFiles) await writeJudgeRoundFile(outputDir, round, judge);
        reportProgress(ctx, progress, `round ${round}/${maxRounds}: judge complete`, overrides);

        let userDecision: UserDecisionState | undefined;

        if (judge.needsUserInput) {
          const questions = judge.questions.length > 0 ? judge.questions : fallbackUserDecisionQuestions(judge);
          judge = { ...judge, questions };

          if (ctx.hasUI) {
            reportProgress(ctx, progress, `round ${round}/${maxRounds}: awaiting user direction`, overrides);
            pauseRoundTimeout();
            let responses: UserDecisionAnswer[];
            try {
              responses = await collectUserDecisionResponses(ctx, specPath, round, maxRounds, judge);
            } finally {
              resetRoundTimeout();
            }

            if (responses.length > 0) {
              userDecision = {
                reason: judge.userInputReason || judge.summary || "User direction was required.",
                answered: true,
                responses,
                pendingQuestions: [],
              };
              await writeUserDecisionRoundFile(outputDir, round, userDecision);
              reportProgress(ctx, progress, `round ${round}/${maxRounds}: user direction checkpointed`, overrides);

              beginRoleProgress(
                ctx,
                progress,
                `round ${round}/${maxRounds}: integrating user direction · ${models.builder ?? "default model"}`,
                "Builder",
                overrides,
              );
              revisedSpec = stripWrappingCodeFence(
                await runRole({
                  cwd: path.dirname(specPath),
                  model: models.builder,
                  systemPrompt: builderSystemPrompt(),
                  prompt: buildUserDecisionIntegrationPrompt(skeptic, revisedSpec, judge, responses, rounds, round, maxRounds),
                  label: `builder user-direction round ${round}`,
                  ...roleExecution.builder,
                  signal: roundSignal,
                  onTextDelta: (delta) => reportRoleOutput(ctx, progress, delta, overrides),
                  onActivity: (activity) => reportRoleActivity(ctx, progress, activity, overrides),
                }),
              ).trimEnd() + "\n";
              if (config.writeRoundFiles) await writeBuilderRoundFile(outputDir, round, revisedSpec);
              reportProgress(ctx, progress, `round ${round}/${maxRounds}: user direction integrated`, overrides);

              beginRoleProgress(
                ctx,
                progress,
                `round ${round}/${maxRounds}: re-judge · ${models.judge ?? "default model"}`,
                "Judge",
                overrides,
              );
              const rejudgeRaw = await runRole({
                cwd: path.dirname(specPath),
                model: models.judge,
                systemPrompt: judgeSystemPrompt(),
                prompt: buildJudgePrompt(skeptic, revisedSpec, rounds, round, maxRounds),
                label: `judge after user direction round ${round}`,
                ...roleExecution.judge,
                signal: roundSignal,
                onTextDelta: (delta) => reportRoleOutput(ctx, progress, delta, overrides),
                onActivity: (activity) => reportRoleActivity(ctx, progress, activity, overrides),
              });
              judge = parseJudgeDecision(rejudgeRaw);
              if (config.writeRoundFiles) await writeJudgeRoundFile(outputDir, round, judge);
              reportProgress(ctx, progress, `round ${round}/${maxRounds}: re-judge complete`, overrides);

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

    reportProgress(ctx, progress, "finalizing debate artifacts", overrides);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportProgress(ctx, progress, `failed: ${message}`, overrides);
    await writeFailureReport(outputDir, specPath, message, progress).catch(() => undefined);
    throw error;
  } finally {
    clearProgress(ctx, progress);
  }
}

const PROGRESS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_PREVIEW_MAX_CHARS = 12_000;
const PROGRESS_PUBLISH_INTERVAL_MS = 500;

function createProgressTracker(): DebateProgressTracker {
  const now = Date.now();
  return {
    lines: [],
    current: "starting",
    outputPreview: "",
    spinnerIndex: 0,
    startedAt: now,
    lastRenderedAt: 0,
    lastPublishedAt: 0,
  };
}

function startProgressTicker(
  ctx: ExtensionCommandContext | ExtensionContext,
  progress: DebateProgressTracker,
  overrides: DebateOverrides,
) {
  if ((!ctx.hasUI && !overrides.onProgress) || progress.timer) return;
  progress.timer = setInterval(() => {
    progress.spinnerIndex = (progress.spinnerIndex + 1) % PROGRESS_SPINNER_FRAMES.length;
    renderProgress(ctx, progress);
    publishProgress(progress, overrides);
  }, 250);
}

function renderProgress(ctx: ExtensionCommandContext | ExtensionContext, progress: DebateProgressTracker) {
  if (!ctx.hasUI) return;
  const frame = PROGRESS_SPINNER_FRAMES[progress.spinnerIndex % PROGRESS_SPINNER_FRAMES.length];
  const elapsed = formatElapsed(Date.now() - progress.startedAt);
  ctx.ui.setStatus("spec-debate", `${frame} ${progress.current}`);
  const widgetText = buildProgressWidgetText(progress, frame, elapsed);
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("spec-debate-progress", () => new Text(widgetText, 0, 0));
  } else {
    ctx.ui.setWidget("spec-debate-progress", widgetText.split("\n"));
  }
  progress.lastRenderedAt = Date.now();
}

function buildProgressWidgetText(progress: DebateProgressTracker, frame: string, elapsed: string): string {
  return [
    `${frame} spec-debate running ${elapsed}`,
    `current: ${progress.current}`,
    progress.activity ? `activity: ${progress.activity}` : "",
    "",
    ...progress.lines.slice(-5),
    "",
    progress.outputPreview.trim() ? `${progress.outputLabel ?? "Model"} output (live):` : "",
    progress.outputPreview.trim() ? tailText(progress.outputPreview, 2_400, 10) : "",
  ]
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .trimEnd();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimeout(ms: number): string {
  return ms === 0 ? "off" : formatDuration(ms);
}

function reportProgress(
  ctx: ExtensionCommandContext | ExtensionContext,
  progress: DebateProgressTracker,
  text: string,
  overrides: DebateOverrides,
) {
  progress.current = text;
  progress.activity = undefined;
  progress.lines.push(`${new Date().toLocaleTimeString()} ${text}`);
  renderProgress(ctx, progress);
  publishProgress(progress, overrides, true);
}

function beginRoleProgress(
  ctx: ExtensionCommandContext | ExtensionContext,
  progress: DebateProgressTracker,
  text: string,
  outputLabel: string,
  overrides: DebateOverrides,
) {
  progress.outputLabel = outputLabel;
  progress.outputPreview = "";
  reportProgress(ctx, progress, text, overrides);
  progress.activity = "waiting for model";
  renderProgress(ctx, progress);
  publishProgress(progress, overrides, true);
}

function reportRoleOutput(
  ctx: ExtensionCommandContext | ExtensionContext,
  progress: DebateProgressTracker,
  delta: string,
  overrides: DebateOverrides,
) {
  progress.outputPreview = (progress.outputPreview + delta).slice(-PROGRESS_PREVIEW_MAX_CHARS);
  progress.activity = "streaming final output";
  const now = Date.now();
  if (now - progress.lastRenderedAt >= 100) renderProgress(ctx, progress);
  publishProgress(progress, overrides);
}

function reportRoleActivity(
  ctx: ExtensionCommandContext | ExtensionContext,
  progress: DebateProgressTracker,
  activity: string,
  overrides: DebateOverrides,
) {
  if (progress.activity === activity) return;
  progress.activity = activity;
  renderProgress(ctx, progress);
  publishProgress(progress, overrides, true);
}

function publishProgress(progress: DebateProgressTracker, overrides: DebateOverrides, force = false) {
  if (!overrides.onProgress) return;
  const now = Date.now();
  if (!force && now - progress.lastPublishedAt < PROGRESS_PUBLISH_INTERVAL_MS) return;
  progress.lastPublishedAt = now;
  overrides.onProgress({
    current: progress.current,
    elapsedMs: now - progress.startedAt,
    history: progress.lines.slice(-8),
    activity: progress.activity,
    outputLabel: progress.outputLabel,
    outputPreview: progress.outputPreview.trim() ? tailText(progress.outputPreview, 4_000, 20) : undefined,
  });
}

function buildProgressUpdateText(update: DebateProgressUpdate): string {
  return [
    `spec-debate running ${formatElapsed(update.elapsedMs)}`,
    `current: ${update.current}`,
    update.activity ? `activity: ${update.activity}` : "",
    update.outputPreview?.trim() ? "" : "",
    update.outputPreview?.trim() ? `${update.outputLabel ?? "Model"} output (live):` : "",
    update.outputPreview?.trim() ? update.outputPreview.trimEnd() : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function tailText(text: string, maxChars: number, maxLines: number): string {
  const wasCharClipped = text.length > maxChars;
  const clipped = wasCharClipped ? text.slice(-maxChars) : text;
  const lines = clipped.split(/\r?\n/);
  const wasLineClipped = lines.length > maxLines;
  const tail = lines.slice(-maxLines).join("\n");
  return wasCharClipped || wasLineClipped ? `…\n${tail}` : tail;
}

function clearProgress(ctx: ExtensionCommandContext | ExtensionContext, progress: DebateProgressTracker) {
  if (progress.timer) {
    clearInterval(progress.timer);
    progress.timer = undefined;
  }
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("spec-debate", undefined);
  ctx.ui.setWidget("spec-debate-progress", undefined);
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

function envConfig(): DebateConfigOverride {
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
    },
  };
}

async function readConfigFile(filePath: string): Promise<DebateConfigOverride | undefined> {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as DebateConfigOverride;
  return parsed;
}

function mergeConfig(base: DebateConfig, override: DebateConfigOverride | undefined): DebateConfig {
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
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid timeout value for ${name}: ${value}. Use 0 to disable a timeout.`);
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

function createTimeoutAbortControl(timeoutMs: number, label: string): TimeoutAbortControl {
  if (timeoutMs === 0) {
    return { signal: undefined, dispose() {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`${label} timed out after ${formatDuration(timeoutMs)}. Increase this timeout or set it to 0 to disable it.`),
    );
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
  return AbortSignal.any(active);
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
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
  onTextDelta?: (delta: string) => void;
  onActivity?: (activity: string) => void;
}): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-spec-debate-"));
  const promptPath = path.join(tempDir, "prompt.md");
  await writeFile(promptPath, input.prompt, "utf8");

  const args = ["--mode", "json", "--no-session"];

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
    input.onActivity?.("starting child agent");
    const output = await runPi(args, input.cwd, {
      signal,
      terminateGraceMs: input.terminateGraceMs,
      label: input.label,
      onTextDelta: input.onTextDelta,
      onActivity: input.onActivity,
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

function runPi(
  args: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    terminateGraceMs: number;
    label: string;
    onTextDelta?: (delta: string) => void;
    onActivity?: (activity: string) => void;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(abortMessage(options.signal.reason, `${options.label} cancelled`)));
      return;
    }

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

    let lineBuffer = "";
    let stderr = "";
    let protocolDiagnostics = "";
    let currentAssistantText = "";
    let lastAssistantText = "";
    let agentError: string | undefined;
    let abortError: Error | undefined;
    let settled = false;
    let forcedKillTimer: NodeJS.Timeout | undefined;

    const settle = (handler: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      handler();
    };

    const isRunning = () => proc.exitCode === null && proc.signalCode === null;

    const onAbort = () => {
      abortError = new Error(abortMessage(options.signal?.reason, `${options.label} cancelled`));
      options.onActivity?.("cancelling child agent");
      if (!isRunning()) {
        settle(() => reject(abortError!));
        return;
      }

      proc.kill("SIGTERM");
      forcedKillTimer = setTimeout(() => {
        if (isRunning()) proc.kill("SIGKILL");
      }, options.terminateGraceMs);
    };

    const processJsonLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        protocolDiagnostics = appendTail(protocolDiagnostics, trimmed + "\n", 50_000);
        return;
      }

      const type = typeof event.type === "string" ? event.type : "";
      if (type === "message_start") {
        const message = asRecord(event.message);
        if (message?.role === "assistant") {
          currentAssistantText = "";
          options.onActivity?.("model responding");
        }
        return;
      }

      if (type === "message_update") {
        const update = asRecord(event.assistantMessageEvent);
        const updateType = typeof update?.type === "string" ? update.type : "";
        if (updateType === "thinking_start" || updateType === "thinking_delta") {
          // Deliberately expose reasoning activity, not private chain-of-thought content.
          options.onActivity?.("model reasoning (content hidden)");
        } else if (updateType === "text_delta" && typeof update?.delta === "string") {
          currentAssistantText += update.delta;
          options.onTextDelta?.(update.delta);
        }
        return;
      }

      if (type === "message_end") {
        const message = asRecord(event.message);
        if (message?.role !== "assistant") return;
        const text = assistantText(message) || currentAssistantText;
        if (text.trim()) {
          if (!currentAssistantText && options.onTextDelta) options.onTextDelta(text);
          lastAssistantText = text;
        }
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          agentError = typeof message.errorMessage === "string"
            ? message.errorMessage
            : `${options.label} ${message.stopReason}`;
        }
        return;
      }

      if (type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        options.onActivity?.(`using ${toolName}`);
        return;
      }

      if (type === "auto_retry_start") {
        const attempt = typeof event.attempt === "number" ? event.attempt : "?";
        const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : "?";
        options.onActivity?.(`provider retry ${attempt}/${maxAttempts}`);
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("spawn", () => options.onActivity?.("waiting for model"));

    proc.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        processJsonLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf("\n");
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk.toString(), 50_000);
    });

    proc.on("error", (error) => {
      settle(() => {
        reject(new Error(`Failed to start pi subprocess: ${error.message}`));
      });
    });

    proc.on("close", (code) => {
      if (lineBuffer.trim()) processJsonLine(lineBuffer);

      settle(() => {
        if (abortError) {
          reject(abortError);
          return;
        }

        if (code === 0 && !agentError) {
          resolve(lastAssistantText || currentAssistantText);
          return;
        }

        const detail = [agentError, stderr.trim(), protocolDiagnostics.trim()].filter(Boolean).join("\n\n");
        reject(new Error(`pi subprocess failed (${code}). ${detail || "No output."}`));
      });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function assistantText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function appendTail(current: string, addition: string, maxChars: number): string {
  return (current + addition).slice(-maxChars);
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const block = asRecord(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
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
    "Keep the critique focused and concise; prioritize issues that can materially change implementation or approval.",
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
  await writeSkepticRoundFile(outputDir, round.round, round.skeptic);
  await writeBuilderRoundFile(outputDir, round.round, round.revisedSpec);
  await writeJudgeRoundFile(outputDir, round.round, round.judge);

  if (round.userDecision) {
    await writeUserDecisionRoundFile(outputDir, round.round, round.userDecision);
  }
}

async function writeSkepticRoundFile(outputDir: string, round: number, skeptic: string) {
  const prefix = `round-${String(round).padStart(2, "0")}`;
  await writeFile(path.join(outputDir, `${prefix}-skeptic.md`), skeptic.trimEnd() + "\n", "utf8");
}

async function writeBuilderRoundFile(outputDir: string, round: number, revisedSpec: string) {
  const prefix = `round-${String(round).padStart(2, "0")}`;
  await writeFile(path.join(outputDir, `${prefix}-builder.md`), revisedSpec.trimEnd() + "\n", "utf8");
}

async function writeJudgeRoundFile(outputDir: string, round: number, judge: JudgeDecision) {
  const prefix = `round-${String(round).padStart(2, "0")}`;
  await writeFile(path.join(outputDir, `${prefix}-judge.json`), JSON.stringify(judge, null, 2) + "\n", "utf8");
}

async function writeFailureReport(
  outputDir: string,
  specPath: string,
  message: string,
  progress: DebateProgressTracker,
) {
  await writeFile(
    path.join(outputDir, "failure.md"),
    [
      `# Spec Debate Failure: ${path.basename(specPath)}`,
      "",
      `- Source: ${specPath}`,
      `- Failed after: ${formatElapsed(Date.now() - progress.startedAt)}`,
      `- Current step: ${progress.current}`,
      `- Error: ${message}`,
      "",
      "## Progress",
      ...progress.lines.map((line) => `- ${line}`),
      ...(progress.outputPreview.trim()
        ? ["", `## Partial ${progress.outputLabel ?? "Model"} Output`, progress.outputPreview.trimEnd()]
        : []),
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeUserDecisionRoundFile(outputDir: string, round: number, userDecision: UserDecisionState) {
  const prefix = `round-${String(round).padStart(2, "0")}`;
  await writeFile(path.join(outputDir, `${prefix}-user.md`), buildUserDecisionRoundFile(userDecision), "utf8");
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
    "Expand this message to inspect the round-by-round debate.",
  ].join("\n");
}

function buildExpandedMessageDetails(details: Partial<DebateRunResult> & { error?: string }): string {
  const lines: string[] = [];
  const rounds = details.rounds ?? [];

  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.outputDir) lines.push(`Output: ${details.outputDir}`);
  if (details.status) lines.push(`Status: ${details.status}`);
  lines.push(`Rounds: ${rounds.length}`);

  if (details.finalSpecPath) lines.push(`Final spec: ${details.finalSpecPath}`);
  if (details.consensusPath) lines.push(`Consensus report: ${details.consensusPath}`);
  if (details.debatePath) lines.push(`Debate log: ${details.debatePath}`);

  for (const round of rounds) {
    const prefix = `round-${String(round.round).padStart(2, "0")}`;
    lines.push(
      "",
      `## Round ${round.round}`,
      "",
      "### Skeptic",
      round.skeptic || "(no critique captured)",
      "",
      "### Judge",
      `- Consensus: ${round.judge.consensus}`,
      `- Confidence: ${round.judge.confidence}`,
      `- Summary: ${round.judge.summary || "No summary provided."}`,
      `- Needs user input: ${round.judge.needsUserInput}`,
    );

    if (round.judge.userInputReason) {
      lines.push(`- User input reason: ${round.judge.userInputReason}`);
    }

    lines.push(
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

    lines.push(
      "",
      "### Builder",
      `Saved full revised draft to: ${details.outputDir ? path.join(details.outputDir, `${prefix}-builder.md`) : `${prefix}-builder.md`}`,
      "",
      round.revisedSpec.trimEnd() || "(no revised draft captured)",
    );
  }

  return lines.join("\n");
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
