# Browser agent CLI

An agent skill that lets your AI agent use a real headless browser from the shell: open a page, read it, fill forms, click, wait, take screenshots.

## What you get

- A simple loop the agent follows: open, read a snapshot with element refs, act on a ref, read again.
- Compact page snapshots, so large pages do not flood the agent's context.
- Stale-ref protection: the agent can never click an element that has changed since it last looked.
- Safety rules built in: page text is treated as data, secret fields are redacted, only `http` and `https` open, and you can limit the session to named domains.
- A clear error table, so the agent recovers from a problem or stops and tells you.

## What it needs

- The free, open-source `bac` command: https://github.com/FinnTech3/browser-agent-cli
- Node.js 20 or newer and Chromium for Playwright. The skill gives you the two install commands and waits for your go-ahead. It never installs anything by itself.
- Permission for your agent to run shell commands, and network access to the sites you name.

## How to use it

Ask your agent, for example:

- "Open https://example.com/pricing and tell me what the Pro plan costs."
- "Fill in the sign-up form on staging with a test user and tell me what happens."
- "After the deploy, check that the dashboard loads and take a screenshot."

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | The loop, snapshot format, waits, commands, errors, reporting and safety rules |
| `examples/session-transcript.md` | A real session from start to finish |

## Limits

One browser session at a time per session name. Chromium only. No file uploads or downloads, and JavaScript dialogs are dismissed automatically. The agent asks you before any step that spends money, sends a message or deletes data.
