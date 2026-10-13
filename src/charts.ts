/**
 * `chart` nodes: data read from a table, from labelled series, or generated
 * from expressions over the card's live state; drawn as theme-token SVG
 * (rasterized like any figure) or, without inline images, as text bars and
 * sparklines.
 */
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { asNumber, evaluate, formatNumber, interpolate, text, toNumber, type Value } from "./expr";
import { FIGURE_FONTS } from "./figures";
import { list, type NodeSpec, nodeList, record, str, type UiInstance } from "./model";

export type ChartKind = "bar" | "column" | "line" | "area" | "pie";

export interface ChartSeries {
	readonly name: string;
	readonly values: readonly (number | null)[];
}

export interface ChartData {
	readonly kind: ChartKind;
	readonly title: string | undefined;
	readonly labels: readonly string[];
	readonly series: readonly ChartSeries[];
}

/** Most points a generated series samples. */
const MAX_POINTS = 240;
const KINDS: Readonly<Record<string, ChartKind>> = {
	bar: "bar",
	bars: "bar",
	column: "column",
	columns: "column",
	line: "line",
	area: "area",
	pie: "pie",
	donut: "pie",
};

/** `"¥1,200"`, `"45%"`, `"3.5 kg"` → their number; non-numbers → null. */
function looseNumber(value: unknown, interpolateText: (source: string) => string): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const cleaned = interpolateText(value)
		.replace(/[,\s]/g, "")
		.replace(/^[^\d.+-]+/, "")
		.replace(/[^\d.eE+-]+$/, "");
	return asNumber(cleaned) ?? null;
}

/** The chart a node describes against the card's current state, or undefined while it has no data. */
export function chartData(node: NodeSpec, instance: UiInstance, partial: boolean): ChartData | undefined {
	const scope = instance.scope();
	const fill = (source: string): string => interpolate(source, scope, partial);
	const cellText = (value: unknown): string => (typeof value === "string" ? fill(value) : text(value as Value));
	let labels: string[] = [];
	let series: ChartSeries[] = [];
	let generated = false;

	const x = record(node.x);
	if (Array.isArray(node.rows)) {
		const headings = list(node.columns).map(column => cellText(column));
		const rows = list(node.rows).map(row => list(row));
		const width = Math.max(headings.length, ...rows.map(row => row.length));
		labels = rows.map(row => cellText(row[0]));
		series = Array.from({ length: Math.max(0, width - 1) }, (_, at) => ({
			name: headings[at + 1] || `Series ${at + 1}`,
			values: rows.map(row => looseNumber(row[at + 1], fill)),
		}));
	} else if (x && Array.isArray(node.series)) {
		generated = true;
		const bound = (field: unknown): number | undefined => {
			try {
				return typeof field === "string" ? toNumber(evaluate(field, scope)) : asNumber(field as Value);
			} catch {
				return undefined;
			}
		};
		const from = bound(x.from) ?? 0;
		const to = bound(x.to) ?? from;
		const span = Math.abs(to - from);
		const step = Math.abs(bound(x.step) ?? 0) || (span <= 60 ? 1 : span / 60);
		const direction = to >= from ? 1 : -1;
		const xs: number[] = [];
		for (let at = 0; at < MAX_POINTS && at * step <= span + step * 1e-9; at++) {
			xs.push(Number((from + direction * at * step).toPrecision(12)));
		}
		const name = str(x.name)?.trim() || "x";
		labels = xs.map(value => text(value));
		series = nodeList(node.series).map((entry, at) => {
			const expression = str(entry.expr);
			const fixed = list(entry.values);
			return {
				name: cellText(entry.name ?? `Series ${at + 1}`),
				values: xs.map((value, index) => {
					if (!expression) return looseNumber(fixed[index], fill);
					try {
						return asNumber(evaluate(expression, instance.scope({ x: value, [name]: value }))) ?? null;
					} catch {
						return null;
					}
				}),
			};
		});
	} else if (Array.isArray(node.series)) {
		labels = list(node.labels).map(value => cellText(value));
		series = nodeList(node.series).map((entry, at) => ({
			name: cellText(entry.name ?? `Series ${at + 1}`),
			values: list(entry.values ?? entry.data).map(value => looseNumber(value, fill)),
		}));
		const longest = Math.max(0, ...series.map(entry => entry.values.length));
		while (labels.length < longest) labels.push(String(labels.length + 1));
	}

	series = series.filter(entry => entry.values.some(value => value !== null));
	if (labels.length === 0 || series.length === 0) return undefined;
	const requested = KINDS[str(node.kind)?.toLowerCase() ?? ""];
	const kind = requested ?? (generated || labels.length > 12 ? "line" : "bar");
	return { kind, title: str(node.title) ? fill(str(node.title)!) : undefined, labels, series };
}

