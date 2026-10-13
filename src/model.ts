/**
 * Card specs as the model streams them, and the live state behind a card.
 *
 * A spec arrives as partially parsed JSON, so every reader here tolerates
 * missing or half-written fields. A {@link UiInstance} owns one card's
 * variables: declared `state`, each control's value, the user's edits, and
 * the `computed` values derived from them.
 */
import {
	asNumber,
	display,
	errorMessage,
	evaluate,
	interpolate,
	type Scope,
	syntaxError,
	templateExpressions,
	text,
	toNumber,
	type Value,
} from "./expr";

export type NodeSpec = Readonly<Record<string, unknown>>;

export interface UiSpec {
	readonly title?: unknown;
	readonly subtitle?: unknown;
	readonly state?: unknown;
	readonly computed?: unknown;
	readonly body?: unknown;
}

export const NODE_TYPES: Readonly<Record<string, true>> = {
	text: true,
	callout: true,
	stats: true,
	table: true,
	timeline: true,
	progress: true,
	figure: true,
	chart: true,
	divider: true,
	card: true,
	columns: true,
	tabs: true,
	slider: true,
	number: true,
	input: true,
	select: true,
	toggle: true,
	button: true,
	buttons: true,
};

/** Controls that own a state variable named by their `id`. */
export const CONTROL_TYPES: Readonly<Record<string, true>> = {
	slider: true,
	number: true,
	input: true,
	select: true,
	toggle: true,
};

// ── Tolerant field readers ───────────────────────────────────────────────────

