import { describe, expect, test } from "bun:test";
import { evaluate, ExprError, interpolate, type Value } from "../src/expr";
import { closePartialSvg, highlightSvg } from "../src/figures";
import { specKey, UiInstance } from "../src/model";

const vars = (values: Record<string, Value>) => (name: string) => values[name];

describe("expressions", () => {
	test("power binds tighter than unary minus and associates right", () => {
		expect(evaluate("-2^2", vars({}))).toBe(-4);
		expect(evaluate("2^3^2", vars({}))).toBe(512);
		expect(evaluate("1 + 2 * 3 > 6 ? 'big' : 'small'", vars({}))).toBe("big");
	});

	test("finance helpers handle a zero rate", () => {
		expect(evaluate("fv(0, 10, 100)", vars({}))).toBe(1000);
		expect(evaluate("round(pmt(0.01, 12, 1000), 2)", vars({}))).toBe(88.85);
		expect(evaluate("pmt(0, 4, 1000)", vars({}))).toBe(250);
	});

	test("formatting groups thousands and takes ratios for percentages", () => {
		expect(evaluate("fmt(1234567.891)", vars({}))).toBe("1,234,568");
		expect(evaluate("pct(0.256, 1)", vars({}))).toBe("25.6%");
		expect(evaluate("'n=' + 3", vars({}))).toBe("n=3");
	});

	test("randomness only runs inside button actions", () => {
		expect(() => evaluate("rand()", vars({}))).toThrow(ExprError);
		const roll = evaluate("randint(1, 6)", vars({}), { random: true });
		expect(roll).toBeGreaterThanOrEqual(1);
		expect(roll).toBeLessThanOrEqual(6);
	});

	test("unknown names and functions are errors, not silent zeros", () => {
		expect(() => evaluate("missing + 1", vars({}))).toThrow('unknown name "missing"');
		expect(() => evaluate("nope(1)", vars({}))).toThrow('unknown function "nope"');
	});

	test("templates cut an unfinished placeholder while streaming and mark failures once final", () => {
		expect(interpolate("Total {{fmt(tot", vars({}), true)).toBe("Total …");
		expect(interpolate("Total {{fmt(total)}}", vars({ total: 1500 }))).toBe("Total 1,500");
		expect(interpolate("Total {{oops}}", vars({}))).toBe("Total ‹?›");
	});
});

describe("figures", () => {
	const svg = '<svg viewBox="0 0 10 10"><g id="frame"><path d="M0 0"/></g><g id="wheels"/></svg>';

	test("a value naming no drawn part leaves the drawing untouched", () => {
		expect(highlightSvg(svg, ["all", "frame", "wheels"], "all")).toBe(svg);
		expect(highlightSvg(svg, ["frame", "brakes"], "brakes")).toBe(svg);
	});

	test("the active part stays and the other drawn parts fade", () => {
		const lit = highlightSvg(svg, ["all", "frame", "wheels"], "Frame");
		expect(lit).toContain('<g id="frame">');
		expect(lit).toContain('<g id="wheels" opacity="0.16"/>');
	});

	test("a truncated stream becomes a closed document once the root tag is complete", () => {
		expect(closePartialSvg('<svg viewBox="0 0')).toBeNull();
		expect(closePartialSvg('<svg viewBox="0 0 9 9"><g id="a"><circle r="2"/><path d="M0')).toBe(
			'<svg viewBox="0 0 9 9"><g id="a"><circle r="2"/></g></svg>',
		);
	});
});

describe("card state", () => {
	const spec = {
		title: "Test",
		state: { a: 1, b: 2 },
		computed: { total: "years * 10" },
		body: [
			{ type: "slider", id: "years", label: "Years", min: 1, max: 40, step: 1, value: 20 },
			{ type: "select", id: "mode", options: ["easy", "hard"] },
		],
	};

	test("sliders snap to their step and clamp to their range; computed values follow", () => {
		const card = new UiInstance("k", spec);
		expect(card.get("total")).toBe(200);
		card.set("years", 7.4);
		expect(card.get("years")).toBe(7);
		card.set("years", 99);
		expect(card.get("total")).toBe(400);
	});

	test("a button assigns everything from the pre-press state, then sends its filled text", () => {
		const card = new UiInstance("k", spec);
		const result = card.press({ type: "button", set: { a: "b", b: "a", mode: "hard" }, send: "a={{a}} b={{b}} {{mode}}" });
		expect(result).toEqual({ send: "a=2 b=1 hard" });
	});

	test("edits are pending for the model until reported", () => {
		const card = new UiInstance("k", spec);
		expect(card.pendingReport()).toBe(false);
		card.set("mode", "hard");
		expect(card.pendingReport()).toBe(true);
		card.markReported();
		expect(card.pendingReport()).toBe(false);
	});

	test("identity ignores key order, so a card and its execution find the same state", () => {
		expect(specKey({ title: "T", body: [{ type: "text", text: "x" }] })).toBe(
			specKey({ body: [{ text: "x", type: "text" }], title: "T" }),
		);
	});
});
