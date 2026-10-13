/**
 * SVG drawings as inline terminal images.
 *
 * Mirrors omp's own ```svg figures (pi-tui `chat/svg-figure`), which an
 * extension cannot import from the bundled host: a streaming source is
 * repaired into a parseable document, theme tokens (`var(--accent)`) are
 * resolved against the live theme, the native rasterizer draws it at one
 * terminal row per 16 SVG units, and pi-tui's `Image` places it through the
 * terminal's graphics protocol under the host's image budget.
 */
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import {
	type Component,
	getCellDimensions,
	getImageDimensions,
	getThemeEpoch,
	Image,
	type ImageBudget,
	imageMaxColumns,
	theme,
} from "@oh-my-pi/pi-tui";
import { hexToOklch, hueDistance, oklchCusp, oklchToHex } from "@oh-my-pi/pi-utils";

/** Japanese faces before the generic one: the rasterizer's `sans-serif` has no CJK glyphs. */
export const FIGURE_FONTS =
	"-apple-system, 'SF Pro Text', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans CJK JP', 'Noto Sans JP', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** SVG user units per terminal row: `font-size="14"` lands near the terminal's own glyphs. */
const UNITS_PER_ROW = 16;
/** Least time between rasters of a source that is still streaming. */
const STREAM_INTERVAL_MS = 200;
/** The native rasterizer caps the surface at 4096² pixels. */
const MAX_EDGE_PX = 4096;
/** Share of the terminal's rows one figure may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.75;

/** Theme colors behind the figure tokens; `surface` is the selection background, `c1`…`c6` the series colors. */
const TOKEN_COLORS = {
	fg: "text",
	muted: "muted",
	border: "borderMuted",
	accent: "accent",
	success: "success",
	warning: "warning",
	error: "error",
} as const;
/** Hue families (OKLCH degrees) series colors draw from: blue, orange, green, purple, pink, teal. */
const SERIES_HUES = [255, 55, 145, 305, 0, 200];
const RESERVE_HUE = 90;
const MIN_SERIES_HUE_GAP = 30;
const MIN_ACCENT_CHROMA = 0.04;
const SERIES_LIGHTNESS = { light: [0.52, 0.66], dark: [0.68, 0.82] } as const;
const SERIES_CHROMA = 0.19;

/**
 * The live theme's color per figure token. Series colors follow omp's
 * figures: led by the accent's hue, each next hue the family farthest from
 * those taken, at its gamut cusp clamped into a lightness band.
 */
export function figurePalette(): Record<string, string> {
	const palette: Record<string, string> = { surface: theme.getBgHex("selectedBg") };
	for (const [token, color] of Object.entries(TOKEN_COLORS)) palette[token] = theme.getColorHex(color);
	const { c, h } = hexToOklch(palette.accent!);
	const lead = c >= MIN_ACCENT_CHROMA ? h : SERIES_HUES[0]!;
	const hues = [lead];
	const pool = SERIES_HUES.filter(hue => hueDistance(hue, lead) >= MIN_SERIES_HUE_GAP);
	while (pool.length > 0) {
		const gaps = pool.map(hue => Math.min(...hues.map(taken => hueDistance(hue, taken))));
		hues.push(pool.splice(gaps.indexOf(Math.max(...gaps)), 1)[0]!);
	}
	if (hues.length < 6) hues.push(RESERVE_HUE);
	const [low, high] = SERIES_LIGHTNESS[theme.isLight ? "light" : "dark"];
	hues.slice(0, 6).forEach((hue, at) => {
		const cusp = oklchCusp(hue);
		palette[`c${at + 1}`] = oklchToHex({ l: Math.min(high, Math.max(low, cusp.l)), c: Math.min(SERIES_CHROMA, cusp.c), h: hue });
	});
	return palette;
}

/** Index just past the markup construct starting at `<` (`lt`), or -1 while it is incomplete. */
function constructEnd(source: string, lt: number): number {
	for (const [open, close] of [
		["<!--", "-->"],
		["<![CDATA[", "]]>"],
		["<?", "?>"],
	] as const) {
		if (!source.startsWith(open, lt)) continue;
		const at = source.indexOf(close, lt + open.length);
		return at < 0 ? -1 : at + close.length;
	}
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[" && source[lt + 1] === "!") {
			subset = true;
		} else if (char === "]") {
			subset = false;
		} else if (char === ">" && !subset) {
			return at + 1;
		}
	}
	return -1;
}

/**
 * A well-formed document from a possibly truncated SVG source: the construct
 * still being written is cut and every open element closed, innermost first.
 * Null until the root `<svg …>` tag is complete.
 */
