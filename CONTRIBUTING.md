# Contributing to NOMO

Thanks for your interest in NOMO. It is an open-source, self-hostable AI trading chat: you talk to Claude, it researches ideas and proposes trades, and every order stops at a mandatory confirmation gate before anything reaches your broker. Contributions of all sizes are welcome, from bug fixes to docs to new features.

Please read the short list of non-negotiables below before you start. NOMO connects to a real brokerage account, so a few rules exist to keep it safe.

## Ground rules (please read)

1. **Never weaken the confirmation gate.** No stored fact, flag, debug mode, or environment variable may let an order reach the broker without an explicit user confirmation. The only path to a Robinhood execution tool is a `PendingOrder` in `confirmed` status. If your change touches order flow, it must preserve this, and your PR should say how.
2. **No secrets in the repo, ever.** All keys and tokens live in the local SQLite database or your `.env`, both gitignored. A pre-commit hook and a CI job fail if a `.env` or a `.db` file is staged. Do not commit real account numbers, API keys, or personal data.
3. **Test against the mock, not the real broker.** Order-flow tests run against the mock Robinhood MCP in `server/tests/mocks/`. Do not write tests or scripts that place real orders.
4. **Determinism stays in code.** The LLM interprets and decides; numbers (indicators, P/L, ratios) are computed in TypeScript. Do not ask the model to compute figures a tool can return.

## Getting set up

Prerequisites:

- Node.js 20 or newer
- An [Anthropic API key](https://console.anthropic.com/)
- A free [Polygon.io](https://polygon.io/) API key
- A Robinhood agentic account is optional until you work on portfolio or trading features

```sh
git clone https://github.com/Ut8v/NOMO.git
cd NOMO
npm install
npm run dev
```

`npm run dev` starts the Express backend on `:3001` and the Vite frontend on `:5173`. Open http://localhost:5173 and follow the setup screen to enter your keys (they are stored locally, never committed).

## Project layout

This is an npm-workspaces monorepo:

- `frontend/` React + Vite chat UI, charts, confirmation cards, settings
- `server/` Express backend, chat loop, tiered tool registry, confirmation gate, SQLite, agents
- `shared/` TypeScript types shared by both

## Development workflow

Run these before opening a pull request:

```sh
npm run typecheck              # type-checks every workspace
npm test --workspace server    # server unit and integration tests
npm run build --workspace frontend   # confirm the frontend builds
```

Notes:

- Server tests use Node's built-in test runner via `tsx` and a mock Robinhood MCP, so they never touch the real broker.
- Database changes go through append-only migrations in `server/src/db/migrations.ts`. Never edit an applied migration; add a new one with the next id.
- New model-facing tools are registered in the tiered registry (`server/src/tools/`), with an explicit tier. Execution-tier tools only create a pending order.

## Pull requests

- Branch off an up-to-date `main`.
- Keep commits small and focused: one logical change per commit (a migration, a component, a route, a test), not one giant commit.
- Use plain, conventional commit messages, for example `feat: add stop-limit orders` or `fix: expire stale pending orders`.
- Make sure typecheck, tests, and the frontend build pass. CI runs the secret guard and typecheck on every PR.
- In the PR description, explain what changed and, if you touched order flow, how the confirmation gate remains intact.

## Style

- TypeScript throughout. Match the style of the surrounding code.
- Comments explain why, not what, and only where genuinely needed.
- Keep user-facing copy and docs plain and free of em dashes (use commas or parentheses).

## Reporting bugs and ideas

Open an issue with clear steps to reproduce, what you expected, and what happened. For anything security-sensitive (especially around the confirmation gate, credential handling, or account data), please describe the concern in an issue without including any real secrets or account numbers.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the same license as the project.
