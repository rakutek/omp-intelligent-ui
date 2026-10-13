/**
 * Intelligent UI for omp.
 *
 * The model answers with interactive cards — text, drawings, charts, tabs and
 * controls — through the `ui` tool. A card draws in the transcript while its
 * arguments stream, and opens full screen (`/ui`, ctrl+n) to be operated with
 * keys or the mouse. Edits reach the model with the user's next message;
 * buttons can send a message themselves.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, TERMINAL, Text, type Theme, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { SYSTEM_GUIDE, TOOL_DESCRIPTION } from "./src/guide";
import { NODE_TYPES, nodeList, Registry, record, specOf, UiInstance } from "./src/model";
import { type PanelResult, UiPanel } from "./src/panel";
import { renderCard, Surface } from "./src/render";

const TOOL = "ui";
const STATE_MESSAGE = "intelligent-ui-state";
const WIDGET = "intelligent-ui";
const SHORTCUT = "ctrl+n";
/** Tool cards whose figures stay rasterized; an older card re-rasterizes if it is painted again. */
const CARD_CACHE_LIMIT = 48;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/**
 * Planted on a tool card's render state, which the host keeps for the card's
 * lifetime and passes to every `renderCall`: it tells one card's renders
 * apart from another's while the arguments stream.
 */
const CARD_ID = "__intelligentUiCard";
const NO_DRAFTS = new Map<string, string>();
const EMPTY: Component = { render: () => [], invalidate() {} };

interface CardState {
	readonly surface: Surface;
	/** The spec while arguments stream; the finished card uses the registry's instance. */
	draft: UiInstance | undefined;
}

interface CardDetails {
	readonly key: string;
	readonly title: string;
	readonly interactive: boolean;
	readonly issues: readonly string[];
}

interface StateDetails {
	readonly key: string;
	readonly values: Record<string, unknown>;
}

/** A card in the transcript: the live state of its instance, never focused. */
class CardView implements Component {
	readonly #card: CardState;
	readonly #instance: UiInstance;
	readonly #theme: Theme;
	readonly #partial: boolean;
	readonly #spinnerFrame: number;
	#last: readonly string[] = [];

	constructor(card: CardState, instance: UiInstance, theme: Theme, partial: boolean, spinnerFrame: number) {
		this.#card = card;
		this.#instance = instance;
		this.#theme = theme;
		this.#partial = partial;
		this.#spinnerFrame = spinnerFrame;
	}

	render(width: number): readonly string[] {
		const out = renderCard(
			{
				theme: this.#theme,
				instance: this.#instance,
				surface: this.#card.surface,
				interactive: false,
				focus: undefined,
				partial: this.#partial,
				images: TERMINAL.imageProtocol != null,
				drafts: NO_DRAFTS,
				press: undefined,
				labelWidth: 0,
			},
			width,
			{ header: true },
		);
		const lines = out.lines;
		if (this.#partial) {
			lines.push(this.#theme.fg("dim", `${SPINNER[this.#spinnerFrame % SPINNER.length]} composing…`));
		}
		// Same rows as last frame: return the same array so the host can skip them.
		if (lines.length === this.#last.length && lines.every((line, index) => line === this.#last[index])) return this.#last;
		this.#last = lines;
		return lines;
	}

	invalidate(): void {
		this.#card.surface.invalidate();
	}
}

export default function intelligentUi(pi: ExtensionAPI): void {
	const z = pi.zod;
	const registry = new Registry();
	const cards = new Map<number, CardState>();
	let nextCard = 0;
	let enabled = false;
	let tui: TUI | undefined;
	/** The card the hint under the editor points at, until the user sends something. */
	let hint: UiInstance | undefined;

	const requestRender = (): void => tui?.requestRender();

	function cardFor(options: object): CardState {
		const state = options as Record<string, unknown>;
		let id = state[CARD_ID];
		if (typeof id !== "number") {
			id = ++nextCard;
			state[CARD_ID] = id;
		}
		const key = id as number;
		let card = cards.get(key);
		if (card) {
			cards.delete(key);
		} else {
			card = { surface: new Surface(requestRender, () => tui?.imageBudget), draft: undefined };
			if (cards.size >= CARD_CACHE_LIMIT) {
				const [oldest, evicted] = cards.entries().next().value!;
				cards.delete(oldest);
				evicted.surface.dispose();
			}
		}
		cards.set(key, card);
		return card;
	}

	/** Rebuild the session's cards and their saved state from the current branch. */
	function restore(ctx: ExtensionContext): void {
		registry.clear();
		hint = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				for (const block of entry.message.content) {
					if (block.type === "toolCall" && block.name === TOOL) {
						registry.markExecuted(registry.ensure(specOf(block.arguments)), block.id);
					}
				}
			} else if (entry.type === "custom_message" && entry.customType === STATE_MESSAGE) {
				const details = entry.details as StateDetails | undefined;
				registry.get(details?.key)?.importValues(details?.values);
			}
		}
	}