export function closePartialSvg(source: string): string | null {
	const open: string[] = [];
	let rootSeen = false;
	let end = 0;
	let index = 0;
	for (;;) {
		const lt = source.indexOf("<", index);
		if (lt < 0) {
			const amp = source.lastIndexOf("&");
			end = amp >= index && !source.includes(";", amp) ? amp : source.length;
			break;
		}
		end = lt;
		const close = constructEnd(source, lt);
		if (close < 0) break;
		if (source.startsWith("</", lt)) {
			const name = source.slice(lt + 2, close - 1).trim();
			const at = open.lastIndexOf(name);
			if (at >= 0) open.length = at;
		} else if (source[lt + 1] !== "!" && source[lt + 1] !== "?") {
			const name = /^<([^\s/>]+)/.exec(source.slice(lt, close))?.[1];
			if (name !== undefined) {
				if (source[close - 2] !== "/") open.push(name);
				if (name === "svg" || name.endsWith(":svg")) rootSeen = true;
			}
		}
		index = close;
		end = close;
	}
	if (!rootSeen) return null;
	let document = source.slice(0, end);
	for (let at = open.length - 1; at >= 0; at--) document += `</${open[at]}>`;
	return document;
}

const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
const ROOT_TAG = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

/**
 * The source as a rasterizer draws it in the reader's theme: `var(--name)`
 * resolved from `palette`, and a root given `color` (for `currentColor`), a
 * sans-serif face and the SVG namespace when it lacks them.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const resolved = svg.replace(
		VAR_REFERENCE,
		(_match, name: string, fallback: string | undefined) => palette[name] ?? (fallback?.trim() || fg),
	);
	const usesXlink = resolved.includes("xlink:");
	return resolved.replace(ROOT_TAG, tag => {
		let added = "";
		if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
		if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="${FIGURE_FONTS}"`;
		if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
		if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
		return added ? tag.replace(/^<[^\s/>]+/, `$&${added}`) : tag;
	});
}

/** Opacity of parts outside the highlighted one. */
const DIMMED_OPACITY = "0.16";

/**
 * Spotlight one part of a drawing: elements whose `id` is among `parts`
 * fade, except the one equal to `active` (case-insensitive). Only parts the
 * drawing actually has count, so an `active` naming none of them (an "all"
 * tab) leaves the drawing as written.
 */
