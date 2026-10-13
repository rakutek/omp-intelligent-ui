/** What the model reads: the `ui` tool's description and the system-prompt note on when to reach for it. */

export const TOOL_DESCRIPTION = `Render an interactive card in this terminal chat — text, drawings, charts and controls the user can operate. The card draws progressively while you write the arguments, in order: put the overview first.

Use it when seeing or manipulating the answer beats reading it: how something works (a labelled drawing whose parts light up per tab), comparisons (columns of cards, tables), plans, recipes and itineraries (timeline), estimates and calculators (controls + computed stats + chart), quizzes and small games, data worth charting. Keep plain text for short facts, opinions, chat, code and repository work. Put the substance inside the card; outside it write one short sentence at most, and never restate the card after the tool returns.

Arguments: {title, subtitle?, state?, computed?, body: [node…]}
- state: initial variables {name: number | string | boolean}.
- computed: {name: "expression"}, recomputed live in order; later entries may use earlier ones.
- Text fields embed {{expression}}: "Total ¥{{fmt(total)}}". Any node may carry "when": "expression" to show only while true.

Nodes (write "type" first):
- text {text}: Markdown — headings, lists, bold, tables, $math$, \`\`\`mermaid fences.
- callout {tone: info|tip|success|warning|error, title?, text}
- stats {items: [{label, value, unit?, note?, tone?}]}: headline numbers as tiles.
- table {columns: [...], rows: [[...]], caption?}
- timeline {items: [{time?, title, text?, tone?}]}: steps, schedules, routes.
- progress {label, value, max?, text?}: value/max are expressions.
- figure {svg, caption?, highlight?, parts?}: an SVG drawing — diagrams, illustrations, maps, floor plans. viewBox about 640×320 (16 units = 1 text row; font-size 13–16). Colors only var(--fg|muted|border|surface|accent|success|warning|error|c1…c6); no background rect, scripts, foreignObject or external images. Wrap each part in <g id="…">. With "highlight": "<state var>", parts listed in "parts" (default: the options/tab values of the control with that id) fade except the one equal to the variable; a value naming no part ("all") shows everything.
- chart {kind?: bar|column|line|area|pie, title?, columns: [label, series…], rows: [[label, n…], …]} — or generated from state: {kind, x: {name, from, to, step?}, series: [{name, expr}]}, expr evaluated at each x (by its name, or as x).
- divider {}
- card {title?, body: [...]}: a bordered group.
- columns {items: [node…]}: side by side, stacking when narrow; for comparisons. Drawings inside columns show as their captions — keep figures and charts outside columns.
- tabs {id, tabs: [{label, value?, body: [...]}]}: state[id] = the active tab's value (default: its label).
Controls write state[id]; everything depending on it updates live:
- slider {id, label, min, max, step?, value?, unit?, prefix?, digits?}
- number {id, label, value?, min?, max?, step?, unit?, prefix?}
- input {id, label, value?, placeholder?}
- select {id, label, options: [string | {label, value}], value?}
- toggle {id, label, value?}
- button {label, set?: {var: expression}, send?: "text", reset?: true, primary?: true}; buttons {items: [button…]}
  "set" assigns all at once from the pre-press state; rand() and randint(a, b) work only here; quote literal strings ("'won'"). "send" posts its {{…}}-filled text as the user's next message to you — use it for follow-ups, submissions and "plan it for me" actions.

Expressions: numbers, 'strings', true/false/null, + - * / % ^, == != < <= > >=, && || ! (and/or/not), a ? b : c, and abs ceil floor round(x, d) int sign sqrt exp log log10 pow min max sum avg clamp(x, lo, hi) if(c, a, b) fmt(x, d?) pct(ratio, d?) str num len upper lower pick(i, a, b, …) pmt(rate, n, principal) fv(rate, n, payment, principal?).

The user opens the card full screen (/ui or ctrl+n) to operate it with keys or the mouse. Their changes reach you as a note with their next message.

Example: {"title": "Index fund savings", "state": {"monthly": 30000}, "computed": {"total": "fv(rate/1200, years*12, monthly)", "paid": "monthly*years*12"}, "body": [{"type": "text", "text": "Monthly saving of ¥{{fmt(monthly)}} at a steady return."}, {"type": "slider", "id": "rate", "label": "Annual return", "min": 0, "max": 10, "step": 0.5, "value": 4, "unit": "%"}, {"type": "slider", "id": "years", "label": "Years", "min": 1, "max": 40, "value": 20, "unit": "years"}, {"type": "stats", "items": [{"label": "Final balance", "value": "¥{{fmt(total)}}"}, {"label": "Gain", "value": "¥{{fmt(total - paid)}}", "tone": "success"}]}, {"type": "chart", "kind": "area", "title": "Balance by year", "x": {"name": "year", "from": 0, "to": "years"}, "series": [{"name": "Balance", "expr": "fv(rate/1200, year*12, monthly)"}, {"name": "Paid in", "expr": "monthly*year*12"}]}]}`;

export const SYSTEM_GUIDE = `## Intelligent UI
The \`ui\` tool renders interactive cards — drawings, charts, tabs, sliders, buttons — inside this chat. Judge each answer: plain text when it reads best; a \`ui\` card when seeing or operating the answer helps materially (explaining how something works, comparing options, planning, estimating, learning step by step, playing). Not for coding or repository work.`;
