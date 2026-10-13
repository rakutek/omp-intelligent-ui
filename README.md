# omp-intelligent-ui

Interactive answer cards for [omp](https://omp.sh) ([oh-my-pi](https://github.com/can1357/oh-my-pi)).

Instead of answering only in prose, the model can compose a card — text, SVG drawings, charts, tabs, sliders, buttons — that draws into the chat while it is still being written. Open the card full screen to operate it with the keyboard or mouse; what you change reaches the model with your next message.

Inspired by OpenAI's [Intelligent UI](https://openai.com/index/gpt-6-for-everyone/), rebuilt as an omp extension.

## What it does

- **The model picks the form.** A `ui` tool and a short system-prompt note let the model decide per answer: plain text when that reads best, a card when seeing or operating the answer helps (how something works, comparisons, plans, estimates, quizzes, small games).
- **Streams as it is written.** A card renders on every update of its arguments; drawings re-rasterize as their SVG arrives.
- **Operable.** `ctrl+n` or `/ui` opens the latest card full screen. Tabs, sliders, number and text fields, selects, toggles and buttons update everything bound to them live — drawings can spotlight the part a tab selects, charts can be generated from slider values.
- **Shares state.** When you close a card you changed, its state is attached to your next message. Buttons marked `↗` send a message for you.

## Requirements

- omp in its interactive terminal UI. Cards are off in print and RPC modes and in subagents. Tested with omp 18.10.3.
- For drawings and charts as images, a terminal with inline graphics (Kitty graphics, iTerm2 or Sixel — e.g. Ghostty, kitty, WezTerm, iTerm2). Elsewhere they fall back to text.

## Install

From the marketplace in this repository:

```
/marketplace add rakutek/omp-intelligent-ui
/marketplace install intelligent-ui@rakutek
```

Or as a package:

```
omp install github:rakutek/omp-intelligent-ui
```

Start a new omp session afterwards. To try it without installing:

```
git clone https://github.com/rakutek/omp-intelligent-ui
omp -e ./omp-intelligent-ui/index.ts
```

## Use

Ask something that benefits from a visual answer — "break down the design of a 7-speed bike", "make me a savings calculator", "plan a day trip to Hakone". The card appears in the transcript as the model writes it, with a hint under the editor once it is done.

| Key | Action |
|---|---|
| `ctrl+n` or `/ui` | Open the latest card full screen |
| `/ui list` | Pick any card from this session |
| `tab`, `↑` `↓` | Move focus |
| `←` `→` | Adjust the focused control (`shift` for big slider steps) |
| `enter`, `space` | Press a button, flip a toggle, step to the next tab or option |
| `1`–`9` | Choose a tab or option by position |
| click, wheel | Operate tabs, buttons, options and slider tracks; scroll |
| `PgUp` `PgDn` | Scroll |
| `ctrl+r` | Reset the card |
| `esc` | Close |

## Card components

- Content: `text` (Markdown), `callout`, `stats`, `table`, `timeline`, `progress`, `figure` (SVG), `chart` (bar, column, line, area, pie — from a table or generated from expressions), `divider`
- Layout: `card`, `columns`, `tabs`
- Controls: `slider`, `number`, `input`, `select`, `toggle`, `button`, `buttons`

Values are bound with a small expression language: arithmetic, comparisons, `a ? b : c`, and functions such as `round`, `fmt`, `pct`, `pmt` and `fv`. It has no property access and never runs JavaScript; `rand` and `randint` work only in button actions. The full reference the model reads is in [`src/guide.ts`](src/guide.ts).

## Limitations

- Cards are operated in the full-screen view: omp does not route keyboard or mouse input to components inside the transcript.
- The extension relies on omp internals that are not stable API — how streaming tool arguments reach renderers, full-screen overlays, inline image placement. A future omp release may need an update.
- The tool description adds about 1.5k tokens to every request while the extension is loaded.
- Like every omp extension, it runs inside omp with your permissions.

## Development

```
bun test        # unit tests
bun run check   # type check
```

Both resolve `@oh-my-pi/*` from `node_modules`. Link them to your omp installation, for example for a Bun global install:

```
mkdir -p node_modules
ln -s ~/.bun/install/global/node_modules/@oh-my-pi node_modules/@oh-my-pi
ln -s ~/.bun/install/global/node_modules/@types node_modules/@types
```

## License

[MIT](LICENSE)
