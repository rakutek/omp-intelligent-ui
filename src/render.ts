/**
 * Lays a card out as terminal rows. One renderer serves the transcript card
 * (static, showing live state) and the full-screen view (focus, clicks and
 * keys): it records where every control landed so the view can route input.
 */
import type { ImageBudget, Theme, ThemeColor } from "@oh-my-pi/pi-tui";
import {
	extractPrintableText,
	getMarkdownTheme,
	Markdown,
	matchesKey,
	padding,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { chartData, chartSvg, textChart } from "./charts";
import { asNumber, display, evaluate, formatNumber, interpolate, truthy } from "./expr";
import { Figure, highlightSvg } from "./figures";
import {
	CONTROL_TYPES,
	inputId,
	list,
	type NodeSpec,
	nodeList,
	num,
	optionIndex,
	type Option,
	str,
	tabOptions,
	type UiInstance,
} from "./model";

/** Per-view caches, keyed by node path and kept across re-renders: parsed markdown and rasterized figures. */
export class Surface {
	readonly #markdown = new Map<string, Markdown>();
	readonly #figures = new Map<string, Figure>();
	readonly #requestRender: () => void;
	readonly #budget: () => ImageBudget | undefined;

	constructor(requestRender: () => void, budget: () => ImageBudget | undefined) {
		this.#requestRender = requestRender;
		this.#budget = budget;
	}

	markdown(key: string, source: string): Markdown {
		const existing = this.#markdown.get(key);
		if (existing) {
			existing.setText(source);
			return existing;
		}
		const created = new Markdown(source, 0, 0, getMarkdownTheme(), undefined, 0);
		this.#markdown.set(key, created);
		return created;
	}

	figure(key: string): Figure {
		let figure = this.#figures.get(key);
		if (!figure) {
			figure = new Figure({ onChange: this.#requestRender, budget: this.#budget });
			this.#figures.set(key, figure);
		}
		return figure;
	}

	invalidate(): void {
		this.#markdown.clear();
		for (const figure of this.#figures.values()) figure.invalidate();
	}

	dispose(): void {
		for (const figure of this.#figures.values()) figure.dispose();
		this.#figures.clear();
		this.#markdown.clear();
	}
}

/** A clickable span: `click` receives the offset into it and its width. */
export interface Hit {
	readonly key: string;
	readonly line: number;
	readonly col0: number;
	readonly col1: number;
	readonly click: (offset: number, width: number) => void;
}

/** A focusable control at `line`; `handle` returns whether it consumed the key. */
export interface Control {
	readonly key: string;
	readonly line: number;
	readonly handle: (data: string) => boolean;
}

/** Rendered rows plus what sits where: controls, click targets, and the rows inline images occupy. */
export class Out {
	readonly lines: string[] = [];
	readonly hits: Hit[] = [];
	readonly controls: Control[] = [];
	readonly figures: [start: number, end: number][] = [];

	/** Append `child` below; its hits shift right by `col` and `wrap` decorates each of its rows. */
	embed(child: Out, col = 0, wrap?: (line: string) => string): void {
		const base = this.lines.length;
		for (const line of child.lines) this.lines.push(wrap ? wrap(line) : line);
		for (const hit of child.hits) {
			this.hits.push({ ...hit, line: hit.line + base, col0: hit.col0 + col, col1: hit.col1 + col });
		}
		for (const control of child.controls) this.controls.push({ ...control, line: control.line + base });
		for (const [start, end] of child.figures) this.figures.push([start + base, end + base]);
	}
}

export interface RenderEnv {
	readonly theme: Theme;
	readonly instance: UiInstance;
	readonly surface: Surface;
	/** Full-screen view: controls take focus and input. */
	readonly interactive: boolean;
	readonly focus: string | undefined;
	/** Arguments are still streaming: unfinished placeholders show `…`. */
	readonly partial: boolean;
	/** The terminal shows inline images, and the region may hold them (columns may not). */
	readonly images: boolean;
	/** Number fields being typed into, by path. */
	readonly drafts: Map<string, string>;
	readonly press: ((node: NodeSpec) => void) | undefined;
	/** Label column shared by a run of controls so their fields line up; 0 = own width. */
	readonly labelWidth: number;
}

const TONES: Readonly<Record<string, readonly [ThemeColor, string]>> = {
	info: ["accent", "ℹ"],
	tip: ["success", "✦"],
	success: ["success", "✔"],
	warning: ["warning", "⚠"],
	error: ["error", "✖"],
};

/** Controls stacked without a blank row between them. */
const TIGHT_TYPES: Readonly<Record<string, true>> = { ...CONTROL_TYPES, button: true };

function interp(env: RenderEnv, source: string): string {
	return interpolate(source, env.instance.scope(), env.partial);
}

/** `line` cut to `width` and padded to exactly that many columns. */
function padTo(line: string, width: number): string {
	const cut = truncateToWidth(line, width);
	return cut + padding(width - visibleWidth(cut));
}

/** Rows without leading or trailing blank ones. */
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && visibleWidth(lines[start]!) === 0) start++;
	while (end > start && visibleWidth(lines[end - 1]!) === 0) end--;
	return lines.slice(start, end);
}

function visible(env: RenderEnv, node: NodeSpec): boolean {
	const when = node.when;
	if (typeof when === "boolean") return when;
	if (typeof when !== "string") return true;
	try {
		return truthy(evaluate(when, env.instance.scope()));
	} catch {
		return false;
	}
}

function focused(env: RenderEnv, path: string): boolean {
	return env.interactive && env.focus === path;
}

/** The whole card: an optional title row, then its body. */
export function renderCard(env: RenderEnv, width: number, options: { readonly header: boolean }): Out {
	const out = new Out();
	const spec = env.instance.spec;
	const title = str(spec.title);
	if (options.header && title) {
		out.lines.push(truncateToWidth(`${env.theme.fg("accent", "◆ ")}${env.theme.bold(interp(env, title))}`, width));
		const subtitle = str(spec.subtitle);
		if (subtitle) {
			for (const line of wrapTextWithAnsi(interp(env, subtitle), Math.max(10, width - 2))) {
				out.lines.push(`  ${env.theme.fg("muted", line)}`);
			}
		}
		out.lines.push("");
	}
	renderNodes(env, spec.body, "", width, out);
	return out;
}

function renderNodes(env: RenderEnv, body: unknown, base: string, width: number, out: Out): void {
	const nodes = nodeList(body);
	const labelWidths = alignedLabelWidths(env, nodes, width);
	let previous: string | undefined;
	nodes.forEach((node, index) => {
		if (!visible(env, node)) return;
		const path = base ? `${base}.${index}` : String(index);
		const type = str(node.type) ?? "";
		const child = new Out();
		renderNode({ ...env, labelWidth: labelWidths[index] ?? 0 }, node, type, path, width, child);
		if (child.lines.length === 0) return;
		if (previous !== undefined && !(TIGHT_TYPES[previous] && TIGHT_TYPES[type])) out.lines.push("");
		out.embed(child);
		previous = type;
	});
}

/** One label width per run of consecutive labelled controls (the widest label, within 40% of the row). */
function alignedLabelWidths(env: RenderEnv, nodes: readonly NodeSpec[], width: number): number[] {
	const widths: number[] = [];
	let run: number[] = [];
	const close = (): void => {
		const widest = Math.max(0, ...run.map(index => visibleWidth(interp(env, str(nodes[index]!.label) ?? ""))));
		for (const index of run) widths[index] = Math.min(widest, Math.floor(width * 0.4));
		run = [];
	};
	nodes.forEach((node, index) => {
		const type = str(node.type);
		if (type === "slider" || type === "number" || type === "input" || type === "select") run.push(index);
		else if (visible(env, node)) close();
	});
	close();
	return widths;
}

function renderNode(env: RenderEnv, node: NodeSpec, type: string, path: string, width: number, out: Out): void {
	switch (type) {
		case "text":
			renderText(env, node, path, width, out);
			return;
		case "callout":
			renderCallout(env, node, path, width, out);
			return;
		case "stats":
			renderStats(env, node, width, out);
			return;
		case "table":
			renderTable(env, node, path, width, out);
			return;
		case "timeline":
			renderTimeline(env, node, width, out);
			return;
		case "progress":
			renderProgress(env, node, width, out);
			return;
		case "figure":
			renderFigure(env, node, path, width, out);
			return;
		case "chart":
			renderChart(env, node, path, width, out);
			return;
		case "divider":
			out.lines.push(env.theme.fg("borderMuted", "─".repeat(width)));
			return;
		case "card":
			renderBox(env, node, path, width, out);
			return;
		case "columns":
			renderColumns(env, node, path, width, out);
			return;
		case "tabs":
			renderTabs(env, node, path, width, out);
			return;
		case "slider":
			renderSlider(env, node, path, width, out);
			return;
		case "number":
			renderNumber(env, node, path, width, out);
			return;
		case "input":
			renderInput(env, node, path, width, out);
			return;
		case "select":
			renderSelect(env, node, path, width, out);
			return;
		case "toggle":
			renderToggle(env, node, path, width, out);
			return;
		case "button":
			renderButtons(env, [node], path, width, out, true);
			return;
		case "buttons":
			renderButtons(env, nodeList(node.items), path, width, out, false);
			return;
		default:
			// Unknown or still-streaming type: show its text if it has any, so content is never silently lost.
			if (!env.partial && typeof node.text === "string") renderText(env, node, path, width, out);
	}
}

// ── Content ──────────────────────────────────────────────────────────────────

function renderText(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const source = interp(env, str(node.text) ?? "");
	if (!source.trim()) return;
	out.lines.push(...trimBlank(env.surface.markdown(path, source).render(width)));
}

function renderCallout(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const [color, icon] = TONES[str(node.tone) ?? "info"] ?? TONES.info!;
	const bar = `${env.theme.fg(color, "▌")} `;
	const title = str(node.title);
	if (title) out.lines.push(truncateToWidth(`${bar}${env.theme.fg(color, `${icon} `)}${env.theme.bold(interp(env, title))}`, width));
	const body = str(node.text);
	if (!body?.trim()) return;
	const rows = trimBlank(env.surface.markdown(path, interp(env, body)).render(Math.max(10, width - 2)));
	rows.forEach((row, index) => {
		out.lines.push(!title && index === 0 ? `${bar}${env.theme.fg(color, `${icon} `)}${row}` : `${bar}${row}`);
	});
}

function renderStats(env: RenderEnv, node: NodeSpec, width: number, out: Out): void {
	const items = nodeList(node.items);
	if (items.length === 0) return;
	const gap = 2;
	const perRow = Math.max(1, Math.min(items.length, Math.floor((width + gap) / (18 + gap))));
	const tileWidth = Math.floor((width - gap * (perRow - 1)) / perRow);
	const tiles = items.map(item => {
		const [color] = TONES[str(item.tone) ?? ""] ?? (["accent"] as const);
		const bar = `${env.theme.fg(color, "▎")} `;
		const raw = item.value;
		const value = typeof raw === "number" ? formatNumber(raw) : interp(env, str(raw) ?? "");
		const unit = str(item.unit);
		const rows = [
			`${bar}${env.theme.fg("muted", interp(env, str(item.label) ?? ""))}`,
			`${bar}${env.theme.bold(env.theme.fg(color, value))}${unit ? env.theme.fg("muted", ` ${unit}`) : ""}`,
		];
		const note = str(item.note);
		if (note) rows.push(`${bar}${env.theme.fg("dim", interp(env, note))}`);
		return rows;
	});
	for (let start = 0; start < tiles.length; start += perRow) {
		const row = tiles.slice(start, start + perRow);
		const height = Math.max(...row.map(tile => tile.length));
		for (let line = 0; line < height; line++) {
			out.lines.push(row.map(tile => padTo(tile[line] ?? "", tileWidth)).join(padding(gap)));
		}
		if (start + perRow < tiles.length) out.lines.push("");
	}
}

function renderTable(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const cell = (value: unknown): string => {
		const content = typeof value === "number" ? formatNumber(value) : interp(env, str(value) ?? "");
		return content.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");
	};
	const rows = list(node.rows).map(row => list(row).map(cell));
	const header = list(node.columns).map(cell);
	const columns = Math.max(header.length, ...rows.map(row => row.length));
	if (columns === 0) return;
	const numeric = Array.from({ length: columns }, (_, at) =>
		rows.length > 0 && rows.every(row => row[at] === undefined || row[at] === "" || asNumber(row[at]!.replace(/^[^\d.+-]+|[^\d.]+$/g, "")) !== undefined),
	);
	const line = (cells: readonly string[]): string => `| ${Array.from({ length: columns }, (_, at) => cells[at] ?? "").join(" | ")} |`;
	const source = [
		line(header.length > 0 ? header : Array.from({ length: columns }, () => " ")),
		`|${numeric.map(right => (right ? " ---: " : " --- ")).join("|")}|`,
		...rows.map(line),
	].join("\n");
	out.lines.push(...trimBlank(env.surface.markdown(path, source).render(width)));
	const caption = str(node.caption);
	if (caption) out.lines.push(truncateToWidth(env.theme.fg("muted", env.theme.italic(interp(env, caption))), width));
}

function renderTimeline(env: RenderEnv, node: NodeSpec, width: number, out: Out): void {
	const items = nodeList(node.items);
	const times = items.map(item => interp(env, str(item.time) ?? ""));
	const timeWidth = Math.min(18, Math.max(0, ...times.map(time => visibleWidth(time))));
	const indent = 2 + (timeWidth > 0 ? timeWidth + 2 : 0);
	const room = Math.max(10, width - indent);
	items.forEach((item, index) => {
		const [color] = TONES[str(item.tone) ?? ""] ?? (["accent"] as const);
		const last = index === items.length - 1;
		const rail = last ? "  " : `${env.theme.fg("borderMuted", "│")} `;
		const time = timeWidth > 0 ? `${env.theme.bold(env.theme.fg(color, padTo(times[index]!, timeWidth)))}  ` : "";
		const titleRows = wrapTextWithAnsi(env.theme.bold(interp(env, str(item.title) ?? "")), room);
		titleRows.forEach((row, at) => {
			out.lines.push(at === 0 ? `${env.theme.fg(color, "●")} ${time}${row}` : `${rail}${padding(indent - 2)}${row}`);
		});
		const detail = str(item.text);
		if (detail) {
			for (const row of wrapTextWithAnsi(interp(env, detail), room)) out.lines.push(`${rail}${padding(indent - 2)}${row}`);
		}
		if (!last) out.lines.push(env.theme.fg("borderMuted", "│"));
	});
}

function renderProgress(env: RenderEnv, node: NodeSpec, width: number, out: Out): void {
	const read = (field: unknown, fallback: number): number => {
		if (typeof field === "number") return field;
		if (typeof field !== "string") return fallback;
		try {
			return asNumber(evaluate(field, env.instance.scope())) ?? fallback;
		} catch {
			return fallback;
		}
	};
	const value = read(node.value, 0);
	const max = read(node.max, 100);
	const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
	const [color] = TONES[str(node.tone) ?? ""] ?? (["accent"] as const);
	const label = interp(env, str(node.label) ?? "");
	const right = str(node.text) ? interp(env, str(node.text)!) : `${Math.round(ratio * 100)}%`;
	const labelWidth = label ? Math.min(visibleWidth(label), Math.floor(width * 0.4)) : 0;
	const barWidth = Math.max(8, Math.min(48, width - labelWidth - visibleWidth(right) - 4));
	const filled = Math.round(ratio * barWidth);
	const bar = env.theme.fg(color, "█".repeat(filled)) + env.theme.fg("borderMuted", "░".repeat(barWidth - filled));
	out.lines.push(truncateToWidth(`${label ? `${padTo(label, labelWidth)}  ` : ""}${bar}  ${env.theme.bold(right)}`, width));
}

function renderFigure(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const svg = str(node.svg) ?? "";
	const caption = str(node.caption);
	if (!svg.includes("<svg")) {
		if (env.partial) out.lines.push(env.theme.fg("dim", "▦ drawing…"));
		return;
	}
	if (!env.images) {
		out.lines.push(truncateToWidth(`${env.theme.fg("muted", "▦ ")}${env.theme.italic(interp(env, caption ?? str(node.alt) ?? "drawing"))}`, width));
		return;
	}
	let source = svg;
	const highlight = str(node.highlight);
	if (highlight) {
		const declared = list(node.parts).flatMap(part => str(part) ?? []);
		const parts =
			declared.length > 0
				? declared
				: (env.instance.inputs().get(highlight)?.options ?? []).map(option => display(option.value));
		const active = env.instance.get(highlight);
		source = highlightSvg(svg, parts, active === undefined || active === null ? undefined : display(active));
	}
	const figure = env.surface.figure(path);
	figure.update(source, !env.partial || /<\/svg>\s*$/i.test(svg));
	const start = out.lines.length;
	out.lines.push(...figure.render(width));
	out.figures.push([start, out.lines.length]);
	if (caption) {
		const shown = truncateToWidth(env.theme.fg("muted", env.theme.italic(interp(env, caption))), width);
		out.lines.push(padding(Math.max(0, Math.floor((width - visibleWidth(shown)) / 2))) + shown);
	}
}

function renderChart(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const data = chartData(node, env.instance, env.partial);
	if (!data) {
		if (env.partial) out.lines.push(env.theme.fg("dim", "▤ charting…"));
		return;
	}
	if (!env.images) {
		out.lines.push(...textChart(data, env.theme, width));
		return;
	}
	const figure = env.surface.figure(path);
	figure.update(chartSvg(data), true);
	const start = out.lines.length;
	out.lines.push(...figure.render(width));
	out.figures.push([start, out.lines.length]);
}

// ── Layout ───────────────────────────────────────────────────────────────────

function renderBox(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const innerWidth = width - 4;
	const inner = new Out();
	if (innerWidth < 12) {
		renderNodes(env, node.body, path, width, out);
		return;
	}
	renderNodes(env, node.body, path, innerWidth, inner);
	const border = (line: string): string => env.theme.fg("borderMuted", line);
	const title = str(node.title);
	const head = title
		? `${border("╭─ ")}${env.theme.bold(truncateToWidth(interp(env, title), width - 8))}${border(" ")}`
		: border("╭");
	out.lines.push(head + border(`${"─".repeat(Math.max(0, width - visibleWidth(head) - 1))}╮`));
	out.embed(inner, 2, line => `${border("│")} ${padTo(line, innerWidth)} ${border("│")}`);
	out.lines.push(border(`╰${"─".repeat(width - 2)}╯`));
}

function renderColumns(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const items = nodeList(node.items);
	if (items.length === 0) return;
	const gap = 3;
	const columnWidth = Math.floor((width - gap * (items.length - 1)) / items.length);
	if (columnWidth < 24 || items.length > 4) {
		renderNodes(env, node.items, path, width, out);
		return;
	}
	// Inline images cannot share rows; drawings inside columns show their captions instead.
	const narrow: RenderEnv = { ...env, images: false, labelWidth: 0 };
	const parts = items.map((item, index) => {
		const part = new Out();
		if (visible(env, item)) renderNode(narrow, item, str(item.type) ?? "", `${path}.${index}`, columnWidth, part);
		return part;
	});
	const base = out.lines.length;
	const height = Math.max(...parts.map(part => part.lines.length));
	for (let row = 0; row < height; row++) {
		out.lines.push(parts.map(part => padTo(part.lines[row] ?? "", columnWidth)).join(padding(gap)));
	}
	parts.forEach((part, index) => {
		const col = index * (columnWidth + gap);
		for (const hit of part.hits) out.hits.push({ ...hit, line: hit.line + base, col0: hit.col0 + col, col1: hit.col1 + col });
		for (const control of part.controls) out.controls.push({ ...control, line: control.line + base });
	});
}

function renderTabs(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const tabs = nodeList(node.tabs);
	if (tabs.length === 0) return;
	const id = inputId(node, path);
	const options = tabOptions(node);
	const active = Math.max(0, optionIndex(options, env.instance.get(id)));
	const isFocused = focused(env, path);
	const select = (index: number): void => env.instance.set(id, options[(index + options.length) % options.length]!.value);
	let line = "";
	let col = 0;
	const startLine = out.lines.length;
	options.forEach((option, index) => {
		const name = ` ${interp(env, option.label)} `;
		const nameWidth = visibleWidth(name);
		if (col > 0 && col + nameWidth > width) {
			out.lines.push(line);
			line = "";
			col = 0;
		}
		const styled =
			index === active
				? isFocused
					? env.theme.inverse(env.theme.bold(name))
					: env.theme.bg("selectedBg", env.theme.bold(env.theme.fg("accent", name)))
				: env.theme.fg("muted", name);
		out.hits.push({ key: path, line: out.lines.length, col0: col, col1: col + nameWidth, click: () => select(index) });
		line += `${styled} `;
		col += nameWidth + 1;
	});
	out.lines.push(line);
	out.lines.push(env.theme.fg("borderMuted", "─".repeat(width)));
	out.controls.push({
		key: path,
		line: startLine,
		handle: data => {
			if (matchesKey(data, "left")) select(active - 1);
			else if (matchesKey(data, "right") || matchesKey(data, "space") || matchesKey(data, "enter")) select(active + 1);
			else {
				const digit = Number(extractPrintableText(data));
				if (!Number.isInteger(digit) || digit < 1 || digit > options.length) return false;
				select(digit - 1);
			}
			return true;
		},
	});
	const body = new Out();
	renderNodes(env, tabs[active]!.body, `${path}.t${active}`, width, body);
	if (body.lines.length > 0) out.embed(body);
}

// ── Controls ─────────────────────────────────────────────────────────────────

interface ControlRow {
	/** Styled label, padded into the shared label column when the run has one. */
	readonly label: string;
	readonly labelWidth: number;
}

function controlLabel(env: RenderEnv, node: NodeSpec, path: string, id: string, width: number): ControlRow {
	const name = interp(env, str(node.label) ?? id);
	const labelWidth = env.labelWidth || Math.min(visibleWidth(name), Math.floor(width * 0.4));
	const styled = focused(env, path) ? env.theme.bold(env.theme.fg("accent", name)) : name;
	return { label: padTo(styled, labelWidth), labelWidth };
}

/** `prefix`, the number, and `unit`: symbols and CJK units attach (`5%`, `4段`), words get a space (`70 rpm`). */
function numberText(node: NodeSpec, value: number, digits: number | undefined): string {
	const unit = str(node.unit) ?? "";
	const spaced = /^[A-Za-z]/.test(unit);
	return `${str(node.prefix) ?? ""}${formatNumber(value, digits)}${spaced ? ` ${unit}` : unit}`;
}

/** Decimals a step implies: `0.25` → 2, `5` → 0. */
function stepDigits(step: number): number {
	if (!Number.isFinite(step) || Number.isInteger(step)) return 0;
	return Math.min(6, (String(step).split(".")[1] ?? "").length);
}

function renderSlider(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const id = inputId(node, path);
	const bounds = env.instance.numberBounds(node);
	const value = asNumber(env.instance.get(id) ?? null) ?? bounds.min;
	const digits = num(node.digits) ?? stepDigits(bounds.step);
	const valueText = env.theme.bold(numberText(node, value, digits));
	const { label, labelWidth } = controlLabel(env, node, path, id, width);
	const stacked = width < 46;
	const trackWidth = stacked
		? Math.max(8, width - 2)
		: Math.max(8, width - labelWidth - visibleWidth(valueText) - 4);
	const span = bounds.max - bounds.min;
	const ratio = Number.isFinite(span) && span > 0 ? Math.min(1, Math.max(0, (value - bounds.min) / span)) : 0;
	const knob = Math.round(ratio * (trackWidth - 1));
	const isFocused = focused(env, path);
	const track =
		env.theme.fg("accent", "━".repeat(knob)) +
		(isFocused ? env.theme.inverse(env.theme.fg("accent", "●")) : env.theme.fg("accent", "●")) +
		env.theme.fg("borderMuted", "─".repeat(trackWidth - knob - 1));
	let trackLine: number;
	let trackCol: number;
	if (stacked) {
		out.lines.push(`${label}  ${valueText}`);
		trackLine = out.lines.length;
		trackCol = 0;
		out.lines.push(track);
	} else {
		trackLine = out.lines.length;
		trackCol = labelWidth + 2;
		out.lines.push(`${label}  ${track}  ${valueText}`);
	}
	out.hits.push({
		key: path,
		line: trackLine,
		col0: trackCol,
		col1: trackCol + trackWidth,
		click: (offset, size) => env.instance.set(id, bounds.min + (offset / Math.max(1, size - 1)) * span),
	});
	out.controls.push({
		key: path,
		line: trackLine,
		handle: data => {
			const big = (Number.isFinite(span) ? span : bounds.step * 100) / 10;
			if (matchesKey(data, "left") || data === "-") env.instance.set(id, value - bounds.step);
			else if (matchesKey(data, "right") || data === "+" || data === "=") env.instance.set(id, value + bounds.step);
			else if (matchesKey(data, "shift+left")) env.instance.set(id, value - Math.max(bounds.step, big));
			else if (matchesKey(data, "shift+right")) env.instance.set(id, value + Math.max(bounds.step, big));
			else if (matchesKey(data, "home")) env.instance.set(id, bounds.min);
			else if (matchesKey(data, "end")) env.instance.set(id, bounds.max);
			else return false;
			return true;
		},
	});
}

function renderNumber(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const id = inputId(node, path);
	const bounds = env.instance.numberBounds(node);
	const value = asNumber(env.instance.get(id) ?? null) ?? 0;
	const draft = env.drafts.get(path);
	const isFocused = focused(env, path);
	const { label, labelWidth } = controlLabel(env, node, path, id, width);
	const content = draft !== undefined ? `${draft}▏` : numberText(node, value, num(node.digits) ?? stepDigits(bounds.step));
	const field = isFocused ? env.theme.inverse(` ${content} `) : env.theme.bg("selectedBg", ` ${content} `);
	const hint = isFocused ? env.theme.fg("dim", "  type a number · ←→ step") : "";
	const line = out.lines.length;
	out.lines.push(truncateToWidth(`${label}  ${field}${hint}`, width));
	out.hits.push({ key: path, line, col0: labelWidth + 2, col1: labelWidth + 2 + visibleWidth(field), click: () => {} });
	out.controls.push({
		key: path,
		line,
		handle: data => {
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				env.drafts.delete(path);
				env.instance.set(id, value + (matchesKey(data, "left") ? -bounds.step : bounds.step));
				return true;
			}
			if (matchesKey(data, "backspace")) {
				const next = (draft ?? String(value)).slice(0, -1);
				env.drafts.set(path, next);
				if (asNumber(next) !== undefined) env.instance.set(id, asNumber(next)!);
				return true;
			}
			if (matchesKey(data, "enter")) {
				env.drafts.delete(path);
				return true;
			}
			const typed = extractPrintableText(data);
			if (typed === undefined || !/^[\d.,-]+$/.test(typed)) return false;
			const next = (draft ?? "") + typed;
			env.drafts.set(path, next);
			const parsed = asNumber(next);
			if (parsed !== undefined) env.instance.set(id, parsed);
			return true;
		},
	});
}

function renderInput(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const id = inputId(node, path);
	const value = display(env.instance.get(id) ?? "");
	const isFocused = focused(env, path);
	const { label, labelWidth } = controlLabel(env, node, path, id, width);
	const fieldWidth = Math.max(10, Math.min(48, width - labelWidth - 4));
	const placeholder = str(node.placeholder);
	const content = isFocused
		? `${value}▏`
		: value || (placeholder ? env.theme.fg("dim", interp(env, placeholder)) : "");
	// A focused field shows the end of its text, where typing happens.
	const overflow = visibleWidth(content) - (fieldWidth - 2);
	const shown = isFocused && overflow > 0 ? sliceWithWidth(content, overflow, fieldWidth - 2).text : content;
	const inner = ` ${padTo(shown, fieldWidth - 2)} `;
	const field = isFocused ? env.theme.inverse(inner) : env.theme.bg("selectedBg", inner);
	const line = out.lines.length;
	out.lines.push(`${label}  ${field}`);
	out.hits.push({ key: path, line, col0: labelWidth + 2, col1: labelWidth + 2 + fieldWidth, click: () => {} });
	out.controls.push({
		key: path,
		line,
		handle: data => {
			if (matchesKey(data, "backspace")) {
				env.instance.set(id, Array.from(value).slice(0, -1).join(""));
				return true;
			}
			if (matchesKey(data, "ctrl+u")) {
				env.instance.set(id, "");
				return true;
			}
			const typed = extractPrintableText(data);
			if (typed === undefined) return false;
			env.instance.set(id, value + typed);
			return true;
		},
	});
}

function cycle(env: RenderEnv, id: string, options: readonly Option[], current: number, delta: number): void {
	if (options.length === 0) return;
	env.instance.set(id, options[(Math.max(0, current) + delta + options.length) % options.length]!.value);
}

function renderSelect(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const id = inputId(node, path);
	const options = env.instance.inputs().get(id)?.options ?? [];
	if (options.length === 0) return;
	const active = optionIndex(options, env.instance.get(id));
	const isFocused = focused(env, path);
	const { label, labelWidth } = controlLabel(env, node, path, id, width);
	const names = options.map(option => ` ${interp(env, option.label)} `);
	const segmented = names.reduce((total, name) => total + visibleWidth(name) + 1, 0) - 1;
	const line = out.lines.length;
	let col = labelWidth + 2;
	let row = `${label}  `;
	if (labelWidth + 2 + segmented <= width) {
		names.forEach((name, index) => {
			const chosen = index === active;
			const styled = chosen
				? isFocused
					? env.theme.inverse(env.theme.bold(name))
					: env.theme.bg("selectedBg", env.theme.bold(env.theme.fg("accent", name)))
				: env.theme.fg("muted", name);
			out.hits.push({ key: path, line, col0: col, col1: col + visibleWidth(name), click: () => env.instance.set(id, options[index]!.value) });
			row += index === 0 ? styled : env.theme.fg("borderMuted", "│") + styled;
			col += visibleWidth(name) + 1;
		});
	} else {
		const current = ` ‹ ${interp(env, options[Math.max(0, active)]!.label)} › `;
		const styled = isFocused ? env.theme.inverse(current) : env.theme.bg("selectedBg", env.theme.fg("accent", current));
		out.hits.push({
			key: path,
			line,
			col0: col,
			col1: col + visibleWidth(current),
			click: (offset, size) => cycle(env, id, options, active, offset < size / 2 ? -1 : 1),
		});
		row += styled;
	}
	out.lines.push(truncateToWidth(row, width));
	out.controls.push({
		key: path,
		line,
		handle: data => {
			if (matchesKey(data, "left")) cycle(env, id, options, active, -1);
			else if (matchesKey(data, "right") || matchesKey(data, "space") || matchesKey(data, "enter")) cycle(env, id, options, active, 1);
			else {
				const digit = Number(extractPrintableText(data));
				if (!Number.isInteger(digit) || digit < 1 || digit > options.length) return false;
				env.instance.set(id, options[digit - 1]!.value);
			}
			return true;
		},
	});
}

function renderToggle(env: RenderEnv, node: NodeSpec, path: string, width: number, out: Out): void {
	const id = inputId(node, path);
	const on = truthy(env.instance.get(id));
	const isFocused = focused(env, path);
	const box = on ? env.theme.fg("success", "[✓]") : env.theme.fg("muted", "[ ]");
	const name = interp(env, str(node.label) ?? id);
	const line = out.lines.length;
	out.lines.push(truncateToWidth(`${isFocused ? env.theme.inverse(box) : box} ${isFocused ? env.theme.bold(env.theme.fg("accent", name)) : name}`, width));
	out.hits.push({
		key: path,
		line,
		col0: 0,
		col1: Math.min(width, 4 + visibleWidth(name)),
		click: () => env.instance.set(id, !on),
	});
	out.controls.push({
		key: path,
		line,
		handle: data => {
			if (!(matchesKey(data, "space") || matchesKey(data, "enter"))) return false;
			env.instance.set(id, !on);
			return true;
		},
	});
}

/** One button, or a `buttons` row; each wraps to a new line when the row is full. */
function renderButtons(env: RenderEnv, items: readonly NodeSpec[], path: string, width: number, out: Out, single: boolean): void {
	let line = "";
	let col = 0;
	items.forEach((item, index) => {
		if (!visible(env, item)) return;
		const key = single ? path : `${path}.${index}`;
		const isFocused = focused(env, key);
		const sends = typeof item.send === "string";
		const name = `[ ${interp(env, str(item.label) ?? "Button")}${sends ? " ↗" : ""} ]`;
		const nameWidth = visibleWidth(name);
		const primary = item.primary === true || item.style === "primary";
		const styled = isFocused
			? env.theme.inverse(env.theme.bold(name))
			: primary
				? env.theme.bold(env.theme.fg("accent", name))
				: env.theme.fg("text", name);
		if (col > 0 && col + nameWidth > width) {
			out.lines.push(line);
			line = "";
			col = 0;
		}
		const row = out.lines.length;
		out.hits.push({ key, line: row, col0: col, col1: col + nameWidth, click: () => env.press?.(item) });
		out.controls.push({
			key,
			line: row,
			handle: data => {
				if (!(matchesKey(data, "enter") || matchesKey(data, "space"))) return false;
				env.press?.(item);
				return true;
			},
		});
		line += `${styled}  `;
		col += nameWidth + 2;
	});
	if (line) out.lines.push(line);
}
