import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

/**
 * Headless (ACP/RPC) goal-mode driver.
 *
 * Subscribes to session events and drives the session-owned headless
 * `GoalModeController`; InteractiveMode keeps its existing TUI lifecycle.
 * The adapter forwards agent/tool/goal lifecycle events to the controller hooks,
 * then at `agent_end` submits the continuation
 * prompt the controller computed via the central agent-initiated-turn path
 * (`sendCustomMessage` `triggerTurn`), so the session's `deferAgentInitiatedTurns`
 * gate applies: RPC runs the continuation turn immediately; ACP queues it to
 * drain on the next explicit client turn (ACP v1 clients cannot show a
 * server-initiated turn as busy after a prompt response). Submission is gated
 * on the run-mode setting (`goal.continuationModes` includes `modeId`) and on
 * the goal still being active after a short settle delay. Continuation is
 * opt-in: the default `goal.continuationModes = ["interactive"]` keeps headless
 * continuation off, while the first turn always runs (the /goal set handler
 * returns the kickoff prompt).
 *
 * Lifecycle: `attachHeadlessGoalAdapter` is async — it awaits an initial
 * `controller.restore()` (race-free reconciliation of any persisted goal before
 * the first user op) and registers itself as the session's switch reconciler so
 * an in-process `switchSession` (RPC `handleRpcSessionChange`) re-reconciles
 * instead of leaking the prior goal state into the new transcript. The returned
 * detach clears the reconciler and unsubscribes.
 *
 * The subscriber never throws: every async branch is caught and logged so an
 * adapter failure cannot propagate into the session's event dispatch.
 */
export async function attachHeadlessGoalAdapter(session: AgentSession, modeId: "acp" | "rpc"): Promise<() => void> {
	const controller = session.goalModeController;
	// Real AgentSessions always construct a GoalModeController + expose the
	// switch-reconciler slot. Test doubles that don't model the goal surface are
	// skipped inertly (the wiring is exercised against full stubs in
	// headless-goal-adapter.test.ts).
	if (!controller || typeof session.setSessionSwitchReconciler !== "function") {
		return () => {};
	}
	const reconcile = async (): Promise<void> => {
		await controller.restore({ preserveActiveGoal: true });
	};
	session.setSessionSwitchReconciler(reconcile);
	const unsubscribe = session.subscribe(event => {
		try {
			switch (event.type) {
				case "agent_start":
					controller.onAgentStart();
					return;
				case "tool_execution_start":
					controller.onToolStart();
					return;
				case "message_start":
					// A real (non-synthetic) user message clears continuation
					// suppression, mirroring InteractiveMode — the user retook
					// control, so a prior talk-only continuation must not block the
					// next auto-continue.
					if (event.message.role === "user" && !event.message.synthetic) {
						controller.resetContinuationSuppression();
					}
					return;
				case "goal_updated":
					void controller
						.onGoalUpdated(event.state)
						.catch(error => logger.error("Headless goal adapter: goal_updated handler failed", { error }));
					return;
				case "agent_end":
					void submitContinuationIfDue(session, modeId).catch(error =>
						logger.error("Headless goal adapter: agent_end handler failed", { error }),
					);
					return;
				default:
					return;
			}
		} catch (error) {
			logger.error("Headless goal adapter: subscriber threw", { error });
		}
	});
	// Race-free initial reconciliation of a persisted goal before any user op.
	try {
		await controller.restore({ preserveActiveGoal: true });
	} catch (error) {
		logger.error("Headless goal adapter: initial restore failed", { error });
	}
	return () => {
		session.setSessionSwitchReconciler(null);
		unsubscribe();
	};
}

async function submitContinuationIfDue(session: AgentSession, modeId: "acp" | "rpc"): Promise<void> {
	const decision = await session.goalModeController.onAgentEnd();
	if (!decision) return;
	const continuationModes: readonly string[] = session.settings.get("goal.continuationModes");
	if (!continuationModes.includes(modeId)) return;
	if (session.isStreaming) return;
	// Let the just-finished turn's tail events (message_end, async deliveries)
	// settle so the follow-up queues behind a settled agent state.
	await Bun.sleep(50);
	if (session.isStreaming) return;
	const state = session.getGoalModeState();
	if (!state?.enabled || state.goal.status !== "active") return;
	// Route through the central agent-initiated-turn path (sendCustomMessage
	// triggerTurn) so the session's deferAgentInitiatedTurns gate applies.
	//  - RPC (no client bridge): the turn runs synchronously INSIDE sendCustomMessage
	//    (it awaits the whole turn), so its own agent_end fires — and is handled
	//    recursively right here — BEFORE this await resolves. The continuation
	//    mark MUST therefore precede the call so that agent_end's suppression
	//    accounting sees this as a continuation turn; marking after would miss it
	//    and let a talk-only continuation loop forever. Roll back on failure.
	//  - ACP (deferAgentInitiatedTurns): the continuation is QUEUED to drain on
	//    the next explicit client turn — a client-driven turn, not an
	//    agent-initiated continuation — so do NOT mark. A bare mark or followUp()
	//    would bypass the gate and start a server-initiated turn the ACP v1
	//    client cannot display as busy (#5628).
	if (modeId === "rpc") {
		session.goalModeController.markContinuationInFlight();
		try {
			await session.sendCustomMessage(
				{ customType: "goal-continuation", content: decision.prompt },
				{ triggerTurn: true },
			);
		} catch (error) {
			// Turn didn't run — undo the mark so it isn't counted against the next turn.
			session.goalModeController.noteContinuationSubmissionEnded();
			throw error;
		}
	} else {
		await session.sendCustomMessage(
			{ customType: "goal-continuation", content: decision.prompt },
			{ triggerTurn: true },
		);
	}
}
