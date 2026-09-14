import type { AgentSession } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import { formatDuration } from "../slash-commands/helpers/format";
import type { Goal, GoalModeState } from "./state";

/**
 * Session-level goal lifecycle for headless ACP/RPC operation. It reuses the
 * native GoalRuntime/state owned by AgentSession instead of implementing a
 * second Goal system. InteractiveMode keeps its existing TUI lifecycle in this
 * change; headless adapters drive this controller from session events.
 *
 * The controller never subscribes to session events itself. Adapters call
 * the event hooks (`onAgentStart`/`onToolStart`/`onGoalUpdated`/`onAgentEnd`)
 * from their own session subscribers, and apply their own run-mode gate
 * (`goal.continuationModes`) before submitting a continuation prompt.
 *
 * Pure logic: imports AgentSession/SessionManager as TYPES only (the core is
 * constructed BY AgentSession), so there is no module cycle.
 */
export type GoalContinuationDecision = { prompt: string } | null;

export type GoalControllerResult = { ok: true; prompt?: string } | { ok: false; error: string };

/** Validates a persisted `mode_change` goal payload (mirrors the TUI's #goalFromModeData). */
function goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		(value.status !== "active" &&
			value.status !== "paused" &&
			value.status !== "budget-limited" &&
			value.status !== "complete" &&
			value.status !== "dropped") ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export class GoalModeController {
	readonly #session: AgentSession;
	readonly #sessionManager: SessionManager;
	#previousTools: string[] | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;

	constructor(session: AgentSession, sessionManager: SessionManager) {
		this.#session = session;
		this.#sessionManager = sessionManager;
	}

	/** Tool set recorded before the goal tool was exposed; restored on exit/drop/disable. */
	get previousTools(): string[] | undefined {
		return this.#previousTools;
	}

	/** True when the next continuation must be skipped (a continuation turn made no tool calls). */
	isContinuationSuppressed(): boolean {
		return this.#goalSuppressNextContinuation;
	}

	/** Shared enter guards: `goal.enabled` setting + plan-mode exclusivity (active OR paused). */
	#guardGoalUsable(): GoalControllerResult | null {
		if (!this.#session.settings.get("goal.enabled")) {
			return { ok: false, error: "Goal mode is disabled. Enable it in settings (goal.enabled)." };
		}
		// Active plan is held in live session state; a PAUSED plan clears that
		// state but persists as a "plan_paused" mode entry — block both, matching
		// the TUI (interactive-mode.ts planModeEnabled || planModePaused guard).
		const persistedMode = this.#sessionManager.buildSessionContext().mode;
		if (this.#session.getPlanModeState()?.enabled || persistedMode === "plan" || persistedMode === "plan_paused") {
			return { ok: false, error: "Exit plan mode first." };
		}
		if (this.#session.getVibeModeState()?.enabled || persistedMode === "vibe") {
			return { ok: false, error: "Exit vibe mode first." };
		}
		return null;
	}

	/** Public entry guard for handlers that expose the goal tool out-of-band
	 *  (e.g. `/guided-goal` interview) so they reject disabled / plan(active or
	 * paused) states before the agent can call `goal create`, which itself has no
	 * plan guard. */
	entryGuard(): GoalControllerResult | null {
		return this.#guardGoalUsable();
	}

	/** Requires an active or budget-limited goal for pause / setBudget — a paused
	 * goal must be resumed first (matches the TUI: pause needs goalModeEnabled,
	 * budget is rejected while paused per fix #5). */
	#requireActiveGoal(): GoalControllerResult | null {
		const goal = this.#session.getGoalModeState()?.goal;
		if (!goal || (goal.status !== "active" && goal.status !== "budget-limited")) {
			return { ok: false, error: "No active goal." };
		}
		return null;
	}

	/** Requires any goal record (active or paused) for drop. */
	#requireAnyGoal(): GoalControllerResult | null {
		const goal = this.#session.getGoalModeState()?.goal;
		if (!goal || goal.status === "dropped") {
			return { ok: false, error: "No goal to drop." };
		}
		return null;
	}

	async enter(objective: string, tokenBudget?: number): Promise<GoalControllerResult> {
		const guard = this.#guardGoalUsable();
		if (guard) return guard;
		const trimmed = objective.trim();
		if (!trimmed) return { ok: false, error: "Goal objective is required." };
		const previousTools = this.#session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#previousTools = previousTools;
		try {
			const state = await this.#session.goalRuntime.createGoal({ objective: trimmed, tokenBudget });
			await this.#session.setActiveToolsByName(goalTools);
			this.#session.setGoalModeState(state);
		} catch (error) {
			this.#previousTools = undefined;
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, prompt: trimmed };
	}

	async resume(): Promise<GoalControllerResult> {
		const guard = this.#guardGoalUsable();
		if (guard) return guard;
		if (this.#session.getGoalModeState()?.goal.status !== "paused") {
			return { ok: false, error: "No paused goal to resume." };
		}
		const previousTools = this.#session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#previousTools = previousTools;
		try {
			const state = await this.#session.goalRuntime.resumeGoal();
			await this.#session.setActiveToolsByName(goalTools);
			this.#session.setGoalModeState(state);
		} catch (error) {
			this.#previousTools = undefined;
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true };
	}

	async replaceObjective(objective: string, tokenBudget?: number): Promise<GoalControllerResult> {
		const guard = this.#guardGoalUsable();
		if (guard) return guard;
		const current = this.#session.getGoalModeState()?.goal;
		if (current?.status === "paused") {
			return { ok: false, error: "Resume the current goal first, or drop it before setting a new objective." };
		}
		if (!current || (current.status !== "active" && current.status !== "budget-limited")) {
			return { ok: false, error: "No active goal." };
		}
		const trimmed = objective.trim();
		if (!trimmed) return { ok: false, error: "Goal objective is required." };
		try {
			const state = await this.#session.goalRuntime.replaceGoal({ objective: trimmed, tokenBudget });
			this.#session.setGoalModeState(state);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, prompt: trimmed };
	}

	async pause(): Promise<GoalControllerResult> {
		const active = this.#requireActiveGoal();
		if (active) return active;
		try {
			await this.#session.goalRuntime.pauseGoal();
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		// Pause keeps the goal record (status "paused") but removes the goal tool
		// from the active set — the agent must not operate on a paused goal until
		// /goal resume re-adds it. Own the restore here so headless adapters (which
		// don't run a TUI #exitGoalMode) get it; the TUI's subsequent
		// #exitGoalMode({paused}) sees #previousTools already cleared and no-ops.
		// The restore merges in tools enabled after the snapshot (e.g. late MCP
		// tools), so pausing can never disable a client tool. resume() re-captures
		// the then-current toolset as previousTools.
		await this.#restoreGoalTools();
		return { ok: true };
	}

	async drop(): Promise<GoalControllerResult> {
		const any = this.#requireAnyGoal();
		if (any) return any;
		try {
			await this.#session.goalRuntime.dropGoal();
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		// Drop is terminal: restore the merged pre-goal toolset here so standalone
		// adapters (headless) get the restore without an exit call. In the TUI the
		// `goal_updated`(dropped) event already restored via onGoalUpdated, so this
		// is a no-op there. The merge preserves tools that arrived after the
		// snapshot (e.g. late MCP tools).
		await this.#restoreGoalTools();
		return { ok: true };
	}

	async setBudget(value: number | undefined): Promise<GoalControllerResult> {
		if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
			return { ok: false, error: "Goal budget must be a positive integer or `off`." };
		}
		const active = this.#requireActiveGoal();
		if (active) return active;
		try {
			await this.#session.goalRuntime.onBudgetMutated(value);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true };
	}

	/** Multi-line goal summary for display; "No goal set." when no goal record exists. */
	show(): string {
		const state = this.#session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) return "No goal set.";
		const used = goal.tokensUsed.toLocaleString();
		const budgetLine =
			goal.tokenBudget !== undefined
				? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
				: `${used} (no budget)`;
		return [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${budgetLine}`,
			`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
		].join("\n");
	}

	/**
	 * Guided-goal interview setup: records the pre-interview toolset and exposes
	 * the goal tool so the agent can finish the interview with `goal create`
	 * (which turns goal mode on via `goal_updated`). The eventual goal exit
	 * restores the recorded set merged with whatever is enabled then (so tools
	 * that arrive after this snapshot, e.g. late MCP tools, are never dropped).
	 */
	async exposeGoalTool(): Promise<void> {
		const enabledTools = this.#session.getEnabledToolNames();
		this.#previousTools = enabledTools.filter(name => name !== "goal");
		if (!enabledTools.includes("goal")) {
			await this.#session.setActiveToolsByName([...enabledTools, "goal"]);
		}
	}

	/** Reconcile goal mode from persisted session entries on resume/switch. */
	async restore(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined> {
		const sessionContext = this.#sessionManager.buildSessionContext();
		const goalEnabled = this.#session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			await this.#restoreGoalTools();
			this.#session.goalRuntime.clearAccounting();
			this.#sessionManager.appendModeChange("none");
			this.#clearGoalModeState();
			return undefined;
		}
		if (sessionContext.mode !== "goal" && sessionContext.mode !== "goal_paused") {
			await this.#restoreGoalTools();
			this.#session.goalRuntime.clearAccounting();
			this.#clearGoalModeState();
			return undefined;
		}
		const goal = goalFromModeData(sessionContext.modeData);
		const validForMode =
			goal !== undefined &&
			((sessionContext.mode === "goal" && (goal.status === "active" || goal.status === "budget-limited")) ||
				(sessionContext.mode === "goal_paused" && goal.status === "paused"));
		if (!validForMode || !goal) {
			await this.#restoreGoalTools();
			this.#sessionManager.appendModeChange("none");
			this.#clearGoalModeState();
			return undefined;
		}
		this.#session.setGoalModeState({
			enabled: sessionContext.mode === "goal",
			mode: "active",
			goal,
		});
		const restored = await this.#session.goalRuntime.onThreadResumed({
			preserveActiveGoal: options?.preserveActiveGoal,
		});
		// sdk.ts excludes "goal" from the initial active tool set unconditionally.
		// Re-add it now so the agent can call resume, complete, or drop on this goal.
		if (restored?.goal) {
			const previousTools = this.#session.getEnabledToolNames().filter(name => name !== "goal");
			this.#previousTools = previousTools;
			await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		}
		return restored;
	}

	/**
	 * Restore the pre-goal tool set recorded by enter/resume/exposeGoalTool,
	 * MERGED with the currently-enabled non-goal tools. Goal mode only ever
	 * ADDS the `goal` tool — it never removes or restricts other tools — so the
	 * union is a strict superset of the snapshot-only restore: every tool that
	 * should remain enabled is kept, and only `goal` is dropped.
	 *
	 * The merge matters because the snapshot is point-in-time: MCP servers can
	 * enable tools AFTER it was taken (`MCPManager.connectServers` resolves via
	 * `Promise.race` at `STARTUP_TIMEOUT_MS`, so slow servers register their
	 * tools later through the background `onToolsChanged` -> `refreshMCPTools`
	 * path). A full replace with the stale snapshot would disable those late
	 * tools when the goal is paused/dropped/completed. The merge guarantees
	 * ending a goal never disables a client MCP tool. Shared by every goal exit
	 * path so all of them clean up the `goal` tool identically; no-op when no
	 * snapshot exists. */
	async #restoreGoalTools(): Promise<void> {
		if (this.#previousTools === undefined) return;
		const currentNonGoal = this.#session.getEnabledToolNames().filter(name => name !== "goal");
		const merged = [...new Set([...this.#previousTools, ...currentNonGoal])];
		await this.#session.setActiveToolsByName(merged);
		this.#previousTools = undefined;
	}

	/** Clear in-memory goal state + continuation flags (early-return branches of restore()). */
	#clearGoalModeState(): void {
		this.#session.setGoalModeState(undefined);
		this.#goalTurnHadToolCalls = false;
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
	}

	/**
	 * Session-level exit. The ADAPTER gates `restoreTools` with its own
	 * "goal mode active" flag so the exact tool-restore condition of each mode
	 * is preserved; `completed` records the goal-completion journal entry.
	 */
	async deactivate(options?: { restoreTools?: boolean; completed?: boolean; clearState?: boolean }): Promise<void> {
		if (options?.restoreTools) {
			await this.#restoreGoalTools();
		}
		// #restoreGoalTools() clears the snapshot itself; this unconditional clear
		// covers the restoreTools===false case so the snapshot never leaks.
		this.#previousTools = undefined;
		if (options?.completed) {
			const currentState = this.#session.getGoalModeState();
			this.#session.setGoalModeState(undefined);
			this.#sessionManager.appendModeChange("none");
			this.#sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		if (options?.clearState) {
			this.#session.setGoalModeState(undefined);
		}
		this.#goalTurnHadToolCalls = false;
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
	}

	// --- Continuation state (driven by adapter session subscribers) ---

	onAgentStart(): void {
		this.#goalTurnHadToolCalls = false;
	}

	onToolStart(): void {
		this.#goalTurnHadToolCalls = true;
		if (!this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = false;
		}
	}

	/** Adapter hook for `goal_updated` session events. Drop restores the merged
	 *  pre-goal tool set (snapshot ∪ currently-enabled non-goal tools) so late
	 *  MCP tools survive the goal exit. */
	async onGoalUpdated(state: GoalModeState | undefined): Promise<void> {
		if (state?.goal?.status !== "dropped") return;
		await this.#restoreGoalTools();
	}

	/**
	 * Adapter hook for `agent_end`. Computes the anti-talk-loop suppression from
	 * the just-finished continuation turn, performs the completion cleanup when
	 * the goal is exiting, and returns the continuation decision otherwise.
	 */
	async onAgentEnd(): Promise<GoalContinuationDecision> {
		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.#session.getGoalModeState()?.mode === "exiting") {
			// Completion exit must re-apply the pre-goal tool set (merged with
			// currently-enabled non-goal tools, so late MCP tools survive);
			// deactivate() clears #previousTools after restoring, so gate on the
			// snapshot still being present (F1).
			await this.deactivate({ restoreTools: this.#previousTools !== undefined, completed: true });
			return null;
		}
		return this.buildContinuationForSubmission();
	}

	/**
	 * Continuation DECISION: prompt when the goal is active and no suppression is
	 * armed. Suppression is armed ONLY by a continuation turn that made no tool
	 * calls (see {@link onAgentEnd}); a normal/user turn never suppresses here even
	 * if it made no tool calls — matching the original #scheduleGoalContinuation
	 * semantics. The ADAPTER applies its own run-mode gate
	 * (`goal.continuationModes` includes its mode id) before submitting — the TUI
	 * additionally checks editor/pending-input/streaming.
	 */
	buildContinuationForSubmission(): GoalContinuationDecision {
		const state = this.#session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return null;
		if (this.#goalSuppressNextContinuation) return null;
		const prompt = this.#session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return null;
		return { prompt };
	}

	/** Clears the next-continuation suppression (user input, tool activity, fresh goal ops). */
	resetContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
	}

	/** Adapter marks that it submitted a goal continuation (arms suppression accounting). */
	markContinuationInFlight(): void {
		this.#goalContinuationTurnInFlight = true;
	}

	/** Adapter marks that a goal-continuation submission was cancelled/finished without an agent_end. */
	noteContinuationSubmissionEnded(): void {
		this.#goalContinuationTurnInFlight = false;
	}

	dispose(): void {
		this.#previousTools = undefined;
		this.#goalTurnHadToolCalls = false;
		this.#goalContinuationTurnInFlight = false;
		this.#goalSuppressNextContinuation = false;
	}
}
