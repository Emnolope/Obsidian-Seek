# Piloting Obsidian on the phone from Termux

**Goal:** VideUltra can run JavaScript inside the phone's Obsidian and read the console, the way Mini does by hand today, so Mini stops being the relay for tests.

**Status: untested.** Nobody has run this chain on the phone yet. The first run is the experiment.

## The chain, in one breath

Obsidian on Android is a WebView app, and Obsidian's docs say it can be inspected with Chrome remote debugging (documented over USB). Termux's `android-tools` can pair with the same phone's Wireless debugging on `localhost`. If both work, VideUltra can reach Obsidian's inspector (the Chrome DevTools Protocol, "CDP") and send it `Runtime.evaluate`, which is what the official desktop CLI's `eval` does.

## Who does what

- **Mini:** taps in Settings, opens and keeps Obsidian in front, reads two port numbers off the screen, says "go".
- **VideUltra:** runs the adb and curl commands, reports results verbatim.
- **Claude:** reads the results, then writes the small `tools/obs` script (verbs `eval`, `console`, `errors`, `screenshot`, `command`) once the chain works.

## The order

Steps run top to bottom. Stop at the first step that fails, and use "If it fails" below.

| # | Who | Do | Done when |
| --- | --- | --- | --- |
| 1 | Mini | Get the latest repo to VideUltra (`git pull` in VideUltra's checkout, or paste `claude-to-videultra.md` and this file into the chat). Tell VideUltra: "read all the markdown in the main folder." | VideUltra says it read both files |
| 2 | VideUltra | Run `getprop ro.build.version.release`, then `pkg install android-tools`, then `adb version`. Put the results in `videultra-to-claude.md`. | Android is 11 or newer, and adb is installed |
| 3 | Mini | Settings → About phone → tap Build number 7 times (skip if Developer options already exists). Developer options: turn on **Wireless debugging**. Optional: turn on "Stay awake" while charging, so the screen stays on. | Wireless debugging is on. If it won't turn on, tell VideUltra and Claude. |
| 4 | Mini and VideUltra together (time-sensitive) | Mini: Wireless debugging → **Pair device with pairing code**. The dialog shows a 6-digit code and a port. Android usually closes it when you leave the screen, so put Termux next to Settings in split-screen. Send VideUltra the port and code right away. VideUltra: `adb pair localhost:<port> <code>`. | Output says `Successfully paired` |
| 5 | Mini, then VideUltra | Mini: read the **main** Wireless debugging screen's "IP address & Port" (a different port from step 4) and send the port. VideUltra: `adb connect localhost:<port>`, then `adb devices`. If the phone asks "Allow debugging?", Mini taps Allow. | `adb devices` lists `localhost:<port>   device` |
| 6 | Mini | Open Obsidian on the `music` vault and keep it **in front**, screen on. Tell VideUltra "Obsidian is up." | VideUltra is told |
| 7 | VideUltra | `adb shell cat /proc/net/unix \| grep devtools_remote`, and note the socket name. Then `adb forward tcp:9222 localabstract:<name without the @>` and `curl -s localhost:9222/json`. Obsidian must stay in front. | The JSON lists a page with a `webSocketDebuggerUrl` |
| 8 | VideUltra | Send one CDP `Runtime.evaluate` with `1+1` over that WebSocket URL (snippet in `claude-to-videultra.md`, Job 0). Do nothing else in Obsidian yet. | The result is `2` |
| 9 | VideUltra | Write all the output, verbatim, to `videultra-to-claude.md`, and tell Mini to bring it to Claude (or push it). Say which step passed last. | Claude has the output |
| 10 | Claude | Read it. If the chain worked, write `tools/obs` and push it. If it failed, read the failure, adjust this file, and say what to try next. | `tools/obs` exists, or a next step is written |
| 11 | Mini, then VideUltra | Mini: tell VideUltra to pull. VideUltra: run the first real checks through `tools/obs eval` (Claude will list them: the rung ladder, the `parity` embed, then a reindex with Obsidian in front). | Results are in a message to Claude |
| 12 | Mini | When you're not using it, turn Wireless debugging off. After a reboot or a Wi-Fi change, steps 4 and 5 may need repeating. | |

## If it fails

| Step | What you see | Probably means | Next |
| --- | --- | --- | --- |
| 3 | Wireless debugging won't turn on | It may need a Wi-Fi network connected (I believe, not confirmed). Any network will do, including a hotspot. | Tell Claude. If there's no way to get one, the fallback below applies. |
| 4 | Pairing refused or times out | Dialog closed, wrong port, or the code expired | Reopen the dialog and send a fresh port and code at once |
| 5 | Connect refused, or `offline` / `unauthorized` | Used the pairing port instead of the main-screen port, or the Allow prompt wasn't accepted | Re-read the port from the main screen; tap Allow |
| 7 | No `devtools_remote` line | Obsidian not in front or not running, or this build has WebView debugging off | Open Obsidian in front and retry. If still nothing, send every line from `/proc/net/unix` containing `webview` or `obsidian`. |
| 7 | `curl` refused or empty | The forward isn't set, or the socket name is wrong | Send the exact `adb forward` output and the socket line |
| 8 | No result, or an error | Raw output tells us | Send it verbatim |
| any | The port changes on every reconnect | Wireless debugging assigns a new port when toggled | Tell Claude; there may be a way to pin a port (unverified) |

**Fallback if this chain can't be made to work:** a small client plugin in Obsidian that polls a Termux server for jobs and posts results back. That is the pattern Termux Bridge uses (Obsidian calls out to Termux). Claude would write it. Until then, the console-relay with Mini continues.

## What is and isn't verified

- **Read in sources:** the official Obsidian CLI is documented for Windows, macOS and Linux only, and its `dev:` commands are Electron-based. Obsidian's docs say Android Obsidian can be inspected with Chrome remote debugging over USB. A Termux gist documents `adb pair` and `adb connect` against `localhost`. The OnePlus 6T got stable Android 11.
- **Not verified:** that wireless self-connect reaches Obsidian's WebView socket; the exact socket name (step 7 finds it by searching instead); the Wi-Fi requirement; whether pairing survives a reboot or a Wi-Fi change.
- **Seen in a headline only, not read:** an article about Google possibly restricting on-device adb over loopback in a future Android version. It shouldn't matter on Android 11.

## Boundaries

VideUltra uses adb only for these steps. No Android settings are changed (a Termux gist suggests a phantom-process setting; don't, without asking Mini first). No other apps are touched. Nothing runs in Obsidian beyond `1+1` until Claude has seen the results.
