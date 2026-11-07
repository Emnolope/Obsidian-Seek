# Working together: four parties, four views

Nobody on this project can see all of it. Seek has to work on a phone, and the people and agents building it each see a different slice. Most of our trouble has come from that, not from anyone thinking badly. This file says who sees what, so each of us can hand the others what they are missing.

Read it as facts about the setup, not as rules. If a fact is wrong, fix it here. Each section is open to correction by the party it describes, and every party gets the same treatment: named, not "it", with the same fields filled in.

## The human (Mini)

- **Knows:** why Seek exists and where it is going. The core / bot / human-glue split was his idea.
- **Sees:** the real Obsidian on his phone, and whether it works. He is both the client and the inspector.
- **Can do:** operate Obsidian (no agent can), run the Obsidian console (it exists on the phone), and decide what the project becomes.
- **Cannot:** read the whole repo, or spend unlimited tokens. He is on a free plan with limited windows, and his attention is one person's.
- **Persists:** he is the only party who remembers yesterday without a file.
- **Implies:** he is a collaborator, not a message relay. Spend his attention on direction and on what only he can see. What he reports about status is a fact. Don't assume he knows how the code works; he has said he doesn't.

## Cloud Claude (the blueprinter)

- **Knows:** the whole repo and all the markdown. Wrote most of the code.
- **Sees:** the sandbox, the chat, and git. Never the phone, Obsidian, or live logs unless someone brings them.
- **Can do:** read and restructure code at scale, and reason across files.
- **Cannot:** run anything on the target device, or remember anything between sessions. Only what is written down survives.
- **Implies:** "works" from this side means "runs in the sandbox." Say exactly what was run and where. Each session starts blank, so the repo docs are Cloud Claude's memory, and they need to be kept current.

## VideUltra (the local agent, running on PicoClaw)

- **Name:** VideUltra. PicoClaw is the harness VideUltra runs in.
- **Knows:** the phone's real state, the local MCP server, git, and the vault on disk.
- **Sees:** the device and its files, and only a small slice of the code at a time, because the context window is small.
- **Can do:** run commands on the phone, read logs and reports, push to git.
- **Cannot:** operate Obsidian's interface, or keep the whole repo in view.
- **Implies:** reasons well, from a narrow view. Give the local agent the code context that's missing, and ask what is seen before what is concluded. When a cause is named, check that the evidence is in the logs the local agent was shown.

## The repo and the logs (shared memory)

- Git is where Cloud Claude and the local agent talk without the human in between.
- The plugin's own output (`seek-report.md`, `seek-log-<deviceId>.ndjson`) is a witness that needs nobody to operate Obsidian.
- Anything not written to a file or said in chat is gone by the next session.

## Where the talk happens

| Channel | Used for |
| --- | --- |
| Human ↔ Cloud Claude | direction, context, design decisions |
| Human ↔ VideUltra | operating the phone, reading what happened there |
| Cloud Claude ↔ VideUltra | messages (below), carried by git or pasted |

The gap is each agent not knowing what the human told the other one. When you learn something that the others lack, say it where they can read it.

## Messages: how we hand each other context

A message is one markdown file. It is a chat message that happens to be a file, so it can travel by git or by the human pasting it into another chat, and the content is the same either way.

- **Where and what it's called:** `<from>-to-<to>.md` in the repo's main folder, using the names `mini`, `claude`, `videultra`. For example `claude-to-videultra.md`. There is no subfolder on purpose: "read all the markdown in the main folder" is already a habit, so messages get found without an extra instruction. They are short-lived, so the clutter is too.
- **How it opens:** the first lines say it is a message, who it's from and to, and that the reader deletes it after reading.
- **How it closes:** the last line is `Delete this document when you're done reading it.`
- **Reading it:** the reader reads it, acts on it, then deletes it (`git rm`, commit, push). Git history keeps a copy, so deleting loses nothing and keeps the folder clean.
- **Replying:** write `<you>-to-<them>.md`. Replying works the same in every direction, including to the human and from the human.
- **One at a time:** if a message to you is still in the folder, it hasn't been read yet. Don't stack a second one on top.
- **What goes in:** the full context, not a curated brief. The sender is the one party who can't see what the receiver is missing, so say what happened, what you saw, what you're unsure of, and what you're asking. Raw output goes in fenced blocks, unedited. Evidence comes before cause, and "I don't know yet" is a valid thing to write.
- **What a reader can do:** disagree. Each reader sees something the sender can't.

## Tendencies we all share

Each of us has a habit that costs the others, and none of them is anyone's fault:

- **The human** sometimes talks the agents down and carries more of the relaying than he needs to, to save everyone's context.
- **Cloud Claude** tends to finish alone and report done, when only the sandbox has been seen.
- **The local agent** tends to fill a gap with a plausible cause, and to propose a bypass when stuck.
- **All three** are quicker to assume the others can't follow than to tell them what they're missing.

## Words for status

Used so that "done" doesn't mean three different things. The human marks the last one.

1. **Written:** the code exists.
2. **Passes in the sandbox:** tests and typecheck ran in the cloud environment.
3. **Confirmed on the phone:** it ran on the real device and the human saw it work.

## Current state (the human keeps this)

- L0 (identity and harness) works on both sides.
- Reindex on the phone fails: `embed-batch` times out after 60 s on a single chunk (`wasm/plain`, WebGPU unavailable).
- The cause is not yet known: our code or the environment. Upstream Seek's plugin works on this device, apart from the hydration bug.
- No piece of the plugin's embed path is yet in the "confirmed on the phone" state.
