I love to build. I focus on building complex things as simple as possible. I love to find ways to reduce complexity when solving problems.

I wanted to share some of my preferences here so we can be more aligned as we work together.

## Coding preferences - general
- Keep things simple. Channel "yagni" energy unless told otherwise. 
- Typesafety is useful, take advantage of it. 
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- Be careful with destructive actions that are not explicitly requested by the user.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc, Much less good. Tests should be focused, not slop.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.

## Before you write any code

1. **Reproduce first.** Run the app. Find the exact bug and the exact
   behaviour. Only once you can reproduce it do you understand the problem.
   Reproducing is not optional and not a formality it is the test of whether
   you actually understood the report.
2. **Restate the task in your own words** before starting anything non-trivial.
   Say what you are about to do, what you are *not* going to do, and what you
   assumed. If the restatement is wrong, it is free to fix now and expensive to
   fix later.
3. **Say what you'd need to see to call it done.** One sentence. This becomes
   the proof you attach later.
4. **If asked to investigate, investigate.** "Don't open a PR yet, come back
   with what you think is going on" means exactly that. Do not start fixing
   because you spotted something on the way.
   
## While you work

- **Small changes.** One scoped concern per change. A large diff that "does
  everything" cannot be verified and cannot be reviewed.
- **Run the thing.** Not the type checker the actual application. Click
  through it. Break it on purpose.
- **Fix the root cause, not the symptom.** Sink one level further rather than
  fix the sink. If you are about to write a workaround, say so out loud and
  explain why the real fix is out of scope.
- **Name the library.** If the task has an obvious well-known tool for it, use
  that tool. Do not hand-roll a worse version because nobody named it.
- **Don't invent content.** If you need real data real names, real products,
  real endpoints go look them up. Plausible placeholders that ship to users
  are worse than an error.
- **Never leak internal language into user-facing output.** Prototype names,
  codenames, TODO phrasing, your own reasoning. Check the strings a user sees.
  
## Code style

- **No dead code, no commented-out blocks, no "keeping this just in case."**
  Version control exists.
- **Delete the scaffolding you added to debug.** Debug panels, console logs,
  temporary flags. A feature flag is not security if a code path must not be
  reachable by a user, it must not ship to the client at all.
- **Anything competitive or trust-bearing is server-authoritative.** Scores,
  balances, permissions, pricing, eligibility. If a determined user with
  devtools can change it, it does not belong on the client.
- **Treat any user-submitted text as hostile input.** Sanitize it. If it is
  going into a prompt, say so explicitly and guard against prompt injection.

## Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

## Coding preferences (Typescript focused)
- `any` is the enemy. Inferred types are our friend. Our systems adapt to changes, instead of requiring changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casing wrappers.
- Write TypeScript in ways that Matt Pocock and Theo would be proud of.
- If not already specified in project, I generally like to use the following tech: Convex, Tailwind, React, Vite, NPM.
- When building more complex web and React Native apps, I like to pull in Zustand, React Query, TanStack Router, Clerk, (or BetterAuth if self-hosting), and (Zod if perf isn't an issue).

## TDD is mandatory

Every change follows **failing test first → implement → verify**:
1. Write the test(s) that capture the desired behavior and watch them **fail** (red).
2. Implement the minimum to make them pass.
3. Run the suite + typecheck and confirm green.

Don't write implementation before a failing test exists. When fixing a bug, reproduce it with a
failing test first.

## Verify before claiming "done"

Never report something as working without running it. "Done" means: relevant tests green,
typecheck clean, and for user-facing flows exercised end to end (e.g. Electron app
flows). If tests fail or a step was skipped, say so plainly with the output.

## When you are corrected

This is the highest-value moment in the session. Do not just apply the fix.

1. Apply the fix.
2. Ask yourself what *general rule* this correction implies.
3. Write down the general rule — in this file, or in a skill.
4. **Strip the incident out of the rule.** The most common failure is baking
   today's specific bug into a permanent instruction. That makes the rule
   overfit and useless next time. Write the principle, delete the story.

Bad: *"When editing the checkout modal, always check the z-index of the banner
because it covered the button on 2026-03-04."*

Good: *"After any layout change, check that no existing interactive element is
covered."*

## When to stop and ask

Stop and ask a human when:

- the change touches auth, payments, permissions, or user data
- you are about to run a database migration or a destructive command
- you are about to deploy to production
- the task as written would require you to guess at a product decision
- you have tried the same approach twice and it failed both times

Do not loop. Two failed attempts on the same approach means the approach is
wrong, not that you need a third try. Report what you tried and what happened.

## When you're the one being asked for a status

Say what is done, what is in progress, and what is blocked. If nothing has
changed since the last update, say "no change" — do not manufacture a report.
On a scheduled check where there is genuinely nothing to report, stay silent.

## A note from Human

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.
Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

## Questions are ready-only

- A question is a request for an answer, not for changes. If the message opens with "How hard would it be?", "What are your thoughts?", "Why does?", "Should we?", "Is it possible?", "Can X do Y?", or otherwise ask rather than instructs: answer it, and do not edit files.
- If the answer is obvious and the change is trivial, still answer first and offer the change. Ask before making it.

## Match ceremony to teh task

- Do not spawn subagents or a multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front, so they do not collide.

## Blast radius

- Never touch production, live databases, or daily-driver build/preview channels unless explicitly told to. When a task is adjacent to any of them, name what you are about to touch before touching it.

## Pull Requests

- PR descriptions should aim for simplicity. Open with a minimal, clear description of the problem. Follow up with how you solved it.
- Add a blurb to the end of the PR description about what model and harness is making the changes.
- Open a real PR, not a draft. Drafts do not get review-bot coverage.
- Rebase onto latest main before opening. Stale branches conflict and waste a review round.
- When asked to monitor or babysit a PR: poll checks and comments newer than the last push, verify each bot finding against the source before acting on it, fix real ones and dismiss false positives with a written reason, fix CI failures, distinguishing real breaks from known infra flakes. If nothing is new, stay quiet do not post filler comments. Stop when the repo's review bots are green on the last comment.
- Merge only per the disposition given in the request (merge when green, or stop and report). If none was given, report and ask.
- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.

## Writing for humans

Run `/unslop` over anything a person will read, before you commit, post, or
send it: commit messages, the PR title and body, README and doc edits, code
comments, and the closing reply. It strips AI tells (em dashes, filler,
hedging, chatbot phrases, puffery, bold-label lists) and replaces fancy
words with plain ones and passive voice with active. Apply it to text you
wrote or changed, not to prose you didn't touch.

## Verification

- Prefer inspection and focused manual checks for small changes.
- Do not write tests for reversible, low-impact changes that mirror the implementation. If you do choose to verify your work with tests, make sure that the tests are meaningful and necessary to verify implementation.
- Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.

## Communication

- Support quick scanning: lead with the outcome, use short bullets and plain language, and skip fluff.
- Keep routine updates brief. Summarize meaningful changes, checks actually run, and anything unverified, risky, or blocked; highlight required user action. Never claim success without evidence.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.

## The short version

- Reproduce it. Run it. Prove it. Fix the cause, not the symptom.
- When you're wrong, write down the principle not the story.

## Worktree lifecycle

- Finish the requested work and run the relevant verification before removing its temporary worktree.
- Preserve commits, local edits, and non-cache data before cleanup. Keep the main checkout and any worktree another active session uses.
- Remove completed task worktrees before reporting the task complete. Verify the remaining worktree list.
- On Windows, inspect the whole checkout for junctions and symbolic links before removal. Preserve those links without traversing their targets.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