export function str(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

export function num(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return typeof value === "string" ? asNumber(value) : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function list(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The object entries of `value`; anything else (a half-streamed scalar) is skipped. */
export function nodeList(value: unknown): NodeSpec[] {
	return list(value).flatMap(item => {
		const node = record(item);
		return node ? [node] : [];
	});
}

export function scalar(value: unknown): Value | undefined {
	if (value === null) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

// ── Controls ─────────────────────────────────────────────────────────────────

export interface Option {
	readonly label: string;
	readonly value: Value;
}

export type InputKind = "slider" | "number" | "input" | "select" | "toggle" | "tabs";

export interface InputDecl {
	readonly id: string;
	readonly kind: InputKind;
	readonly node: NodeSpec;
	readonly path: string;
	readonly options: readonly Option[];
	readonly initial: Value;
}

export interface NumberBounds {
	readonly min: number;
	readonly max: number;
	readonly step: number;
}

/** State variable a control or tab strip writes: its `id`, else one derived from its position. */
export function inputId(node: NodeSpec, path: string): string {
	const id = str(node.id)?.trim();
	return id || `_${path.replaceAll(".", "_")}`;
}

export function selectOptions(node: NodeSpec): Option[] {
	return list(node.options).flatMap((item, index) => {
		const entry = record(item);
		if (entry) {
			const value = scalar(entry.value) ?? str(entry.label) ?? index;
			return [{ label: str(entry.label) ?? display(value), value }];
		}
		const value = scalar(item);
		return value === undefined ? [] : [{ label: display(value), value }];
	});
}

export function tabOptions(node: NodeSpec): Option[] {
	return nodeList(node.tabs).map((tab, index) => {
		const label = str(tab.label) ?? `Tab ${index + 1}`;
		return { label, value: scalar(tab.value) ?? label };
	});
}

/** Index of `value` among `options` (matched loosely, `3` == `"3"`), or -1. */
export function optionIndex(options: readonly Option[], value: Value | undefined): number {
	if (value === undefined) return -1;
	const exact = options.findIndex(option => option.value === value);
	return exact >= 0 ? exact : options.findIndex(option => text(option.value) === text(value));
}

function initialValue(kind: InputKind, node: NodeSpec, options: readonly Option[], preset: Value | undefined): Value {
	switch (kind) {
		case "slider":
		case "number": {
			const min = num(node.min);
			const max = num(node.max);
			let value = asNumber(preset ?? undefined) ?? num(node.value) ?? min ?? 0;
			if (min !== undefined) value = Math.max(min, value);
			if (max !== undefined) value = Math.min(max, value);
			return value;
		}
		case "input":
			return typeof preset === "string" ? preset : (str(node.value) ?? "");
		case "toggle":
			return typeof preset === "boolean" ? preset : node.value === true;
		case "select":
		case "tabs": {
			for (const candidate of [preset, scalar(node.value)]) {
				const at = optionIndex(options, candidate);
				if (at >= 0) return options[at]!.value;
			}
			return options[0]?.value ?? null;
		}
	}
}

/**
 * Visit every node with its path (`"2"`, `"2.0"` inside a card, `"4.t1.0"`
 * inside a tab), descending into containers. Renderers derive the same paths,
 * so a path names one node across the card and the full-screen view.
 * `implied` carries the type of `buttons` items, which may omit theirs.
 */
export function walk(
	body: unknown,
	visit: (node: NodeSpec, path: string, implied: string | undefined) => void,
	base = "",
	implied?: string,
): void {
	nodeList(body).forEach((node, index) => {
		const path = base ? `${base}.${index}` : String(index);
		visit(node, path, implied);
		switch (str(node.type) ?? implied) {
			case "card":
				walk(node.body, visit, path);
				break;
			case "columns":
				walk(node.items, visit, path);
				break;
			case "buttons":
				walk(node.items, visit, path, "button");
				break;
			case "tabs":
				nodeList(node.tabs).forEach((tab, at) => {
					walk(tab.body, visit, `${path}.t${at}`);
				});
				break;
		}
	});
}

// ── Live state ───────────────────────────────────────────────────────────────

interface Resolved {
	readonly revision: number;
	readonly vars: Map<string, Value>;
	readonly errors: Map<string, string>;
}

export interface PressResult {
	readonly send?: string;
	readonly error?: string;
}

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

export class UiInstance {
	readonly key: string;
	/** Tool call that rendered the card; set once the call executes. */
	toolCallId: string | undefined;
	#spec: UiSpec;
	readonly #values = new Map<string, Value>();
	/** Bumps on any change that can alter rendering: spec or values. */
	#revision = 0;
	/** Bumps on user edits only; what {@link pendingReport} compares. */
	#edits = 0;
	#reportedEdits = 0;
	#inputs: Map<string, InputDecl> | undefined;
	#interactive: boolean | undefined;
	#resolved: Resolved | undefined;

	constructor(key: string, spec: UiSpec) {
		this.key = key;
		this.#spec = spec;
	}

	get spec(): UiSpec {
		return this.#spec;
	}

	get revision(): number {
		return this.#revision;
	}

	get title(): string {
		return str(this.#spec.title)?.trim() || "Untitled card";
	}

	/** Replace the spec of a card still streaming; user values never exist there. */
	setSpec(spec: UiSpec): void {
		if (spec === this.#spec) return;
		this.#spec = spec;
		this.#inputs = undefined;
		this.#interactive = undefined;
		this.#revision++;
	}

	/** Every control and tab strip by state variable; the first declaration of an id wins. */
	inputs(): ReadonlyMap<string, InputDecl> {
		if (this.#inputs) return this.#inputs;
		const state = record(this.#spec.state) ?? {};
		const inputs = new Map<string, InputDecl>();
		walk(this.#spec.body, (node, path) => {
			const type = str(node.type);
			if (type !== "tabs" && !(type !== undefined && CONTROL_TYPES[type])) return;
			const kind = type as InputKind;
			const id = inputId(node, path);
			if (inputs.has(id)) return;
			const options = kind === "tabs" ? tabOptions(node) : kind === "select" ? selectOptions(node) : [];
			inputs.set(id, { id, kind, node, path, options, initial: initialValue(kind, node, options, scalar(state[id])) });
		});
		this.#inputs = inputs;
		return inputs;
	}

	/** Whether the card has anything to operate: controls, tabs or buttons. */
	interactive(): boolean {
		if (this.#interactive !== undefined) return this.#interactive;
		let found = this.inputs().size > 0;
		if (!found) {
			walk(this.#spec.body, (node, _path, implied) => {
				const type = str(node.type) ?? implied;
				if (type === "button" || type === "buttons") found = true;
			});
		}
		this.#interactive = found;
		return found;
	}

	#resolve(): Resolved {
		if (this.#resolved?.revision === this.#revision) return this.#resolved;
		const vars = new Map<string, Value>();
		const errors = new Map<string, string>();
		for (const [name, raw] of Object.entries(record(this.#spec.state) ?? {})) {
			const value = scalar(raw);
			if (value !== undefined) vars.set(name, value);
		}
		for (const input of this.inputs().values()) vars.set(input.id, input.initial);
		for (const [name, value] of this.#values) vars.set(name, value);
		const scope: Scope = name => vars.get(name);
		for (const [name, source] of Object.entries(record(this.#spec.computed) ?? {})) {
			if (typeof source === "number" || typeof source === "boolean") {
				vars.set(name, source);
				continue;
			}
			if (typeof source !== "string") continue;
			try {
				vars.set(name, evaluate(source, scope));
			} catch (error) {
				errors.set(name, errorMessage(error));
			}
		}
		this.#resolved = { revision: this.#revision, vars, errors };
		return this.#resolved;
	}

	get(name: string): Value | undefined {
		return this.#resolve().vars.get(name);
	}

	/** Variables for expressions; `extra` (a chart's `x`) shadows the card's own. */
	scope(extra?: Readonly<Record<string, Value>>): Scope {
		const vars = this.#resolve().vars;
		if (!extra) return name => vars.get(name);
		return name => (Object.hasOwn(extra, name) ? extra[name] : vars.get(name));
	}

	/** Bounds of a slider or number field; `min`/`max`/`step` may be expressions. */
	numberBounds(node: NodeSpec): NumberBounds {
		const scope = this.scope();
		const read = (field: unknown): number | undefined => {
			if (typeof field === "number") return Number.isFinite(field) ? field : undefined;
			if (typeof field !== "string") return undefined;
			try {
				return toNumber(evaluate(field, scope));
			} catch {
				return undefined;
			}
		};
		const slider = node.type === "slider";
		let min = read(node.min) ?? (slider ? 0 : Number.NEGATIVE_INFINITY);
		let max = read(node.max) ?? (slider ? 100 : Number.POSITIVE_INFINITY);
		if (min > max) [min, max] = [max, min];
		const span = Number.isFinite(max - min) ? max - min : 100;
		let step = Math.abs(read(node.step) ?? 0);
		if (step === 0) {
			// Whole steps for an integer range; otherwise about a hundredth of it, on a 1-2-5 grid.
			if (Number.isInteger(min) && Number.isInteger(max) && span >= 5) step = 1;
			else {
				const raw = span / 100;
				const power = 10 ** Math.floor(Math.log10(raw));
				step = raw / power >= 5 ? 5 * power : raw / power >= 2 ? 2 * power : power;
			}
		}
		return { min, max, step };
	}

	set(name: string, value: Value): void {
		const input = this.inputs().get(name);
		let next = value;
		if (input && (input.kind === "slider" || input.kind === "number")) {
			const { min, max, step } = this.numberBounds(input.node);
			let n = asNumber(value) ?? (Number.isFinite(min) ? min : 0);
			if (input.kind === "slider" && Number.isFinite(min)) n = min + Math.round((n - min) / step) * step;
			n = Math.min(max, Math.max(min, n));
			next = Number(n.toPrecision(12));
		}
		if (this.#values.has(name) && this.#values.get(name) === next) return;
		this.#values.set(name, next);
		this.#revision++;
		this.#edits++;
	}

	reset(): void {
		if (this.#values.size === 0) return;
		this.#values.clear();
		this.#revision++;
		this.#edits++;
	}

	/** Run a button: `reset`, then every `set` assignment against the pre-press state, then `send`. */
	press(node: NodeSpec): PressResult {
		try {
			if (node.reset === true) this.reset();
			const assignments = record(node.set);
			if (assignments) {
				const scope = this.scope();
				const updates: [string, Value][] = [];
				for (const [name, source] of Object.entries(assignments)) {
					const value = typeof source === "string" ? this.#assignment(source, scope) : scalar(source);
					if (value !== undefined) updates.push([name, value]);
				}
				for (const [name, value] of updates) this.set(name, value);
			}
			const send = str(node.send);
			return send ? { send: interpolate(send, this.scope()) } : {};
		} catch (error) {
			return { error: errorMessage(error) };
		}
	}

	#assignment(source: string, scope: Scope): Value {
		const trimmed = source.trim();
		// `"set": {"mode": "easy"}` or `{"msg": "Game over"}` mean the words, not expressions.
		if (syntaxError(trimmed) !== undefined) return source;
		try {
			return evaluate(trimmed, scope, { random: true });
		} catch (error) {
			if (IDENTIFIER.test(trimmed) && scope(trimmed) === undefined) return trimmed;
			throw error;
		}
	}

	/** Whether the user changed anything since the model last saw the state. */
	pendingReport(): boolean {
		return this.#edits !== this.#reportedEdits;
	}

	markReported(): void {
		this.#reportedEdits = this.#edits;
	}

	exportValues(): Record<string, Value> {
		return Object.fromEntries(this.#values);
	}

	/** Restore values saved in the session; the model already saw them. */
	importValues(values: unknown): void {
		const entries = Object.entries(record(values) ?? {});
		this.#values.clear();
		for (const [name, raw] of entries) {
			const value = scalar(raw);
			if (value !== undefined) this.#values.set(name, value);
		}
		this.#revision++;
		this.#edits++;
		this.#reportedEdits = this.#edits;
	}

	/** `rate=4, years=20, total=1,234` — controls, then computed values, then other edited variables. */
	summary(limit = 900): string {
		const vars = this.#resolve().vars;
		const names = [
			...this.inputs().keys(),
			...Object.keys(record(this.#spec.computed) ?? {}),
			...Array.from(this.#values.keys()).filter(name => !this.inputs().has(name)),
		];
		const parts = Array.from(new Set(names), name => {
			const value = vars.get(name);
			return `${name}=${typeof value === "string" ? JSON.stringify(value) : text(value)}`;
		});
		const joined = parts.join(", ");
		return joined.length > limit ? `${joined.slice(0, limit - 1)}…` : joined || "(no variables)";
	}

	/**
	 * Problems the model should fix: unknown or incomplete nodes, expressions
	 * that do not parse, and placeholders that fail against the initial state.
	 */
	diagnose(limit = 12): string[] {
		const issues: string[] = [];
		const scope = this.scope();
		const resolved = this.#resolve();
		const checkExpression = (where: string, source: unknown, run: boolean): void => {
			if (typeof source !== "string") return;
			const error = syntaxError(source);
			if (error) {
				issues.push(`${where}: ${error}`);
				return;
			}
			if (!run) return;
			try {
				evaluate(source, scope);
			} catch (failure) {
				issues.push(`${where}: ${errorMessage(failure)}`);
			}
		};
		const checkTemplate = (where: string, template: unknown): void => {
			if (typeof template !== "string") return;
			for (const expression of templateExpressions(template)) checkExpression(`${where} {{${expression}}}`, expression, true);
		};

		if (nodeList(this.#spec.body).length === 0) issues.push("body has no nodes");
		for (const [name, error] of resolved.errors) issues.push(`computed.${name}: ${error}`);
		checkTemplate("title", this.#spec.title);
		checkTemplate("subtitle", this.#spec.subtitle);

		walk(this.#spec.body, (node, path, implied) => {
			const type = str(node.type) ?? implied;
			const where = `body[${path}]${type ? ` ${type}` : ""}`;
			if (!type) {
				issues.push(`${where}: missing "type"`);
				return;
			}
			if (!NODE_TYPES[type]) {
				issues.push(`${where}: unknown type "${type}"`);
				return;
			}
			checkExpression(`${where}.when`, node.when, true);
			for (const field of ["text", "title", "label", "caption", "send"]) checkTemplate(`${where}.${field}`, node[field]);
			if (CONTROL_TYPES[type] && !str(node.id)?.trim()) issues.push(`${where}: missing "id" (state variable)`);
			switch (type) {
				case "text":
					if (!str(node.text)?.trim()) issues.push(`${where}: empty "text"`);
					break;
				case "figure":
					if (!str(node.svg)?.includes("<svg")) issues.push(`${where}: "svg" must hold an <svg> document`);
					break;
				case "chart":
					if (!(Array.isArray(node.rows) || Array.isArray(node.series))) {
						issues.push(`${where}: give "columns"+"rows", or "x"+"series"`);
					}
					break;
				case "select":
					if (selectOptions(node).length === 0) issues.push(`${where}: no "options"`);
					break;
				case "tabs":
					if (nodeList(node.tabs).length === 0) issues.push(`${where}: no "tabs"`);
					break;
				case "stats":
					nodeList(node.items).forEach((item, at) => {
						for (const field of ["label", "value", "note"]) checkTemplate(`${where}.items[${at}].${field}`, item[field]);
					});
					break;
				case "timeline":
					nodeList(node.items).forEach((item, at) => {
						for (const field of ["time", "title", "text"]) checkTemplate(`${where}.items[${at}].${field}`, item[field]);
					});
					break;
				case "progress":
					checkExpression(`${where}.value`, node.value, true);
					checkExpression(`${where}.max`, node.max, true);
					break;
				case "button":
					if (node.set === undefined && node.send === undefined && node.reset !== true) {
						issues.push(`${where}: needs "set", "send" or "reset"`);
					}
					for (const [name, source] of Object.entries(record(node.set) ?? {})) {
						checkExpression(`${where}.set.${name}`, source, false);
					}
					break;
			}
		});
		return issues.slice(0, limit);
	}
}

// ── Identity and registry ────────────────────────────────────────────────────

/** JSON with sorted keys: equal specs hash equal however a validator reordered them. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = record(value);
	if (object) {
		const fields = Object.keys(object)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
		return `{${fields.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Stable identity of a finished spec, shared by its tool card, its execution and `/ui`. */
export function specKey(spec: UiSpec): string {
	const source = canonicalJson([spec.title, spec.subtitle, spec.state, spec.computed, spec.body]);
	// Two FNV-1a lanes with different offsets: 64 bits, plenty for one session's cards.
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < source.length; i++) {
		const code = source.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x01000193) ^ (b >>> 13);
	}
	return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** The spec fields of tool-call arguments, without the host's streaming extras. */
export function specOf(args: unknown): UiSpec {
	const raw = record(args) ?? {};
	return { title: raw.title, subtitle: raw.subtitle, state: raw.state, computed: raw.computed, body: raw.body };
}

export class Registry {
	readonly #byKey = new Map<string, UiInstance>();
	readonly #executed: UiInstance[] = [];

	ensure(spec: UiSpec): UiInstance {
		const key = specKey(spec);
		let instance = this.#byKey.get(key);
		if (!instance) {
			instance = new UiInstance(key, spec);
			this.#byKey.set(key, instance);
		}
		return instance;
	}

	get(key: unknown): UiInstance | undefined {
		return typeof key === "string" ? this.#byKey.get(key) : undefined;
	}

	/** Record that `instance` rendered as a finished card, newest last. */
	markExecuted(instance: UiInstance, toolCallId: string): void {
		instance.toolCallId = toolCallId;
		const at = this.#executed.indexOf(instance);
		if (at >= 0) this.#executed.splice(at, 1);
		this.#executed.push(instance);
	}

	latest(): UiInstance | undefined {
		return this.#executed.at(-1);
	}

	executed(): readonly UiInstance[] {
		return this.#executed;
	}

	clear(): void {
		this.#byKey.clear();
		this.#executed.length = 0;
	}
}