// ── SVG ──────────────────────────────────────────────────────────────────────

const WIDTH = 720;
const PAD = 16;
const LABEL_SIZE = 13;
const TICK_SIZE = 11;
const PLOT_HEIGHT = 220;
const XML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** Estimated width of `value` set at `size` in a UI sans; wide (CJK) glyphs take a full em. */
function measure(value: string, size: number): number {
	let em = 0;
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000)) {
			em += 1;
		} else if ("il.,:;'|!()[] ".includes(char)) em += 0.3;
		else if ("mwMW%@".includes(char)) em += 0.85;
		else em += 0.56;
	}
	return em * size;
}

/** `value` cut with an ellipsis to fit `width` at `size`. */
function clip(value: string, width: number, size: number): string {
	if (measure(value, size) <= width) return value;
	const chars = Array.from(value);
	while (chars.length > 1 && measure(`${chars.join("")}…`, size) > width) chars.pop();
	return `${chars.join("")}…`;
}

/** `1234567` → `1.2M`, `85000` → `85k`, `0.125` → `0.13`; below ten thousand stays whole (`8,000`). */
function compact(value: number): string {
	const magnitude = Math.abs(value);
	for (const [threshold, unit, suffix] of [
		[1e12, 1e12, "T"],
		[1e9, 1e9, "B"],
		[1e6, 1e6, "M"],
		[1e4, 1e3, "k"],
	] as const) {
		if (magnitude >= threshold) return `${Number((value / unit).toFixed(magnitude / unit >= 100 ? 0 : 1))}${suffix}`;
	}
	return formatNumber(value);
}

interface Ticks {
	readonly min: number;
	readonly max: number;
	readonly values: readonly number[];
}

/** About `count` round ticks (1, 2 or 5 times a power of ten) spanning `lo`…`hi`. */
function niceTicks(lo: number, hi: number, count = 5): Ticks {
	if (lo === hi) {
		const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
		return niceTicks(lo - (lo < 0 ? pad : 0), hi + (hi > 0 || lo === 0 ? pad : 0), count);
	}
	const raw = (hi - lo) / count;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = (raw / power >= 5 ? 10 : raw / power >= 2 ? 5 : raw / power >= 1 ? 2 : 1) * power;
	const min = Math.floor(lo / step) * step;
	const max = Math.ceil(hi / step) * step;
	const values: number[] = [];
	for (let value = min; value <= max + step / 2; value += step) values.push(Number(value.toPrecision(12)));
	return { min, max, values };
}

interface TextStyle {
	readonly size?: number;
	readonly fill?: string;
	readonly anchor?: "start" | "middle" | "end";
	readonly weight?: number;
}

