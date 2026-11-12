# Trigger tests: Browser Agent CLI

Agensi's pre-publish rule: the skill should trigger on 5 of 5 relevant prompts and 0 of 5 unrelated ones. If it
triggers on fewer than 4 relevant prompts, the description is too narrow. If it triggers on more than 1 unrelated
prompt, it is too broad.

Status: **not yet run in an agent.** Run each prompt in a fresh session with the skill installed, tick the box when
the result is right, and record the agent and date. Run again after a model update.

## Should trigger

- [ ] Open https://example.com and tell me what the page says
- [ ] Fill in the sign-up form on staging with a test user
- [ ] Click the pricing link and read the plans
- [ ] Take a screenshot of the dashboard after the deploy
- [ ] Check that the login page loads and the button is enabled

## Should not trigger

- [ ] Call this REST API and show me the JSON
- [ ] Download all the PDFs from this site
- [ ] Search the web for the best laptop
- [ ] Write a Playwright test file for me
- [ ] Scrape 10,000 product pages in bulk

## Record

| Agent | Date | Relevant (of 5) | Unrelated that triggered (of 5) |
|---|---|---|---|
