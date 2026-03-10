# AI Release Notes with Ollama

[![CI](https://github.com/maikebing/ai-release-notes/actions/workflows/ci.yml/badge.svg)](https://github.com/maikebing/ai-release-notes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A GitHub Action that generates professional AI-powered release notes between two git tags using a locally running [Ollama](https://ollama.com/) model — no external API keys required.

---

## Features

- 🔖 Compare any two git tags and extract the commit log
- 🔍 **Auto-detects** current and previous tags — works with zero configuration on tag pushes
- 🤖 Auto-installs and starts **Ollama** on the GitHub Actions runner
- 📦 Pulls a small, fast LLM (e.g. `qwen2.5:0.5b`)
- 🌏 Generates release notes in **Chinese**, **English**, or **bilingual**
- 📊 Optionally includes file-level diff statistics
- 📤 Exposes `release_notes`, `commits`, `current_tag`, and `previous_tag` as job outputs
- 📋 Appends a rich summary to **$GITHUB_STEP_SUMMARY**

---

## Usage

### Minimal example (fully auto-detected)

If triggered on a tag push, both `from_tag` and `to_tag` are detected automatically:

```yaml
on:
  push:
    tags:
      - "v*"

jobs:
  release-notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate release notes (auto-detected tags)
        id: relnotes
        uses: maikebing/ai-release-notes@v1

      - name: Print detected tags
        run: |
          echo "Previous: ${{ steps.relnotes.outputs.previous_tag }}"
          echo "Current:  ${{ steps.relnotes.outputs.current_tag }}"
```

When run on a branch or manual trigger, the action uses the most recent reachable tag as
`from_tag` and `HEAD` as `to_tag`.

### Basic example (explicit tags)

```yaml
- name: Checkout with full history
  uses: actions/checkout@v4
  with:
    fetch-depth: 0

- name: Generate release notes
  id: relnotes
  uses: maikebing/ai-release-notes@v1
  with:
    from_tag: v1.0.0
    to_tag:   v1.1.0

- name: Print the output
  run: echo "${{ steps.relnotes.outputs.release_notes }}"
```

### Full example with all options

```yaml
- name: Checkout with full history
  uses: actions/checkout@v4
  with:
    fetch-depth: 0

- name: Generate bilingual release notes
  id: relnotes
  uses: maikebing/ai-release-notes@v1
  with:
    from_tag:        v1.0.0
    to_tag:          v1.1.0
    model:           qwen2.5:1.5b   # larger model = better quality
    language:        both            # zh | en | both
    include_diffstat: true           # attach file change stats to the prompt
```

### Trigger on tag push

```yaml
on:
  push:
    tags:
      - "v*"

jobs:
  release-notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate release notes (auto-detected)
        uses: maikebing/ai-release-notes@v1
        # No from_tag / to_tag needed — auto-detected from GITHUB_REF
```

---

## Inputs

| Name               | Required | Default                    | Description |
|--------------------|----------|----------------------------|-------------|
| `from_tag`         | ❌        | auto-detected              | Start git tag. Auto-detected as the previous tag reachable from `to_tag` if omitted. |
| `to_tag`           | ❌        | auto-detected              | End tag or ref. Auto-detected from `GITHUB_REF` (tag push) or `HEAD` if omitted. |
| `model`            | ❌        | `qwen2.5:0.5b`             | Ollama model name |
| `language`         | ❌        | `zh`                       | Output language: `zh`, `en`, or `both` |
| `include_diffstat` | ❌        | `false`                    | Include file change statistics in the prompt |
| `ollama_host`      | ❌        | `http://127.0.0.1:11434`   | Ollama server URL |

## Outputs

| Name            | Description |
|-----------------|-------------|
| `release_notes` | Generated release notes in Markdown format |
| `commits`       | Raw commit log between the two tags |
| `current_tag`   | The resolved "to" ref (detected or provided) |
| `previous_tag`  | The resolved "from" ref (detected or provided) |

---

## Recommended models

| Model             | Size   | Notes |
|-------------------|--------|-------|
| `qwen2.5:0.5b`    | ~0.5 GB | Fastest; good for CI pipelines |
| `qwen2.5:1.5b`    | ~1.5 GB | Better quality, reasonable speed |
| `llama3.2:1b`     | ~1.3 GB | Good English output |
| `qwen2.5:7b`      | ~7 GB  | High quality; slow on CPU |

> **Tip:** Start with `qwen2.5:0.5b` to validate your workflow, then upgrade once you're happy.

---

## Notes & caveats

1. **Full history required** — always set `fetch-depth: 0` on `actions/checkout`, otherwise the tags may not be reachable.
2. **Download time** — Ollama itself and the model are downloaded at runtime. On a GitHub-hosted runner with a fast connection, `qwen2.5:0.5b` takes ~1–2 minutes.
3. **CPU inference** — GitHub-hosted runners have no GPU. Keep models small for a reasonable execution time.
4. **No external API keys** — everything runs locally inside the runner; your code never leaves GitHub's infrastructure.
5. **Commit quality matters** — the better your commit messages (e.g. [Conventional Commits](https://www.conventionalcommits.org/)), the better the generated notes.

---

## Development

### Prerequisites

- Node.js 20+
- `npm`

### Local build

```bash
npm install
npm run build        # produces dist/index.js via @vercel/ncc
npm run build:check  # verify dist matches src
```

### Project structure

```
├── action.yml          # Action definition (inputs, outputs, branding)
├── package.json
├── package-lock.json
├── README.md
├── LICENSE             # MIT
├── .gitignore
├── scripts/
│   └── check-dist.js   # CI helper: fails if dist is stale
├── src/
│   └── index.js        # Action source
├── dist/
│   └── index.js        # Compiled bundle (committed to repo)
└── .github/
    └── workflows/
        ├── ci.yml       # Build verification on every push/PR
        └── release.yml  # Manually triggered tag + GitHub Release creation
```

---

## Publishing to GitHub Marketplace

1. Ensure `action.yml` has a unique `name`, valid `branding`, and all `inputs`/`outputs` documented.
2. Run `npm run build` and commit `dist/index.js`.
3. Create a release via the **release.yml** workflow (or manually):
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. On the GitHub Releases page, check **"Publish this Action to the GitHub Marketplace"**.
5. Optionally maintain a floating major tag:
   ```bash
   git tag -f v1
   git push -f origin v1
   ```

---

## License

[MIT](LICENSE) © maikebing
