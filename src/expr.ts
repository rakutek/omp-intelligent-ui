/**
 * Expression language for card bindings (`computed`, `{{template}}` text,
 * `when`, button `set`, generated chart series).
 *
 * Deliberately closed: literals, variables, arithmetic, comparison, logic,
 * ternaries and a fixed function table. No property access, assignment or
 * host objects, so a model-written card can compute values but never reach
 * the process it runs in.
 */

export type Value = number | string | boolean | null;
export type Scope = (name: string) => Value | undefined;

export class ExprError extends Error {
	override name = "ExprError";
}

type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=";

type Ast =
	| { readonly k: "lit"; readonly v: Value }
	| { readonly k: "var"; readonly name: string }
	| { readonly k: "neg" | "pos" | "not"; readonly a: Ast }
	| { readonly k: "bin"; readonly op: BinaryOp; readonly a: Ast; readonly b: Ast }
	| { readonly k: "and" | "or"; readonly a: Ast; readonly b: Ast }
	| { readonly k: "cond"; readonly c: Ast; readonly a: Ast; readonly b: Ast }
	| { readonly k: "call"; readonly name: string; readonly args: readonly Ast[] };

interface Token {
	readonly kind: "num" | "str" | "name" | "op" | "end";
	readonly text: string;
	readonly value?: number | string;
	readonly at: number;
}

export interface EvalOptions {
	/** Allow `rand()`/`randint()`: only button actions, which run once per press. */
	readonly random?: boolean;
}

const OPERATORS = [
	"===",
	"!==",
	"**",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"+",
	"-",
	"*",
	"/",
	"%",
	"^",
	"<",
	">",
	"!",
	"?",
	":",
	"(",
	")",
	",",
];
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[\p{L}_$][\p{L}\p{N}_$]*/u;

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		const rest = src.slice(i);
		const number = NUMBER.exec(rest);
		if (number) {
			tokens.push({ kind: "num", text: number[0], value: Number(number[0]), at: i });
			i += number[0].length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			let value = "";
			while (j < src.length && src[j] !== ch) {
				if (src[j] === "\\" && j + 1 < src.length) {
					const escaped = src[j + 1]!;
					value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
					j += 2;
				} else {
					value += src[j];
					j++;
				}
			}
			if (j >= src.length) throw new ExprError(`unterminated string at ${i}`);
			tokens.push({ kind: "str", text: src.slice(i, j + 1), value, at: i });
			i = j + 1;
			continue;
		}
		const name = NAME.exec(rest);
		if (name) {
			tokens.push({ kind: "name", text: name[0], at: i });
			i += name[0].length;
			continue;
		}
		const op = OPERATORS.find(candidate => rest.startsWith(candidate));
		if (op) {
			tokens.push({ kind: "op", text: op, at: i });
			i += op.length;
			continue;
		}
		throw new ExprError(`unexpected "${ch}" at ${i}`);
	}
	tokens.push({ kind: "end", text: "", at: src.length });
	return tokens;
}

class Parser {
	readonly #tokens: Token[];
	#pos = 0;

	constructor(src: string) {
		this.#tokens = tokenize(src);
	}

	parse(): Ast {
		const ast = this.#ternary();
		const next = this.#peek();
		if (next.kind !== "end") throw new ExprError(`unexpected "${next.text}" at ${next.at}`);
		return ast;
	}

