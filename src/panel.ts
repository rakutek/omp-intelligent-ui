/**
 * The full-screen view of one card: the place it is operated. Keys move focus
 * and adjust controls; with the alternate screen's mouse reporting, tabs,
 * buttons, options and slider tracks take clicks and the wheel scrolls.
 */
import type { Component, SgrMouseEvent, Theme, TUI } from "@oh-my-pi/pi-tui";
import { matchesKey, padding, routeSgrMouseInput, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { NodeSpec, UiInstance } from "./model";
import { type Control, type Out, renderCard, type Surface } from "./render";

export interface PanelResult {
	/** Text a button asked to send as the user's next message. */
	readonly send?: string;
}

/** Rows above the body: the title and a rule. */
const HEADER_ROWS = 2;
/** Rows below the body: a rule and the key hints. */
const FOOTER_ROWS = 2;
/** Columns left of the body: a margin and the focus marker. */
const GUTTER = 3;

export class UiPanel implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #instance: UiInstance;
	readonly #surface: Surface;
	readonly #images: boolean;
	readonly #done: (result: PanelResult) => void;
	readonly #drafts = new Map<string, string>();
	#focus: string | undefined;
	/** Scroll the focused control into view on the next render (after keyboard moves, not wheel scrolls). */
	#follow = true;
	#scroll = 0;
	#bodyHeight = 1;
	#out: Out | undefined;
	/** Body width and instance revision of {@link #out}; input after a state change re-lays the body first. */
	#bodyWidth = 80;
	#renderedRevision = -1;
	#status: string | undefined;
	#closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		instance: UiInstance,
		surface: Surface,
		images: boolean,
		done: (result: PanelResult) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#instance = instance;
		this.#surface = surface;
		this.#images = images;
		this.#done = done;
	}

	#renderBody(width: number): Out {
		this.#bodyWidth = width;
		this.#renderedRevision = this.#instance.revision;
		this.#out = renderCard(
			{
				theme: this.#theme,
				instance: this.#instance,
				surface: this.#surface,
				interactive: true,
				focus: this.#focus,
				partial: false,
				images: this.#images,
				drafts: this.#drafts,
				press: (node: NodeSpec) => this.#press(node),
				labelWidth: 0,
			},
			width,
			{ header: false },
		);
		return this.#out;
	}

	/** The body as it lays out now: a key that showed or hid controls must not act on the old layout. */
	#current(): Out {
		if (this.#out && this.#renderedRevision === this.#instance.revision) return this.#out;
		return this.#renderBody(this.#bodyWidth);
	}

	render(width: number): readonly string[] {
		const t = this.#theme;
		const rows = Math.max(HEADER_ROWS + FOOTER_ROWS + 3, this.#tui.terminal.rows);
		this.#bodyHeight = rows - HEADER_ROWS - FOOTER_ROWS;
		const bodyWidth = Math.max(20, width - GUTTER - 1);
		let out = this.#renderBody(bodyWidth);
		if (!out.controls.some(control => control.key === this.#focus) && out.controls.length > 0) {
			// The focused control vanished (a tab switched, a `when` turned false): take the first one in view.
			this.#focus = (out.controls.find(control => control.line >= this.#scroll) ?? out.controls[0]!).key;
			out = this.#renderBody(bodyWidth);
		}
		const focused = out.controls.find(control => control.key === this.#focus);
		if (this.#follow && focused) {
			if (focused.line < this.#scroll + 1) this.#scroll = Math.max(0, focused.line - 2);
			else if (focused.line >= this.#scroll + this.#bodyHeight - 1) this.#scroll = focused.line - this.#bodyHeight + 3;
			this.#follow = false;
		}
		const maxScroll = Math.max(0, out.lines.length - this.#bodyHeight);
		this.#scroll = Math.min(maxScroll, Math.max(0, this.#scroll));

		const title = `${t.fg("accent", "◆ ")}${t.bold(this.#instance.title)}`;
		const brand = t.fg("dim", "Intelligent UI");
		const lines = [
			truncateToWidth(` ${title}${padding(Math.max(1, width - visibleWidth(title) - visibleWidth(brand) - 2))}${brand}`, width),
			t.fg("borderMuted", "─".repeat(width)),
		];
		const body = this.#visibleRows(out);
		for (let row = 0; row < this.#bodyHeight; row++) {
			const marker = focused && focused.line === this.#scroll + row ? t.fg("accent", "▸ ") : "  ";
			lines.push(` ${marker}${body[row] ?? ""}`);
		}
		lines.push(t.fg("borderMuted", "─".repeat(width)));
		const position = maxScroll > 0 ? t.fg("dim", ` ${Math.round((this.#scroll / maxScroll) * 100)}% `) : "";
		const hints = out.controls.length
			? "tab/↑↓ focus · ←→ adjust · enter press · click · wheel/PgUp/PgDn scroll · ctrl+r reset · esc close"
			: "↑↓/wheel/PgUp/PgDn scroll · esc close";
		const status = this.#status ? t.fg("warning", this.#status) : t.fg("dim", hints);
		lines.push(truncateToWidth(` ${status}`, Math.max(1, width - visibleWidth(position))) + position);
		return lines;
	}

	/**
	 * The body rows in view. An inline image draws upward from its last row,
	 * so one cut by either edge would land on the wrong rows: its visible part
	 * becomes blank rows with a note instead.
	 */
	#visibleRows(out: Out): string[] {
		const top = this.#scroll;
		const bottom = top + this.#bodyHeight;
		const rows = out.lines.slice(top, bottom);
		for (const [start, end] of out.figures) {
			if (end <= top || start >= bottom || (start >= top && end <= bottom)) continue;
			for (let line = Math.max(start, top); line < Math.min(end, bottom); line++) rows[line - top] = "";
			const note = start < top ? "▦ drawing above — PgUp to see it whole" : "▦ drawing below — PgDn to see it whole";
			rows[Math.max(start, top) - top] = this.#theme.fg("dim", note);
		}
		return rows;
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		this.#status = undefined;
		if (routeSgrMouseInput(data, event => this.#mouse(event))) {
			this.#tui.requestRender();
			return;
		}
		const controls = this.#current().controls;
		if (matchesKey(data, "escape")) {
			this.#close({});
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
			this.#scroll += (matchesKey(data, "pageDown") ? 1 : -1) * Math.max(1, this.#bodyHeight - 2);
		} else if (matchesKey(data, "ctrl+r")) {
			this.#instance.reset();
			this.#drafts.clear();
		} else if (controls.length === 0 && (matchesKey(data, "down") || matchesKey(data, "up"))) {
			this.#scroll += matchesKey(data, "down") ? 1 : -1;
		} else if (matchesKey(data, "tab") || matchesKey(data, "down")) {
			this.#move(controls, 1);
		} else if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) {
			this.#move(controls, -1);
		} else {
			const focused = controls.find(control => control.key === this.#focus);
			if (focused?.handle(data)) this.#follow = true;
		}
		this.#tui.requestRender();
	}

	#move(controls: readonly Control[], delta: number): void {
		if (controls.length === 0) return;
		const at = controls.findIndex(control => control.key === this.#focus);
		const next = controls[(at + delta + controls.length) % controls.length]!;
		if (this.#focus !== undefined) this.#drafts.delete(this.#focus);
		this.#focus = next.key;
		this.#follow = true;
	}

	#mouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null) {
			this.#scroll += event.wheel * 3;
			return true;
		}
		if (!event.leftClick) return true;
		const line = event.row - HEADER_ROWS + this.#scroll;
		const col = event.col - GUTTER;
		if (event.row < HEADER_ROWS || event.row >= HEADER_ROWS + this.#bodyHeight) return true;
		const hit = this.#current().hits.find(target => target.line === line && col >= target.col0 && col < target.col1);
		if (!hit) return true;
		if (this.#focus !== hit.key && this.#focus !== undefined) this.#drafts.delete(this.#focus);
		this.#focus = hit.key;
		hit.click(col - hit.col0, hit.col1 - hit.col0);
		return true;
	}

	#press(node: NodeSpec): void {
		const result = this.#instance.press(node);
		if (result.error) this.#status = `⚠ ${result.error}`;
		else if (result.send) this.#close({ send: result.send });
	}

	#close(result: PanelResult): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#done(result);
	}

	invalidate(): void {
		this.#surface.invalidate();
	}

	dispose(): void {
		this.#surface.dispose();
	}
}