	async function activate(ctx: ExtensionContext): Promise<void> {
		// Cards need the interactive terminal; print, RPC and subagent sessions never see the tool.
		enabled = ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";
		if (!enabled) return;
		const active = pi.getActiveTools();
		if (!active.includes(TOOL)) await pi.setActiveTools([...active, TOOL]);
		ctx.ui.setWidget(
			WIDGET,
			(ui, theme) => {
				tui = ui;
				return {
					render(width: number): readonly string[] {
						if (!hint) return [];
						const line = `${theme.fg("accent", " ◆ ")}${hint.title}${theme.fg("dim", ` · ${SHORTCUT} or /ui to operate it`)}`;
						return [truncateToWidth(line, width)];
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
		restore(ctx);
	}

	/** Tell the model what the user changed, ahead of their next message. */
	function shareState(instance: UiInstance): void {
		if (!instance.pendingReport()) return;
		instance.markReported();
		const details: StateDetails = { key: instance.key, values: instance.exportValues() };
		pi.sendMessage(
			{
				customType: STATE_MESSAGE,
				content: `[Intelligent UI] The user operated the card “${instance.title}”. Current state: ${instance.summary()}`,
				display: false,
				details,
			},
			{ deliverAs: "nextTurn" },
		);
	}

	async function open(ctx: ExtensionContext, instance: UiInstance | undefined): Promise<void> {
		if (!enabled) {
			ctx.ui.notify("Intelligent UI cards need the interactive terminal", "warning");
			return;
		}
		if (!instance) {
			ctx.ui.notify("No interactive card in this session yet", "info");
			return;
		}
		hint = undefined;
		const result = await ctx.ui.custom<PanelResult>(
			(ui, theme, _keybindings, done) => {
				tui = ui;
				const surface = new Surface(
					() => ui.requestRender(),
					() => ui.imageBudget,
				);
				return new UiPanel(ui, theme, instance, surface, TERMINAL.imageProtocol != null, done);
			},
			{
				overlay: true,
				overlayOptions: { fullscreen: true, anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			},
		);
		requestRender();
		shareState(instance);
		if (!result?.send) return;
		if (ctx.isIdle()) pi.sendUserMessage(result.send);
		else pi.sendUserMessage(result.send, { deliverAs: "followUp" });
	}

	pi.registerTool({
		name: TOOL,
		label: "Intelligent UI",
		description: TOOL_DESCRIPTION,
		parameters: z.object({
			title: z.string().describe("Card title"),
			subtitle: z.string().optional().describe("One line under the title"),
			state: z
				.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
				.optional()
				.describe("Initial variables"),
			computed: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe("name → expression, recomputed live in order"),
			body: z
				.array(z.object({ type: z.enum(Object.keys(NODE_TYPES) as [string, ...string[]]) }).passthrough())
				.describe("Nodes, rendered in order"),
		}),
		approval: "read",
		loadMode: "essential",
		defaultInactive: true,

		async execute(toolCallId, params) {
			const instance = registry.ensure(specOf(params));
			registry.markExecuted(instance, toolCallId);
			const issues = instance.diagnose();
			const interactive = instance.interactive();
			const details: CardDetails = { key: instance.key, title: instance.title, interactive, issues };
			if (nodeList(instance.spec.body).length === 0) {
				return { content: [{ type: "text", text: "The card has no body nodes; nothing was shown." }], details, isError: true };
			}
			if (interactive) {
				hint = instance;
				requestRender();
			}
			const lines = [
				`Rendered “${instance.title}” on the user's screen.${interactive ? " They can open it full screen (/ui, ctrl+n) to operate it; their changes reach you with their next message." : ""}`,
			];
			if (interactive) lines.push(`State: ${instance.summary()}`);
			if (issues.length > 0) {
				lines.push(
					"Problems (the card still rendered; call ui again with a fixed card if they hide what the user needs):",
					...issues.map(issue => `- ${issue}`),
				);
			}
			lines.push("Do not restate the card. Add one short sentence at most, or nothing.");
			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},

		renderCall(args, options, theme) {
			const card = cardFor(options);
			// While arguments stream the host attaches the raw JSON prefix; finished arguments come without it.
			const partial = record(args)?.__partialJson !== undefined;
			const spec = specOf(args);
			let instance: UiInstance;
			if (partial) {
				card.draft ??= new UiInstance("draft", spec);
				card.draft.setSpec(spec);
				instance = card.draft;
			} else {
				instance = registry.ensure(spec);
			}
			return new CardView(card, instance, theme, partial, options.spinnerFrame ?? 0);
		},

		renderResult(result, _options, theme) {
			if (result.isError) {
				const message = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
				return new Text(theme.fg("error", message), 0, 0);
			}
			const details = result.details as CardDetails | undefined;
			if (!details?.interactive) return EMPTY;
			return new Text(theme.fg("dim", `◇ ${SHORTCUT} or /ui opens this card full screen to operate it`), 0, 0);
		},
	});

	pi.registerCommand("ui", {
		description: "Operate the latest interactive card full screen (`/ui list` to pick one)",
		getArgumentCompletions: prefix =>
			"list".startsWith(prefix.trim()) ? [{ value: "list", label: "list", description: "Pick a card from this session" }] : null,
		handler: async (args, ctx) => {
			if (args.trim() !== "list") {
				await open(ctx, registry.latest());
				return;
			}
			const executed = registry.executed();
			if (executed.length === 0) {
				ctx.ui.notify("No interactive card in this session yet", "info");
				return;
			}
			const labels = executed.map((card, index) => `${index + 1}. ${card.title}`).reverse();
			const choice = await ctx.ui.select("Interactive cards", labels);
			if (choice) await open(ctx, executed[Number.parseInt(choice, 10) - 1]);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Operate the latest interactive card full screen",
		handler: ctx => open(ctx, registry.latest()),
	});

	pi.on("session_start", (_event, ctx) => activate(ctx));
	pi.on("session_switch", (_event, ctx) => activate(ctx));
	pi.on("session_branch", (_event, ctx) => {
		if (enabled) restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (enabled) restore(ctx);
	});
	pi.on("input", () => {
		if (!hint) return;
		hint = undefined;
		requestRender();
	});
	pi.on("before_agent_start", event => {
		if (!enabled || !pi.getActiveTools().includes(TOOL)) return;
		return { systemPrompt: [...event.systemPrompt, SYSTEM_GUIDE] };
	});
}
