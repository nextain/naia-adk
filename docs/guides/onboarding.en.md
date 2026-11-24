[English](onboarding.en.md) | [한국어](onboarding.ko.md)

# Getting started with Naia ADK

In this workspace you work by talking with AI. Tell it what to do as if you
were asking a person, and the AI reads the company documents and procedures
and does the work. Jobs that need to go to another machine or another AI are
queued by the AI, and when a document needs a human decision the AI asks you
to "please look at this document" and waits for your answer.

You have three jobs: ask the AI by talking, watch progress on the browser
dashboard, and read and answer the documents the AI asks you to look at. No
commands to memorize.

## What the workspace looks like

The workspace is the single folder where you received naia-adk. Inside it you
receive two more things:

- Company documents go under `data-company/`. Onboarding, company
  introductions, and work procedures live there.
- Shared collaboration projects go under `projects/`. The work queue and work
  board live there.

Always launch AI from the top folder (the one where you received naia-adk).
That way the AI sees the company documents and the collaboration projects at
once and follows the workspace rules. Do not launch it from inside
`projects/`.

## Getting started

The only thing you prepare is one AI tool. Install Claude Code or the Naia
app, and get the company document repository address and a GitHub organization
invitation from your company administrator.

1. Receive the workspace. The Naia app handles this on its first setup
   screen. With Claude Code, launch it from any folder and say "receive
   naia-adk and move it to my private repository".
2. Launch AI from the received folder (the top folder). If Claude Code asks
   whether to trust this folder, answer yes — otherwise it will ask for
   approval on every setup command. Then say:

   > Let's get started. The company document repository is <the address you received>.

The AI checks the tools it needs, receives the company documents and
collaboration projects, launches the dashboard, and tells you the browser
address (`http://localhost:3142/docs`). If something needs installing, the AI
asks you first.

## How to work every day

### Starting the day

Launch AI from the top folder and say "let's get started". The AI pulls the
latest content and, if the dashboard is off, launches it and tells you the
address.

The dashboard has two tabs:

- The "Docs" tab shows company documents. Onboarding, company introductions,
  and work procedures live there.
- The "Work" tab shows how far the jobs you gave the AI have come. The screen
  is split into "in progress", "needs review", and "recently finished".

At the top right you can switch the theme (`light` / `dark` / `system`,
default `system`) and the text size (four steps: `small` / `medium` / `large` /
`extra large`, via `A−` / `A+` or step selection) for your reading
environment. Your choices are remembered in the browser and kept next time you
open it.

### Asking by talking

The AI reads the workspace rule files on its own at startup, so it already
knows the company procedures — just ask as if you were asking a person.

> Read the onboarding document and organize what I should do in my first week.

> Let's plan this week's content together. When it's decided, put it on the work queue.

> How far did yesterday's job get?

Whether to queue a job or hand it to another machine is decided by the AI
following its procedures, and it asks you. You never need to touch queue
files or commands yourself.

### Checking documents the AI asks you to review

When the AI needs a human decision, it writes it up as a document and asks
for review. The request appears in the "needs review" section of the Work
tab. Clicking "view document" on the card opens that document in the Docs
tab. Read it and answer by talking to the AI, e.g. "I read this document,
let's go this way".

## If you are a company administrator

Which company document folders the dashboard shows, and which shared projects
members receive together, are decided by a single `adk-company.json` file in
the company document repository. See the [company config guide](company-config.en.md).

## If you prefer doing it by hand

To do by hand what the AI does, run the following from the top folder. You
need Git, Node.js 22+, and pnpm 9+.

```bash
git clone https://github.com/nextain/naia-adk.git
cd naia-adk
git remote rename origin upstream
git remote add origin <your private repository address>
git push -u origin main

pnpm install
pnpm adk:setup -- --company <company document repository address>   # first time only
pnpm adk:setup -- --pull                             # pull latest every day
./start.sh                                           # dashboard (start.bat on Windows)
```

Keeping the public ADK as `upstream` is so you can pull in new features
later. Your work history and company settings only ever go to your private
repository (`origin`).
