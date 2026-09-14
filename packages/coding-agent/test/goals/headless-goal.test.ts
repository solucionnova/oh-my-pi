import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { attachHeadlessGoalAdapter } from "@oh-my-pi/pi-coding-agent/goals/headless";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleGoalAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/goal";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	tempDir: TempDir;
	settings: Settings;
	session: AgentSession;
	cleanup: () => Promise<void>;
};

type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	baseDir: TempDir;
};

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
}

async function createHarness(shared: SharedFixture): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-headless-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: shared.model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager,
		settings,
		modelRegistry: shared.modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
	});
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);
	return {
		tempDir,
		settings,
		session,
		cleanup: async () => {
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

function createSlashRuntime(harness: Harness, output: string[]): SlashCommandRuntime {
	return {
		session: harness.session,
		sessionManager: harness.session.sessionManager,
		settings: harness.settings,
		cwd: harness.tempDir.path(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
}

describe("headless Goal mode", () => {
	let shared: SharedFixture;
	let harness: Harness;

	beforeAll(async () => {
		const baseDir = TempDir.createSync("@pi-headless-goal-shared-");
		const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		shared = { authStorage, modelRegistry, model, baseDir };
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		harness = await createHarness(shared);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("runs /goal locally with trimmed objectives and paused/budget guards", async () => {
		const output: string[] = [];
		const runtime = createSlashRuntime(harness, output);
		const created = await handleGoalAcp(
			{ name: "goal", args: "set    Ship the release   ", text: "/goal set Ship the release" },
			runtime,
		);
		expect(created).toEqual({ prompt: "Ship the release" });
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");

		await handleGoalAcp({ name: "goal", args: "pause", text: "/goal pause" }, runtime);
		const pausedGoalId = harness.session.getGoalModeState()?.goal.id;
		const replacement = await handleGoalAcp(
			{ name: "goal", args: "set Replace it", text: "/goal set Replace it" },
			runtime,
		);
		expect(replacement).toEqual({ consumed: true });
		expect(output.at(-1)).toContain("Resume the current goal first");
		expect(harness.session.getGoalModeState()?.goal.id).toBe(pausedGoalId);

		await handleGoalAcp({ name: "goal", args: "resume", text: "/goal resume" }, runtime);
		const invalidBudget = await handleGoalAcp(
			{ name: "goal", args: "budget 2.5", text: "/goal budget 2.5" },
			runtime,
		);
		expect(invalidBudget).toEqual({ consumed: true });
		expect(output.at(-1)).toContain("Usage: /goal budget");
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();

		await handleGoalAcp({ name: "goal", args: "budget 8", text: "/goal budget 8" }, runtime);
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBe(8);
	});

	it("blocks headless Goal entry in plan/vibe modes and rejects terminal persisted goals", async () => {
		expect(await harness.session.goalModeController.enter("   ")).toEqual({
			ok: false,
			error: "Goal objective is required.",
		});

		harness.session.sessionManager.appendModeChange("vibe");
		expect(await harness.session.goalModeController.enter("Ship")).toEqual({
			ok: false,
			error: "Exit vibe mode first.",
		});

		harness.session.sessionManager.appendModeChange("plan_paused");
		expect(await harness.session.goalModeController.enter("Ship")).toEqual({
			ok: false,
			error: "Exit plan mode first.",
		});

		const completeGoal: Goal = {
			id: "done-goal",
			objective: "Already done",
			status: "complete",
			tokensUsed: 10,
			timeUsedSeconds: 1,
			createdAt: 1,
			updatedAt: 2,
		};
		harness.session.sessionManager.appendModeChange("goal", { goal: completeGoal });
		expect(await harness.session.goalModeController.restore()).toBeUndefined();
		expect(harness.session.getGoalModeState()).toBeUndefined();
		expect(harness.session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("submits RPC continuations through the headless adapter", async () => {
		const controller = {
			restore: vi.fn(async () => undefined),
			onAgentStart: vi.fn(),
			onToolStart: vi.fn(),
			resetContinuationSuppression: vi.fn(),
			onGoalUpdated: vi.fn(async () => undefined),
			onAgentEnd: vi.fn(async () => ({ prompt: "Continue the goal" })),
			markContinuationInFlight: vi.fn(),
			noteContinuationSubmissionEnded: vi.fn(),
		};
		let subscriber: ((event: { type: string }) => void) | undefined;
		const unsubscribe = vi.fn();
		const sent = Promise.withResolvers<void>();
		const sendCustomMessage = vi.fn(async () => {
			sent.resolve();
			return true;
		});
		const fakeSession = {
			goalModeController: controller,
			setSessionSwitchReconciler: vi.fn(),
			subscribe: vi.fn((listener: (event: { type: string }) => void) => {
				subscriber = listener;
				return unsubscribe;
			}),
			settings: { get: () => ["rpc"] },
			isStreaming: false,
			getGoalModeState: () => ({ enabled: true, mode: "active", goal: { status: "active" } }),
			sendCustomMessage,
		} as unknown as AgentSession;

		const detach = await attachHeadlessGoalAdapter(fakeSession, "rpc");
		subscriber?.({ type: "agent_end" });
		await sent.promise;

		expect(controller.markContinuationInFlight).toHaveBeenCalledTimes(1);
		expect(sendCustomMessage).toHaveBeenCalledWith(
			{ customType: "goal-continuation", content: "Continue the goal" },
			{ triggerTurn: true },
		);

		detach();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("preserves an active persisted Goal when RPC mode reattaches", async () => {
		const activeGoal: Goal = {
			id: "rpc-restored-goal",
			objective: "Persisted RPC goal",
			status: "active",
			tokensUsed: 4,
			timeUsedSeconds: 2,
			createdAt: 1,
			updatedAt: 2,
		};
		harness.session.sessionManager.appendModeChange("goal", { goal: activeGoal });
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			throw new Error(`RPC_EXIT:${code ?? ""}`);
		});
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});

		await expect(runRpcMode(harness.session, undefined, undefined, input)).rejects.toThrow("RPC_EXIT:0");
		expect(exit).toHaveBeenCalledWith(0);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Persisted RPC goal");
		expect(harness.session.getGoalModeState()?.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");
	});
});