export function highlightSvg(svg: string, parts: readonly string[], active: string | undefined): string {
	const target = active?.trim().toLowerCase();
	if (!target) return svg;
	const drawn = new Set(Array.from(svg.matchAll(/\sid\s*=\s*(["'])(.*?)\1/g), match => match[2]!.toLowerCase()));
	const named = parts.map(part => part.toLowerCase()).filter(part => drawn.has(part));
	if (!named.includes(target)) return svg;
	const dimmed = new Set(named.filter(part => part !== target));
	return svg.replace(/<([a-zA-Z][\w:.-]*)(\s[^<>]*?)?(\/?)>/g, (tag, name: string, attrs: string | undefined, slash: string) => {
		const id = attrs && /\sid\s*=\s*(["'])(.*?)\1/.exec(attrs)?.[2];
		if (!id || !dimmed.has(id.toLowerCase())) return tag;
		const kept = attrs.replace(/\sopacity\s*=\s*(["']).*?\1/g, "");
		return `<${name}${kept} opacity="${DIMMED_OPACITY}"${slash}>`;
	});
}

interface Raster {
	readonly source: string;
	readonly key: string;
	readonly data: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly cellWidthPx: number;
	readonly cellHeightPx: number;
}

interface Attempt {
	readonly source: string;
	readonly cellWidthPx: number;
	readonly cellHeightPx: number;
	readonly columns: number;
	readonly rows: number;
	readonly themeEpoch: number;
	readonly final: boolean;
}

export interface FigureOptions {
	/** The figure's rows changed outside a render: a raster landed or drawing failed. */
	readonly onChange: () => void;
	/** The host's inline-image budget, once known. */
	readonly budget: () => ImageBudget | undefined;
}

let nextFigureId = 0;

/** One SVG drawing, re-rasterized as its source streams, the theme changes or its room changes. */
export class Figure implements Component {
	readonly #options: FigureOptions;
	readonly #id = nextFigureId++;
	#source = "";
	#final = false;
	#width: number | undefined;
	#raster: Raster | undefined;
	#image: { readonly raster: Raster; readonly component: Image } | undefined;
	#attempt: Attempt | undefined;
	#failed: string | undefined;
	#busy = false;
	#startedAt = Number.NEGATIVE_INFINITY;
	#timer: NodeJS.Timeout | undefined;
	#revision = 0;
	#disposed = false;

	constructor(options: FigureOptions) {
		this.#options = options;
	}

	/** Feed the drawing; `final` once its source is complete (rasterized at once instead of throttled). */
	update(source: string, final: boolean): void {
		if (source === this.#source && final === this.#final) return;
		this.#source = source;
		this.#final = final;
		this.#schedule();
	}

	render(width: number): readonly string[] {
		this.#width = width;
		this.#schedule();
		if (this.#failed === this.#source) return [theme.fg("warning", "▦ this drawing could not be rendered")];
		const raster = this.#raster;
		if (!raster) return [theme.fg("dim", "▦ drawing…")];
		return this.#imageFor(raster).render(width);
	}

	invalidate(): void {
		this.#image?.component.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#raster) this.#options.budget()?.release(this.#raster.key);
	}

	#limits(width: number): { columns: number; rows: number } {
		const cell = getCellDimensions();
		const viewportRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE);
		return {
			columns: Math.min(imageMaxColumns(width), Math.floor(MAX_EDGE_PX / cell.widthPx)),
			rows: Math.max(1, Math.min(viewportRows, Math.floor(MAX_EDGE_PX / cell.heightPx))),
		};
	}

	#stale(width: number): boolean {
		if (this.#failed === this.#source) return false;
		const attempt = this.#attempt;
		if (!attempt) return true;
		const cell = getCellDimensions();
		const { columns, rows } = this.#limits(width);
		return (
			attempt.source !== this.#source ||
			attempt.cellWidthPx !== cell.widthPx ||
			attempt.cellHeightPx !== cell.heightPx ||
			attempt.columns !== columns ||
			attempt.rows !== rows ||
			attempt.themeEpoch !== getThemeEpoch() ||
			// A streaming attempt that failed is retried once the source is final.
			(this.#final && !attempt.final && this.#raster?.source !== this.#source)
		);
	}

	/** Start a raster when one is due: one at a time, throttled while streaming, at once when final. */
	#schedule(): void {
		const width = this.#width;
		if (this.#disposed || this.#busy || width === undefined) return;
		if (this.#final && this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#timer || !this.#stale(width)) return;
		const wait = this.#final ? 0 : this.#startedAt + STREAM_INTERVAL_MS - performance.now();
		if (wait > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#schedule();
			}, wait);
			this.#timer.unref?.();
			return;
		}
		void this.#rasterize(width);
	}

	async #rasterize(width: number): Promise<void> {
		const cell = getCellDimensions();
		const { columns, rows } = this.#limits(width);
		const attempt: Attempt = {
			source: this.#source,
			cellWidthPx: cell.widthPx,
			cellHeightPx: cell.heightPx,
			columns,
			rows,
			themeEpoch: getThemeEpoch(),
			final: this.#final,
		};
		this.#attempt = attempt;
		const svg = closePartialSvg(attempt.source);
		let png: Uint8Array | undefined;
		if (svg !== null) {
			this.#busy = true;
			this.#startedAt = performance.now();
			try {
				png = await rasterizeSvg(
					new TextEncoder().encode(prepareSvg(svg, figurePalette())),
					columns * cell.widthPx,
					rows * cell.heightPx,
					cell.heightPx / UNITS_PER_ROW,
					cell,
				);
			} catch {
				// A streaming prefix that does not parse yet keeps the previous raster.
			} finally {
				this.#busy = false;
			}
		}
		if (this.#disposed) return;
		const data = png ? Buffer.from(png).toString("base64") : undefined;
		const size = data ? getImageDimensions(data, "image/png") : null;
		if (data && size) {
			const previous = this.#raster;
			this.#raster = {
				source: attempt.source,
				key: `iui${this.#id}:${++this.#revision}`,
				data,
				widthPx: size.widthPx,
				heightPx: size.heightPx,
				cellWidthPx: cell.widthPx,
				cellHeightPx: cell.heightPx,
			};
			// A superseded streaming revision is gone for good: free its terminal image now.
			if (previous && previous.source !== attempt.source) this.#options.budget()?.release(previous.key);
			this.#options.onChange();
		} else if (attempt.final) {
			this.#failed = attempt.source;
			this.#options.onChange();
		}
		this.#schedule();
	}

	/** The image over the whole cells its raster was padded to, so the terminal places it 1:1. */
	#imageFor(raster: Raster): Image {
		if (this.#image?.raster === raster) return this.#image.component;
		const component = new Image(
			raster.data,
			"image/png",
			{ fallbackColor: (line: string) => theme.fg("toolOutput", line) },
			{
				maxWidthCells: raster.widthPx / raster.cellWidthPx,
				maxHeightCells: raster.heightPx / raster.cellHeightPx,
				filename: "figure",
				budget: this.#options.budget(),
				imageKey: raster.key,
				requestRender: this.#options.onChange,
			},
			{ widthPx: raster.widthPx, heightPx: raster.heightPx },
		);
		this.#image = { raster, component };
		return component;
	}
}