function label(x: number, y: number, content: string, style: TextStyle = {}): string {
	const anchor = style.anchor && style.anchor !== "start" ? ` text-anchor="${style.anchor}"` : "";
	const weight = style.weight ? ` font-weight="${style.weight}"` : "";
	const escaped = content.replace(/[&<>"]/g, char => XML_ESCAPES[char]!);
	return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${style.size ?? LABEL_SIZE}" fill="var(--${style.fill ?? "fg"})"${anchor}${weight}>${escaped}</text>`;
}

function seriesColor(at: number): string {
	return `var(--c${(at % 6) + 1})`;
}

interface Layer {
	readonly svg: string;
	readonly height: number;
}

/** Title and, for several series, a wrapping legend of colored dots. */
function header(data: ChartData, legendNames: readonly string[]): Layer {
	let y = PAD;
	let svg = "";
	if (data.title) {
		svg += label(PAD, y + 12, clip(data.title, WIDTH - PAD * 2, 15), { size: 15, weight: 600 });
		y += 26;
	}
	if (legendNames.length > 1) {
		let x = PAD;
		legendNames.forEach((name, at) => {
			const shown = clip(name, 220, TICK_SIZE + 1);
			const width = 14 + measure(shown, TICK_SIZE + 1) + 18;
			if (x + width > WIDTH - PAD && x > PAD) {
				x = PAD;
				y += 18;
			}
			svg += `<circle cx="${x + 5}" cy="${y + 6}" r="5" fill="${seriesColor(at)}"/>`;
			svg += label(x + 15, y + 10, shown, { size: TICK_SIZE + 1, fill: "muted" });
			x += width;
		});
		y += 24;
	}
	return { svg, height: y };
}

function document(height: number, body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${Math.ceil(height)}" font-family="${FIGURE_FONTS}">${body}</svg>`;
}

function finiteValues(data: ChartData): number[] {
	return data.series.flatMap(entry => entry.values.filter((value): value is number => value !== null));
}

/** Categories down, values across: grouped bars per category, each labelled at its end. */
function drawBars(data: ChartData): string {
	const head = header(data, data.series.map(entry => entry.name));
	const values = finiteValues(data);
	const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
	const labelWidth = Math.min(230, Math.max(40, ...data.labels.map(name => measure(name, LABEL_SIZE))) + 14);
	const valueRoom = Math.max(...values.map(value => measure(compact(value), TICK_SIZE))) + 12;
	const left = PAD + labelWidth;
	const right = WIDTH - PAD - valueRoom;
	const scale = (value: number): number => left + ((value - ticks.min) / (ticks.max - ticks.min)) * (right - left);
	const count = data.series.length;
	const barHeight = count === 1 ? 16 : Math.max(6, Math.min(12, Math.floor(32 / count)));
	const rowHeight = count === 1 ? 28 : count * (barHeight + 3) + 12;
	const top = head.height + 4;
	const bottom = top + data.labels.length * rowHeight;
	let svg = head.svg;
	for (const tick of ticks.values) {
		const x = scale(tick);
		svg += `<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${bottom}" stroke="var(--border)" stroke-width="1" stroke-opacity="${tick === 0 ? 1 : 0.5}"/>`;
		svg += label(x, bottom + 15, compact(tick), { size: TICK_SIZE, fill: "muted", anchor: "middle" });
	}
	const zero = scale(Math.max(ticks.min, Math.min(ticks.max, 0)));
	data.labels.forEach((name, row) => {
		const rowTop = top + row * rowHeight;
		svg += label(left - 10, rowTop + rowHeight / 2 + 4.5, clip(name, labelWidth - 14, LABEL_SIZE), { anchor: "end" });
		data.series.forEach((entry, at) => {
			const value = entry.values[row];
			if (value === null || value === undefined) return;
			const y = count === 1 ? rowTop + (rowHeight - barHeight) / 2 : rowTop + 6 + at * (barHeight + 3);
			const end = scale(value);
			const x = Math.min(zero, end);
			const width = Math.max(2, Math.abs(end - zero));
			svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${barHeight}" rx="3" fill="${seriesColor(at)}"/>`;
			svg += label(Math.max(zero, end) + 6, y + barHeight / 2 + 4, compact(value), { size: TICK_SIZE, fill: "muted" });
		});
	});
	return document(bottom + 26, svg);
}

/** Shared frame of column and line charts: value ticks on the left, category labels below. */
function verticalFrame(
	data: ChartData,
	values: readonly number[],
	includeZero: boolean,
): { svg: string; left: number; right: number; top: number; bottom: number; y: (value: number) => number; height: number } {
	const head = header(data, data.series.map(entry => entry.name));
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const ticks = niceTicks(includeZero ? Math.min(0, lo) : lo, includeZero ? Math.max(0, hi) : hi);
	const axisWidth = Math.max(...ticks.values.map(tick => measure(compact(tick), TICK_SIZE))) + 10;
	const left = PAD + axisWidth;
	const right = WIDTH - PAD - 8;
	const top = head.height + 8;
	const bottom = top + PLOT_HEIGHT;
	const y = (value: number): number => bottom - ((value - ticks.min) / (ticks.max - ticks.min)) * (bottom - top);
	let svg = head.svg;
	for (const tick of ticks.values) {
		const at = y(tick);
		svg += `<line x1="${left}" y1="${at.toFixed(1)}" x2="${right}" y2="${at.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-opacity="${tick === 0 ? 1 : 0.5}"/>`;
		svg += label(left - 8, at + 4, compact(tick), { size: TICK_SIZE, fill: "muted", anchor: "end" });
	}
	return { svg, left, right, top, bottom, y, height: bottom + 30 };
}

/** Category labels under the plot, thinned to every k-th when they would collide. */
function categoryLabels(data: ChartData, xAt: (index: number) => number, slot: number, bottom: number): string {
	const widest = Math.max(...data.labels.map(name => measure(name, TICK_SIZE)));
	const every = Math.max(1, Math.ceil((Math.min(widest, 140) + 8) / Math.max(1, slot)));
	let svg = "";
	data.labels.forEach((name, index) => {
		const last = index === data.labels.length - 1;
		if (index % every !== 0 && !(last && index % every >= every / 2)) return;
		svg += label(xAt(index), bottom + 16, clip(name, Math.max(slot * every - 6, 30), TICK_SIZE), {
			size: TICK_SIZE,
			fill: "muted",
			anchor: "middle",
		});
	});
	return svg;
}

function drawColumns(data: ChartData): string {
	const values = finiteValues(data);
	const frame = verticalFrame(data, values, true);
	const band = (frame.right - frame.left) / data.labels.length;
	const count = data.series.length;
	const barWidth = Math.max(2, Math.min(36, (band * 0.72) / count));
	const zero = frame.y(Math.max(Math.min(0, Math.max(...values)), Math.min(...values, 0)));
	let svg = frame.svg;
	const labelled = data.labels.length * count <= 24;
	data.labels.forEach((_, index) => {
		const start = frame.left + index * band + (band - barWidth * count) / 2;
		data.series.forEach((entry, at) => {
			const value = entry.values[index];
			if (value === null || value === undefined) return;
			const end = frame.y(value);
			const x = start + at * barWidth;
			svg += `<rect x="${(x + 1).toFixed(1)}" y="${Math.min(zero, end).toFixed(1)}" width="${(barWidth - 2).toFixed(1)}" height="${Math.max(2, Math.abs(zero - end)).toFixed(1)}" rx="3" fill="${seriesColor(at)}"/>`;
			if (labelled) {
				svg += label(x + barWidth / 2, Math.min(zero, end) - 5, compact(value), { size: TICK_SIZE - 1, fill: "muted", anchor: "middle" });
			}
		});
	});
	svg += categoryLabels(data, index => frame.left + (index + 0.5) * band, band, frame.bottom);
	return document(frame.height, svg);
}

function drawLines(data: ChartData): string {
	const values = finiteValues(data);
	const area = data.kind === "area";
	const frame = verticalFrame(data, values, area || Math.min(...values) >= 0);
	const count = data.labels.length;
	const step = count > 1 ? (frame.right - frame.left) / (count - 1) : 0;
	const xAt = (index: number): number => (count > 1 ? frame.left + index * step : (frame.left + frame.right) / 2);
	let svg = frame.svg;
	const baseline = frame.y(Math.max(Math.min(0, Math.max(...values)), Math.min(...values, 0)));
	data.series.forEach((entry, at) => {
		const color = seriesColor(at);
		const runs: [number, number][][] = [[]];
		entry.values.forEach((value, index) => {
			if (value === null || value === undefined) {
				if (runs.at(-1)!.length > 0) runs.push([]);
				return;
			}
			runs.at(-1)!.push([xAt(index), frame.y(value)]);
		});
		for (const run of runs) {
			if (run.length === 0) continue;
			const path = run.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
			if (area && run.length > 1) {
				svg += `<path d="${path} L${run.at(-1)![0].toFixed(1)},${baseline.toFixed(1)} L${run[0]![0].toFixed(1)},${baseline.toFixed(1)} Z" fill="${color}" fill-opacity="0.18"/>`;
			}
			svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
			if (count <= 24) for (const [x, y] of run) svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`;
		}
		const lastIndex = entry.values.findLastIndex(value => value !== null);
		if (lastIndex >= 0) {
			const value = entry.values[lastIndex]!;
			const x = xAt(lastIndex);
			const anchor = x > frame.right - 60 ? "end" : "start";
			svg += label(anchor === "end" ? x - 6 : x + 6, frame.y(value) - 7, compact(value), { size: TICK_SIZE, fill: `c${(at % 6) + 1}`, anchor, weight: 600 });
		}
	});
	svg += categoryLabels(data, xAt, count > 1 ? step : frame.right - frame.left, frame.bottom);
	return document(frame.height, svg);
}

function drawDonut(data: ChartData): string {
	const entry = data.series[0]!;
	const slices = data.labels
		.map((name, index) => ({ name, value: entry.values[index] ?? 0 }))
		.filter(slice => slice.value > 0);
	const total = slices.reduce((sum, slice) => sum + slice.value, 0);
	const head = header(data, []);
	const radius = 96;
	const inner = 56;
	const cx = PAD + radius + 4;
	const cy = head.height + radius + 6;
	let svg = head.svg;
	let angle = -Math.PI / 2;
	slices.forEach((slice, at) => {
		const sweep = (slice.value / total) * Math.PI * 2;
		const end = angle + sweep;
		const point = (r: number, theta: number): string => `${(cx + r * Math.cos(theta)).toFixed(2)},${(cy + r * Math.sin(theta)).toFixed(2)}`;
		const large = sweep > Math.PI ? 1 : 0;
		const path =
			sweep >= Math.PI * 2 - 1e-6
				? `M${point(radius, angle)} A${radius},${radius} 0 1 1 ${point(radius, angle + Math.PI)} A${radius},${radius} 0 1 1 ${point(radius, angle)} Z M${point(inner, angle)} A${inner},${inner} 0 1 0 ${point(inner, angle + Math.PI)} A${inner},${inner} 0 1 0 ${point(inner, angle)} Z`
				: `M${point(radius, angle)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, angle)} Z`;
		svg += `<path d="${path}" fill="${seriesColor(at)}" fill-rule="evenodd" fill-opacity="${at >= 6 ? 0.6 : 1}" stroke="var(--surface)" stroke-width="1.5"/>`;
		angle = end;
	});
	svg += label(cx, cy + 6, compact(total), { size: 18, weight: 600, anchor: "middle" });
	const legendLeft = cx + radius + 36;
	const rowHeight = 22;
	const legendTop = cy - Math.min(slices.length, 9) * (rowHeight / 2);
	slices.forEach((slice, at) => {
		const y = legendTop + at * rowHeight;
		svg += `<circle cx="${legendLeft + 5}" cy="${(y + 7).toFixed(1)}" r="5" fill="${seriesColor(at)}" fill-opacity="${at >= 6 ? 0.6 : 1}"/>`;
		svg += label(legendLeft + 16, y + 11, clip(slice.name, WIDTH - legendLeft - 150, LABEL_SIZE));
		svg += label(WIDTH - PAD, y + 11, `${compact(slice.value)}  ${((slice.value / total) * 100).toFixed(1)}%`, { size: TICK_SIZE + 1, fill: "muted", anchor: "end" });
	});
	const height = Math.max(cy + radius + PAD, legendTop + slices.length * rowHeight + PAD);
	return document(height, svg);
}

/** The chart as a standalone SVG colored only with figure tokens. */
export function chartSvg(data: ChartData): string {
	switch (data.kind) {
		case "line":
		case "area":
			return drawLines(data);
		case "column":
			return drawColumns(data);
		case "pie":
			return data.series[0]!.values.some(value => (value ?? 0) > 0) ? drawDonut(data) : drawBars(data);
		case "bar":
			return drawBars(data);
	}
}

// ── Text fallback ────────────────────────────────────────────────────────────

const TEXT_SERIES_COLORS: readonly ThemeColor[] = ["accent", "success", "warning", "error", "mdLink", "muted"];
const SPARKS = "▁▂▃▄▅▆▇█";
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** The chart for terminals without inline images: sparklines for trends, bars otherwise. */
export function textChart(data: ChartData, theme: Theme, width: number): string[] {
	const out: string[] = [];
	if (data.title) out.push(truncateToWidth(theme.bold(data.title), width));
	const color = (at: number, value: string): string => theme.fg(TEXT_SERIES_COLORS[at % TEXT_SERIES_COLORS.length]!, value);
	if (data.kind === "line" || data.kind === "area") {
		const nameWidth = Math.min(20, Math.max(...data.series.map(entry => visibleWidth(entry.name))));
		const room = Math.max(8, width - nameWidth - 14);
		for (const [at, entry] of data.series.entries()) {
			const sampled = Array.from({ length: Math.min(room, entry.values.length) }, (_, index) => {
				return entry.values[Math.floor((index * entry.values.length) / Math.min(room, entry.values.length))] ?? null;
			});
			const finite = sampled.filter((value): value is number => value !== null);
			const lo = Math.min(...finite);
			const hi = Math.max(...finite);
			const spark = sampled
				.map(value => (value === null ? " " : SPARKS[hi === lo ? 3 : Math.round(((value - lo) / (hi - lo)) * 7)]))
				.join("");
			const last = entry.values.findLast(value => value !== null);
			const name = truncateToWidth(entry.name, nameWidth);
			out.push(`${name}${padding(nameWidth - visibleWidth(name))} ${color(at, spark)} ${last === undefined || last === null ? "" : formatNumber(last)}`);
		}
		out.push(theme.fg("dim", `${data.labels[0]} → ${data.labels.at(-1)}`));
		return out;
	}
	const values = finiteValues(data);
	const peak = Math.max(...values.map(Math.abs), 1e-12);
	const labelWidth = Math.min(Math.floor(width * 0.3), Math.max(...data.labels.map(visibleWidth)));
	const valueWidth = Math.max(...values.map(value => formatNumber(value).length));
	const barRoom = Math.max(6, width - labelWidth - valueWidth - 3);
	data.labels.forEach((name, index) => {
		data.series.forEach((entry, at) => {
			const value = entry.values[index];
			if (value === null || value === undefined) return;
			const cells = (Math.abs(value) / peak) * barRoom;
			const bar = "█".repeat(Math.floor(cells)) + EIGHTHS[Math.round((cells % 1) * 7)];
			const shown = at === 0 ? truncateToWidth(name, labelWidth) : "";
			out.push(`${shown}${padding(labelWidth - visibleWidth(shown))} ${color(at, bar || "▏")} ${formatNumber(value)}`);
		});
	});
	if (data.series.length > 1) {
		out.push(data.series.map((entry, at) => `${color(at, "■")} ${entry.name}`).join("  "));
	}
	return out;
}