	#peek(): Token {
		return this.#tokens[this.#pos]!;
	}

	#take(): Token {
		return this.#tokens[this.#pos++]!;
	}

	#isOp(...ops: string[]): boolean {
		const token = this.#peek();
		return token.kind === "op" && ops.includes(token.text);
	}

	#isWord(word: string): boolean {
		const token = this.#peek();
		return token.kind === "name" && token.text === word;
	}

	#expect(op: string): void {
		const token = this.#take();
		if (token.kind !== "op" || token.text !== op) {
			throw new ExprError(token.kind === "end" ? `missing "${op}"` : `expected "${op}" at ${token.at}`);
		}
	}

	#ternary(): Ast {
		const c = this.#or();
		if (!this.#isOp("?")) return c;
		this.#take();
		const a = this.#ternary();
		this.#expect(":");
		const b = this.#ternary();
		return { k: "cond", c, a, b };
	}

	#or(): Ast {
		let a = this.#and();
		while (this.#isOp("||") || this.#isWord("or")) {
			this.#take();
			a = { k: "or", a, b: this.#and() };
		}
		return a;
	}

	#and(): Ast {
		let a = this.#equality();
		while (this.#isOp("&&") || this.#isWord("and")) {
			this.#take();
			a = { k: "and", a, b: this.#equality() };
		}
		return a;
	}

	#equality(): Ast {
		let a = this.#comparison();
		while (this.#isOp("==", "!=", "===", "!==")) {
			const op = this.#take().text.startsWith("!") ? "!=" : "==";
			a = { k: "bin", op, a, b: this.#comparison() };
		}
		return a;
	}

	#comparison(): Ast {
		let a = this.#additive();
		while (this.#isOp("<", "<=", ">", ">=")) {
			const op = this.#take().text as BinaryOp;
			a = { k: "bin", op, a, b: this.#additive() };
		}
		return a;
	}

	#additive(): Ast {
		let a = this.#multiplicative();
		while (this.#isOp("+", "-")) {
			const op = this.#take().text as BinaryOp;
			a = { k: "bin", op, a, b: this.#multiplicative() };
		}
		return a;
	}

	#multiplicative(): Ast {
		let a = this.#unary();
		while (this.#isOp("*", "/", "%")) {
			const op = this.#take().text as BinaryOp;
			a = { k: "bin", op, a, b: this.#unary() };
		}
		return a;
	}

	#unary(): Ast {
		if (this.#isOp("-")) {
			this.#take();
			return { k: "neg", a: this.#unary() };
		}
		if (this.#isOp("+")) {
			this.#take();
			return { k: "pos", a: this.#unary() };
		}
		if (this.#isOp("!") || this.#isWord("not")) {
			this.#take();
			return { k: "not", a: this.#unary() };
		}
		return this.#power();
	}

	#power(): Ast {
		const base = this.#primary();
		if (!this.#isOp("^", "**")) return base;
		this.#take();
		// Right-associative, and binds tighter than a leading minus: -2^2 is -4.
		return { k: "bin", op: "^", a: base, b: this.#unary() };
	}

	#primary(): Ast {
		const token = this.#take();
		if (token.kind === "num") return { k: "lit", v: token.value as number };
		if (token.kind === "str") return { k: "lit", v: token.value as string };
		if (token.kind === "name") {
			if (token.text === "true") return { k: "lit", v: true };
			if (token.text === "false") return { k: "lit", v: false };
			if (token.text === "null") return { k: "lit", v: null };
			if (!this.#isOp("(")) return { k: "var", name: token.text };
			this.#take();
			const args: Ast[] = [];
			if (!this.#isOp(")")) {
				args.push(this.#ternary());
				while (this.#isOp(",")) {
					this.#take();
					args.push(this.#ternary());
				}
			}
			this.#expect(")");
			return { k: "call", name: token.text, args };
		}
		if (token.kind === "op" && token.text === "(") {
			const inner = this.#ternary();
			this.#expect(")");
			return inner;
		}
		throw new ExprError(token.kind === "end" ? "unexpected end of expression" : `unexpected "${token.text}" at ${token.at}`);
	}
}

// ── Values ───────────────────────────────────────────────────────────────────

export function truthy(value: Value | undefined): boolean {
	if (value === null || value === undefined || value === false || value === "" || value === 0) return false;
	return !(typeof value === "number" && Number.isNaN(value));
}

/** A number when `value` reads as one (`"1,200"` does; `""` and words do not). */
export function asNumber(value: Value | undefined): number | undefined {
	if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string") {
		const trimmed = value.trim().replaceAll(",", "");
		if (trimmed === "") return undefined;
		const parsed = Number(trimmed);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

export function toNumber(value: Value | undefined): number {
	if (value === null || value === undefined || value === "") return 0;
	const parsed = asNumber(value);
	if (parsed === undefined) throw new ExprError(`"${text(value)}" is not a number`);
	return parsed;
}

/** Plain text of a value, for concatenation and comparison. */
export function text(value: Value | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "∞" : "-∞";
		return String(Number(value.toPrecision(12)));
	}
	return String(value);
}

/** Text of a value as a reader sees it: numbers grouped and rounded. */
export function display(value: Value | undefined): string {
	return typeof value === "number" ? formatNumber(value) : text(value);
}

/** `1234567.8` → `1,234,568`; `3.14159` → `3.14`; `0.01234` → `0.012`; fixed decimals when `digits` is given. */
export function formatNumber(value: number, digits?: number): string {
	if (Number.isNaN(value)) return "—";
	if (!Number.isFinite(value)) return value > 0 ? "∞" : "−∞";
	const magnitude = Math.abs(value);
	if (digits !== undefined) {
		const fixed = Math.max(0, Math.min(10, Math.round(digits)));
		return value.toLocaleString("en-US", { minimumFractionDigits: fixed, maximumFractionDigits: fixed });
	}
	const decimals = magnitude >= 1000 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
	const rounded = value.toLocaleString("en-US", { maximumFractionDigits: decimals });
	return rounded === "-0" ? "0" : rounded;
}

function roundTo(value: number, digits: number): number {
	const factor = 10 ** Math.max(0, Math.min(10, Math.round(digits)));
	const rounded = Math.round(value * factor) / factor;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function looseEquals(a: Value, b: Value): boolean {
	if (a === b) return true;
	const na = asNumber(a);
	const nb = asNumber(b);
	if (na !== undefined && nb !== undefined) return na === nb;
	return text(a) === text(b);
}

function compare(a: Value, b: Value): number {
	const na = asNumber(a);
	const nb = asNumber(b);
	if (na !== undefined && nb !== undefined) return na - nb;
	return text(a).localeCompare(text(b));
}

function binary(op: BinaryOp, a: Value, b: Value): Value {
	switch (op) {
		case "+":
			return typeof a === "string" || typeof b === "string" ? text(a) + text(b) : toNumber(a) + toNumber(b);
		case "-":
			return toNumber(a) - toNumber(b);
		case "*":
			return toNumber(a) * toNumber(b);
		case "/":
			return toNumber(a) / toNumber(b);
		case "%":
			return toNumber(a) % toNumber(b);
		case "^":
			return toNumber(a) ** toNumber(b);
		case "==":
			return looseEquals(a, b);
		case "!=":
			return !looseEquals(a, b);
		case "<":
			return compare(a, b) < 0;
		case "<=":
			return compare(a, b) <= 0;
		case ">":
			return compare(a, b) > 0;
		case ">=":
			return compare(a, b) >= 0;
	}
}

// ── Functions ────────────────────────────────────────────────────────────────

interface FunctionDef {
	readonly min: number;
	readonly max: number;
	readonly random?: boolean;
	readonly fn: (args: readonly Value[]) => Value;
}

const numbers = (args: readonly Value[]): number[] => args.map(toNumber);
const unary = (fn: (x: number) => number): FunctionDef => ({ min: 1, max: 1, fn: ([x]) => fn(toNumber(x)) });

const FUNCTIONS: Readonly<Record<string, FunctionDef>> = {
	abs: unary(Math.abs),
	floor: unary(Math.floor),
	ceil: unary(Math.ceil),
	sqrt: unary(Math.sqrt),
	exp: unary(Math.exp),
	log: unary(Math.log),
	log10: unary(Math.log10),
	sign: unary(Math.sign),
	int: unary(Math.trunc),
	round: { min: 1, max: 2, fn: ([x, d]) => roundTo(toNumber(x), d === undefined ? 0 : toNumber(d)) },
	min: { min: 1, max: 64, fn: args => Math.min(...numbers(args)) },
	max: { min: 1, max: 64, fn: args => Math.max(...numbers(args)) },
	sum: { min: 0, max: 64, fn: args => numbers(args).reduce((total, x) => total + x, 0) },
	avg: { min: 1, max: 64, fn: args => numbers(args).reduce((total, x) => total + x, 0) / args.length },
	pow: { min: 2, max: 2, fn: ([a, b]) => toNumber(a) ** toNumber(b) },
	clamp: {
		min: 3,
		max: 3,
		fn: ([x, lo, hi]) => Math.min(Math.max(toNumber(x), toNumber(lo)), toNumber(hi)),
	},
	if: { min: 2, max: 3, fn: ([c, a, b]) => (truthy(c) ? (a ?? null) : (b ?? null)) },
	fmt: { min: 1, max: 2, fn: ([x, d]) => formatNumber(toNumber(x), d === undefined ? undefined : toNumber(d)) },
	pct: {
		min: 1,
		max: 2,
		fn: ([x, d]) => `${formatNumber(toNumber(x) * 100, d === undefined ? undefined : toNumber(d))}%`,
	},
	str: { min: 1, max: 1, fn: ([x]) => display(x) },
	num: { min: 1, max: 1, fn: ([x]) => toNumber(x) },
	len: { min: 1, max: 1, fn: ([x]) => Array.from(text(x)).length },
	upper: { min: 1, max: 1, fn: ([x]) => text(x).toUpperCase() },
	lower: { min: 1, max: 1, fn: ([x]) => text(x).toLowerCase() },
	pick: { min: 2, max: 64, fn: ([i, ...values]) => values[Math.floor(toNumber(i))] ?? null },
	pmt: {
		min: 3,
		max: 3,
		fn: ([rate, periods, principal]) => {
			const r = toNumber(rate);
			const n = toNumber(periods);
			const pv = toNumber(principal);
			return r === 0 ? pv / n : (pv * r) / (1 - (1 + r) ** -n);
		},
	},
	fv: {
		min: 3,
		max: 4,
		fn: ([rate, periods, payment, principal]) => {
			const r = toNumber(rate);
			const n = toNumber(periods);
			const pay = toNumber(payment);
			const pv = principal === undefined ? 0 : toNumber(principal);
			if (r === 0) return pv + pay * n;
			const growth = (1 + r) ** n;
			return pv * growth + (pay * (growth - 1)) / r;
		},
	},
	rand: { min: 0, max: 0, random: true, fn: () => Math.random() },
	randint: {
		min: 2,
		max: 2,
		random: true,
		fn: ([a, b]) => {
			const lo = Math.ceil(Math.min(toNumber(a), toNumber(b)));
			const hi = Math.floor(Math.max(toNumber(a), toNumber(b)));
			return lo + Math.floor(Math.random() * (hi - lo + 1));
		},
	},
};

export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

function call(name: string, args: readonly Value[], options: EvalOptions): Value {
	const def = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
	if (!def) throw new ExprError(`unknown function "${name}"`);
	if (def.random && !options.random) throw new ExprError(`${name}() only works in button "set" actions`);
	if (args.length < def.min || args.length > def.max) {
		const arity = def.min === def.max ? `${def.min}` : `${def.min}–${def.max}`;
		throw new ExprError(`${name}() takes ${arity} argument${def.max === 1 ? "" : "s"}, got ${args.length}`);
	}
	return def.fn(args);
}

function evaluateAst(ast: Ast, scope: Scope, options: EvalOptions): Value {
	switch (ast.k) {
		case "lit":
			return ast.v;
		case "var": {
			const value = scope(ast.name);
			if (value === undefined) throw new ExprError(`unknown name "${ast.name}"`);
			return value;
		}
		case "neg":
			return -toNumber(evaluateAst(ast.a, scope, options));
		case "pos":
			return toNumber(evaluateAst(ast.a, scope, options));
		case "not":
			return !truthy(evaluateAst(ast.a, scope, options));
		case "and": {
			const a = evaluateAst(ast.a, scope, options);
			return truthy(a) ? evaluateAst(ast.b, scope, options) : a;
		}
		case "or": {
			const a = evaluateAst(ast.a, scope, options);
			return truthy(a) ? a : evaluateAst(ast.b, scope, options);
		}
		case "cond":
			return truthy(evaluateAst(ast.c, scope, options))
				? evaluateAst(ast.a, scope, options)
				: evaluateAst(ast.b, scope, options);
		case "bin":
			return binary(ast.op, evaluateAst(ast.a, scope, options), evaluateAst(ast.b, scope, options));
		case "call":
			return call(
				ast.name,
				ast.args.map(arg => evaluateAst(arg, scope, options)),
				options,
			);
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

const COMPILE_CACHE_LIMIT = 2000;
const compiled = new Map<string, Ast | ExprError>();

function compile(src: string): Ast {
	let entry = compiled.get(src);
	if (entry === undefined) {
		try {
			entry = new Parser(src).parse();
		} catch (error) {
			entry = error instanceof ExprError ? error : new ExprError(String(error));
		}
		if (compiled.size >= COMPILE_CACHE_LIMIT) compiled.clear();
		compiled.set(src, entry);
	}
	if (entry instanceof ExprError) throw entry;
	return entry;
}

/** Syntax error of `src`, or undefined when it parses. */
export function syntaxError(src: string): string | undefined {
	try {
		compile(src);
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

export function evaluate(src: string, scope: Scope, options: EvalOptions = {}): Value {
	return evaluateAst(compile(src), scope, options);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const TEMPLATE = /\{\{([\s\S]*?)\}\}/g;

/** The expressions inside `{{…}}` placeholders of `template`. */
export function templateExpressions(template: string): string[] {
	return Array.from(template.matchAll(TEMPLATE), match => match[1]!.trim());
}

/**
 * Fill `{{expression}}` placeholders. A placeholder that fails shows `‹?›`;
 * while `partial`, it shows `…` and a placeholder still being written is cut.
 */
export function interpolate(template: string, scope: Scope, partial = false): string {
	let source = template;
	if (partial) {
		const open = source.lastIndexOf("{{");
		if (open >= 0 && source.indexOf("}}", open) < 0) source = `${source.slice(0, open)}…`;
	}
	if (!source.includes("{{")) return source;
	return source.replace(TEMPLATE, (_match, expression: string) => {
		try {
			return display(evaluate(expression.trim(), scope));
		} catch {
			return partial ? "…" : "‹?›";
		}
	});
}
