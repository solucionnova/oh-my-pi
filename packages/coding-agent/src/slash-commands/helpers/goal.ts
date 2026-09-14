import type { GoalControllerResult } from "../../goals/goal-mode-controller";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

const GOAL_SET_USAGE = "Usage: /goal set <objective>";
const GOAL_BUDGET_USAGE = "Usage: /goal budget <N|off>";
const GOAL_UNKNOWN_VERB_USAGE = "Unknown /goal subcommand. Use set|show|pause|resume|drop|budget";

async function mapGoalResult(result: GoalControllerResult, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!result.ok) return usage(result.error, runtime);
	if (result.prompt !== undefined) return { prompt: result.prompt };
	return commandConsumed();
}

/** ACP/text-mode `/goal` handler. Shared by both dispatchers via the spec. */
export async function handleGoalAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	const controller = runtime.session.goalModeController;
	const goal = runtime.session.getGoalModeState()?.goal;
	const isActiveGoal = goal?.status === "active" || goal?.status === "budget-limited";

	switch (verb) {
		case "set": {
			const objective = rest.trim();
			if (!objective) return usage(GOAL_SET_USAGE, runtime);
			if (goal?.status === "paused") {
				return usage("Resume the current goal first, or drop it before setting a new objective.", runtime);
			}
			const result = isActiveGoal ? await controller.replaceObjective(objective) : await controller.enter(objective);
			return await mapGoalResult(result, runtime);
		}
		case "show": {
			await runtime.output(controller.show());
			return commandConsumed();
		}
		case "pause":
			return await mapGoalResult(await controller.pause(), runtime);
		case "resume":
			return await mapGoalResult(await controller.resume(), runtime);
		case "drop":
			return await mapGoalResult(await controller.drop(), runtime);
		case "budget": {
			const raw = rest.trim();
			if (!raw) return usage(GOAL_BUDGET_USAGE, runtime);
			let budget: number | undefined;
			if (raw.toLowerCase() === "off") {
				budget = undefined;
			} else {
				const parsed = Number(raw);
				if (!Number.isInteger(parsed) || parsed <= 0) return usage(GOAL_BUDGET_USAGE, runtime);
				budget = parsed;
			}
			return await mapGoalResult(await controller.setBudget(budget), runtime);
		}
		case "": {
			// Bare /goal = status query.
			await runtime.output(controller.show());
			return commandConsumed();
		}
		default: {
			// `/goal <objective>` sets a new goal only when no live goal owns the session.
			if (goal?.status === "paused") {
				return usage("Resume the current goal first, or drop it before setting a new objective.", runtime);
			}
			if (!isActiveGoal) {
				const result = await controller.enter(command.args.trim());
				return await mapGoalResult(result, runtime);
			}
			return usage(GOAL_UNKNOWN_VERB_USAGE, runtime);
		}
	}
}
