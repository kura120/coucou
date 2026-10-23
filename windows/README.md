<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Peika icon">

# Peika for Windows

**Peika doesn't get a notch on a PC — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![Code: MIT](https://img.shields.io/badge/code-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Peika waving hello at launch">

---

## Install

Download **[Peika-Windows.msi](https://github.com/kura120/peika/releases/download/windows-latest/Peika-Windows.msi)**
(Windows Installer) or **[Peika-Windows-setup.exe](https://github.com/kura120/peika/releases/download/windows-latest/Peika-Windows-setup.exe)**,
always the newest version, and run it. The .exe installs for the current user only, with no admin prompt; the .msi may ask for admin rights.

**Windows will show a warning the first time — that's expected.** The installer isn't code-signed yet, so SmartScreen doesn't know the publisher:

1. A **"Windows protected your PC"** screen appears, with *Publisher: Unknown publisher*.
2. Click **More info** (*Informations complémentaires* in French). This reveals a **Run anyway** button.
3. Click **Run anyway** (*Exécuter quand même*). The installer starts normally.

This is only because the app isn't signed with a paid certificate yet. Peika is open source, and Microsoft Defender scans the installer as clean.

Microsoft Defender once flagged the installer by mistake (`Trojan:Win32/Wacatac.H!ml`,
a machine-learning false positive); Microsoft reviewed it and removed the detection.
If Defender still blocks it on your PC, update its definitions (`Update-MpSignature`
in PowerShell) and try again.

You can also [build it yourself](#build-it-yourself).

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Peikas">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Peika turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Peika peeks out |
| Click the small island | It opens. With **Settings → General → Open on hover**, resting the pointer on it is enough, and it folds again shortly after the pointer leaves (click inside to keep it open) |
| Click Peika | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Peika for two seconds | Hearts |
| Right-click Peika | The wardrobe: rest the pointer on an outfit to try it on, click to keep it. **Auto** dresses him for the season (witch hat in October, Santa hat in December…) |
| Drag Peika out of the island | He moves onto your desktop and hangs out there, in his outfit, watching your cursor. Drop him back on the island to bring him home |
| On the desktop: click / right-click / double-click Peika | Poke him / the wardrobe / he flies home. Drag him to move him |
| Drag a file onto the island | Peika turns into a box, swallows it, then offers to answer questions about it |
| Click a file in the session ticker | Its diff opens in the island; ↗ opens the file in VS Code, ‹ or `Esc` goes back |
| `Esc` | Closes the island |
| Put a file named like one of Peika's sounds (`finish.wav`, `approval.mp3`, `greet.m4a`…) in the sounds folder | It replaces that sound after **Settings → General → Reload sounds**. **Open sounds folder** shows the folder: `~/.config/peika/sounds` on Linux, `%APPDATA%\Peika\sounds` on Windows |
| Tray icon | Open, Weekly recap, Wardrobe…, Settings…, Pause, Quit |
| `Ctrl+Alt+Space` | Opens the chat, from any app |
| `Ctrl+Alt+A` | Jumps to the waiting permission or question |
| `Ctrl+Alt+T` | Brings the session's window forward ("Open terminal") |
| `Ctrl+Alt+F` | Windows: attaches the window in front (its app, its title, a browser's address) to a new chat. It shows on a chip you can take off before you send. Letting go of Peika on the desktop with `Ctrl` held over a window does the same |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | Next / previous pill |
| `Ctrl+Alt+S` | Mutes or unmutes Peika |
| `Ctrl+Alt+G` | Opens the wardrobe |
| `Ctrl+Alt+D` | Sends Peika to the desktop, or brings him home |
| `Ctrl+Alt+X` | Windows: dims the screen; drag out the part to capture (`Esc` or a right click cancels). Peika swallows it, and its card offers **Paste** (into the window you were in), **Copy**, **Ask** (a new chat about it) and **Draw on it** (opens it in Paint). The image stays in Peika's temp folder only while the card has it |
| `Ctrl+Alt+N` | Opens and closes the island (off until you turn it on) |
| In the open island: `Ctrl+→` `Ctrl+←`, `Ctrl+1`–`Ctrl+9` | Switch pills |
| In the open island: `Ctrl+↓` `Ctrl+↑`, `Ctrl+O` | Walk the open GitHub list, open the highlighted row |
| In the open island: `Ctrl+E` | Opens the latest edit's diff, or closes the diff |
| In the open island: `Ctrl+Enter`, `Ctrl+K` | Send, start a new chat |
| In the open island: `Ctrl+,`, `Ctrl+P` | Settings, keep the island open |

### Keyboard shortcuts

Every global shortcut can be changed or turned off in **Settings… → Shortcuts**:
click it and press the new keys. A combination another app already holds is
flagged *In use*, and two Peika shortcuts on the same keys are flagged *Used
twice*. While you record a new one, Peika lets go of its own so the keys reach
the recorder.

The defaults are not the Mac's `⌃⌥` letters. On Windows, `Ctrl+Alt` is `AltGr`,
so a global `Ctrl+Alt+E` would swallow every `€` typed on a French or German
keyboard. The defaults were checked against the AltGr layer of the French,
German, Spanish, Italian, Portuguese and Brazilian (ABNT2) layouts — that is why
pill switching uses the arrows rather than `[` `]`, and mute is `S` rather than
`M` (`AltGr+M` is `µ` in German). On top of that, Peika asks Windows what each
`Ctrl+Alt` combination types on the layouts you have installed and leaves any
that types a character unregistered, flagged *Types “ą”* in Settings: Polish,
for one, puts `ą` on `AltGr+A` and `ś` on `AltGr+S`. The recorder refuses such
a combination too.

Older Intel graphics drivers rotate the screen on `Ctrl+Alt+←` / `→`; if yours
still does, those two show up as *In use*. On Linux, Xfce and MATE keep
`Ctrl+Alt+D` to show the desktop, so there **Send Peika to the desktop** shows
up as *In use* until you give it other keys.

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a question from Claude Code shows its options to
pick from, a finished session shows what it did, and
your integrations sit in the coloured pills next to Peika.

A permission card or a question stays until you answer it: the mouse leaving
never folds it, it comes up even when the island is already open or another
pill is in front, and the pill you were on comes back once you answer. To keep
it for later, fold it with the **⌃** in its corner (or `Esc` in the island): the
island shrinks to its compact size and stays on screen, nothing is answered, and
opening it again shows the card. **Open terminal** brings the window the session
runs in to the front.

When Peika lives on the desktop, he flies back to the island with a permission
request or a question and returns to his spot once you have answered; he does a
little jump when a task finishes, and dozes off when nothing has happened for
two minutes and your cursor is elsewhere — asleep, he costs nothing: no cursor
polling, a few frames a second. He remembers his spot between launches; if it
was on a display that is no longer connected, he stays in the island.

**Live diff.** Every file Claude edits (Edit, MultiEdit, Write) shows up in the
session ticker with its **+N −M** lines; click it for the diff. Same limits as the
Mac: past 200 KB or 4 000 lines only the counts are kept, at most 50 diffs per
session, and they are forgotten an hour after the last edit or when the session
ends. When Claude finishes, the card keeps the first paragraph of its final
answer on one line, still, until the next prompt.

### "OK Peika"

Off by default. Turn it on in **Settings… → Voice**, say **"OK Peika"** (or
"Hey Peika"), wait for the island to open on Peika listening, then say a
command. A card says what was done, and the island goes back to where it was.

| Say | What happens |
|---|---|
| "play", "pause", "next track", "previous track", "shuffle off", "repeat on" | Spotify, as from the music card. "play" opens Spotify when it is not running. |
| "add GitHub", "show Vercel and Stripe" | Declares the pills, as in Settings → Active pills. |
| "remove Notion", "hide Stripe and Notion" | Undeclares them. |
| "replace n8n with GitHub", "keep only GitHub and Vercel" | Both at once. |
| "switch to Cursor", "use Codex" | Changes the main pill (workspace tools only). |
| "open Discord", "launch Visual Studio Code", "open my downloads" | Starts that app, or opens that folder of yours. Any app Windows lists under All apps, Microsoft Store apps included, by its name — and by what the name was heard as: "this cord" is Discord. A name that is no app is asked about (below); nothing is opened on a guess. |
| "what about Steam?", "and Vercel too", "same for Stripe", "no, Discord", "put it back" | The last thing done, again with that name — or undone. See below. |
| "never mind" | Closes without doing anything. |

With six pills already there, "add Gemini" makes Peika ask **which one to
remove**: say its name and the two are swapped, say nothing and it is left as
it is. Spotify takes no slot, as everywhere else.

**Did you mean.** When "open …" names no installed app — the speech model
wrote "spy flight" for Spotify — Peika asks instead of giving up: **"Open
Spotify?"**, or **"Spotify or Steam?"** when two are as near. "Yes", "yeah" or
"do it" opens it; "no", "never mind" or saying nothing leaves it; another
name said instead is tried. The nearest apps are found on this computer, by
letters and by sound, without waiting for a model, and a guess is never opened
without the yes. Nothing near is said at once. Windows' own recogniser is
given no "yes" (it would hear one in too much): there, the app's name is the
answer.

The same goes for **any name**, not only an app's. A pill that was only nearly
named is asked about before anything is touched — "remove strife" → **"Remove
Stripe?"** — while a name said as it is written, or written with other letters
for the same sounds ("versal", "get hub", "Kodaks"), is acted on at once: a
common command is never questioned. The Parakeet speech models also say how
sure they were of each word; a name they were unsure of is asked about unless
it is spelt exactly. And when it is the verb that was misheard — "up in
Spotify" — a word or two nobody knows followed by an app's name is asked about
too ("Open Spotify?"), before any model. A question can be answered by voice
or, as the island shows it, by a click.

**A short memory.** For a minute and a half after a command, a sentence with
no verb builds on it: after "open Spotify", "what about Steam?" opens Steam;
after "add GitHub", "and Vercel too" adds Vercel; "put it back" or "undo"
takes the last change back (a pill, the main pill, pause and play — not an app
that was opened). After the wake phrase a bare name is enough ("Steam");
without it, only a sentence that says it follows ("and …", "what about …").
The last few turns are kept in memory only — never on disk, never in the log —
and are forgotten when voice is turned off. Nothing about a permission is ever
carried over from the sentence before. "That one" and "it" mean the pill the
last command was about ("take that one off"), and a correction swaps: "no,
Vercel" after "add GitHub" takes GitHub off and puts Vercel on.

- **Windows only, English only, for now.** It uses Windows' own speech
  recogniser, which needs the English speech pack (Settings → Time & language →
  Speech) and nothing downloaded. Linux has no system recogniser and waits for
  a bundled one; Settings says so there.
- **On this computer only.** What the microphone hears never leaves it, and
  there is no online recogniser to fall back on. A sentence is written down by
  Windows' recogniser, by the downloaded engine or — if you choose it as the
  speech model, below — by a model server running on this computer; Peika
  refuses to send sound to any other address. The words stay here too, unless
  you pick a model for what Peika does not know (below): they then go, as
  text, to that server, wherever you pointed it. Nothing is recorded, and the
  log says that something was recognised, never what.
- **The microphone.** While voice is on, Windows shows a microphone in the
  taskbar. Turn off **Listen for « OK Peika »** to keep the microphone closed
  until you press the **Talk to Peika** shortcut (`Ctrl+Alt+V`, off by
  default, in Settings → Shortcuts). The microphone is also closed while Peika
  is paused from the tray, while the screen is locked and on battery saver.
- **It can only hear what it was given**: the wake phrases and the commands
  above, with any pill's name and any installed app's name in them (the first
  200, as read when Peika starts). So it cannot be asked for a song, an
  artist or a playlist, and Spotify's volume is out of reach on Windows. The
  wake phrase and the command are two sentences, with a pause between them.
  "Peika" alone does not wake it, and a wake phrase is ignored while a
  permission or a question waits for you, or while the chat is open.
- Voice never approves a permission and never sends anything: there is no
  sentence for it.

**A local model for what Peika does not know.** In Settings → Voice, pick a
model server you connected in Local models (Ollama, LM Studio or your own) and
one of its models. A sentence the parser does not know is then put to that
model with the tools Peika offers — the music, the pills, an agent's session,
the waiting permission (show it, or decline it), a timer, opening an app, one
of your folders or a web address — or it answers a question
about what Peika shows. The model only proposes: every call is checked against
what was actually said before anything happens. A pill is touched only if the
sentence names it, a permission is declined only if the sentence says decline,
deny, refuse or reject, and asking to allow one just brings its card up. The
model is also given the last few turns, so a follow-up arrives with what it
follows, and — only when a name in the sentence may be a misheard app — the
two or three installed apps it sounds like, which it may ask about; what it
makes of a name is asked ("Open Discord?"), never opened. A word for opening
may come from the turn before, and only after something was opened. On a table
of 39 sentences said freely, `qwen2.5:7b-instruct` got 39 right in about 0.2 s
each, and 27 of 28 exchanges with a misheard name or a follow-up, none of them
dangerous (`node --import ./tests/setup.mjs scripts/voice-eval.mjs`); the
checks were tuned on that same table, so expect less on sentences it has not
seen. A model the server has to load first takes about five seconds: it is
asked for as soon as Peika is woken, and an answer that takes more than six
seconds is given up on, with a card that says so. What you say and what Peika shows go to
that server and nowhere else; a toast says so once if it is not this computer.

**Free speech.** Windows' recogniser only hears the sentences it was given.
**Hear free speech** in Settings → Voice downloads an engine that hears anything
(sherpa-onnx with the Moonshine tiny English model and the Silero voice
detector, 38 MB, from the project's GitHub releases, checked against a pinned
SHA-256) and uses it for the command:

- "OK Peika" is still heard by Windows' recogniser — the free engine writes
  "peika" a different way every time — and then the command is yours to word:
  "hold the music for a sec", "get rid of Stripe". It is written down once you
  stop speaking, in a few hundredths of a second.
- **Keep listening after a command**: for a few seconds (8 by default) after a
  command, another can be said without the wake phrase. The view closes as
  usual; Peika keeps his listening look and an orange glow stays under the
  island, moving with your voice, for as long as he still listens. Anything said nearby in that time is heard
  too, but the island opens only when it is a command: a keyboard is not taken
  for a voice, and a word to someone else shows nothing unless the model, when
  one is chosen, finds a command in it.
- **Speech model**: three to choose from in Settings → Voice, each downloaded
  when you ask for it and pinned like the rest. Words wrong on 69 synthesised
  commands in three voices, and on twelve sentences of one real voice with an
  accent — few, but the only real ones, and they decided the default:

  | Model | Download | Synthesised | Real voice | To write 3 s of speech |
  |---|---|---|---|---|
  | Moonshine tiny (MIT) | 30 MB | 13 % | 76 % | 0.03 s |
  | Parakeet 110m (NVIDIA, CC BY 4.0) | 103 MB | 8 % | 44 % | 0.1 s |
  | Parakeet 0.6b v2 (NVIDIA, CC BY 4.0), the one used until you choose | 460 MB | 4 % | 15 % | 0.3 s |

  All three write "Vercel" as "versal": names are matched afterwards, by how
  they sound. Tried and left out: Moonshine base, Canary 180m, Whisper base.en
  and small.en — no better than the Parakeet next to them, and slower.
- **Or the model server hears.** When the server chosen under **Understand
  free speech with** is on this computer (127.0.0.1, localhost, ::1) and a
  model is picked, that model is a fourth choice in **Speech model**, with
  nothing to download: the sentence's sound goes to it, as a WAV file made in
  memory, and it writes the words. It must be a model that takes audio.
  It is not the model that hears best. `gemma4:e4b` through Ollama 0.40.2
  got 5 % of words wrong on the same 69 synthesised commands, in 0.15 s a
  sentence on a GPU — but on twelve sentences in a real voice (one speaker)
  it got 34 % wrong, "switch to colgate" for "switch to Codex", where
  Parakeet 0.6b got 15 %. What it can do that a speech model cannot is be
  told what to expect: Peika gives it the pills' and the installed apps'
  names with each sentence, and on those twelve it then got 15 to 22 % wrong
  — about Parakeet 0.6b's, with nothing downloaded. Twelve sentences are few:
  try it on your own voice. What to know:
  - The names of your pills and installed apps (140 at most) go to that
    server with the sound. It is on this computer.
  - Only a server on this computer. For any other address the choice is not
    in the list, and if the address changes later nothing is sent: the
    downloaded model hears. The request follows no redirect and uses no proxy.
  - Peika waits 2.5 s for the answer. Past that, on an error or on an answer
    without words, the smallest downloaded model writes the sentence instead;
    with none downloaded, the command is missed. A model that does not take
    audio is an error every time (Ollama answers so at once, once the model
    is loaded).
  - Ollama lets go of a model after five minutes and takes about 9 s to load
    this one again, so Peika asks the server for one word (no sound) when
    voice starts and each time it is woken. The first command after a long
    quiet may still be the downloaded model's.
  - It is the same model that is asked what a sentence means. Choosing Gemma
    to hear means Gemma decides too, and on Peika's table it decides a little
    less well and more slowly than `qwen2.5:7b-instruct` (37 of 39 in 0.8 s
    against 38 in 0.2 s).
  - Without a downloaded model there is no voice detector either: a sentence
    is then cut out by loudness, and a keyboard can be taken for one (Gemma
    answered nothing to noise, silence and a tone when tried).
- A command is at most about seven seconds: the model that writes it down
  fails on ten seconds and more, so a longer sentence — or music that never
  pauses — is cut there.
- **One breath.** "OK Peika, next track" as one sentence works too: Windows'
  recogniser says when the wake phrase ended, and what the microphone gave
  after that moment is written down. Said with a pause — "OK Peika" … "next
  track" — it works as before.
- It runs on this computer. The sound stays in memory until it is written
  down — by the engine, or by the model server on this computer when that is
  the speech model — and is kept nowhere. **Remove** deletes the engine and
  its models.
- Windows only for now.

Without the engine, the model is only reached by what the parser does not
understand among the sentences Windows was given.

**Peika answers out loud.** Also in Settings → Voice, and off until asked for:
a voice (Supertonic 3, 129 MB, from the same GitHub releases, checked the same
way) that says what a command did — "GitHub added", "Six active, remove
which?", the answer to a question. A calm female voice, or a male one, both a
little slower than the model's own pace. It is made on this computer in about
half a second and played like Peika's other sounds: muted when Sound is off,
quieter under the usual volume. He does not listen while he speaks, and he
stops when the wake phrase is heard. English only, like listening: in another
language the card says it. The voice's code is MIT and its model OpenRAIL-M.

## Flow dictation

Hold a key anywhere, speak, let go: the words are pasted where your cursor is.
Windows only for now; it is off until you turn it on in **Settings… → Flow
dictation**, and it needs the speech engine from **Settings → Voice** (Flow
writes down what you say with the same engine, on this computer).

| You do | Peika does |
|---|---|
| Hold **Right Ctrl** (or **Right Alt**, **Right Shift**: your choice) | Opens the microphone at once, so the first word is not lost, and shows a small pill with Peika and the level of your voice at the bottom of the screen you are on |
| Let go | Writes down the rest, applies your replacements and dictionary, and pastes into the window that was in front when you pressed the key |
| Tap the key twice, quickly | Hands-free: it keeps listening until you tap again, or click ✓ on the pill (✕ cancels) |
| `Esc`, or any other key while holding (a shortcut such as `Ctrl+C`) | Cancels: nothing is pasted |

The pill takes no focus (the words go to the window you were typing in), is not
in the taskbar, and is out of sight between dictations. Right Alt is AltGr on
many keyboard layouts, where it types characters: pick another key if you use it.

**Replacements** (Settings → Flow dictation → Replacements): say "cloud code",
get "Claude Code". Case and hyphens do not matter and only whole words match.
**Dictionary**: names and terms spelled your way ("Supabase"): when Peika hears
one it uses your capitals and hyphens. A word with symbols (such as "C++") is
not matched.

**Paste.** The words go on the clipboard as text (kept out of the clipboard
history and the cloud clipboard), Peika sends Ctrl+V to the window, and about
300 ms later the clipboard's previous text is put back, unless you copied
something meanwhile. Only the text is saved and restored: an image or files
you had copied are replaced by the words. Windows does not let a program that
is not elevated type into one that is (UIPI): Peika checks first, leaves the
words on the clipboard and says so in the pill, so you can paste them yourself.
The same if the window you were in cannot be brought back.

**Privacy.**
- Nothing is recorded. The sound stays in memory only until it is written down;
  the log says that a dictation happened, never what was said.
- To know when you press the key, Flow installs a Windows keyboard hook, which
  by its nature is told about every key press on the computer. Peika's hook
  keeps none of them: it reports the state of the chosen key, and, only while
  a dictation is under way, that Esc or another key was pressed (not which). It
  never swallows or changes a key, and it is installed only while Flow is on:
  switching Flow off removes it and the pill's window.
- The microphone is open only while you hold the key (or are hands-free), and
  "OK Peika" stands aside meanwhile.
- Not yet: styles per app, snippets, history and statistics, and clean-up or
  translation by a model. Flow pastes what was heard, with your replacements.

## Your pills

**Settings… → Active pills** lists the tools you use, from the same catalog as
the Mac app. Pick your **main tool** — VS Code, Cursor, Codex or Antigravity —
which is always there and doesn't take a slot, then declare up to four more:
agents (Gemini CLI, Copilot CLI, Muse Code, OpenCode, Amp, Hermes, Claude
Desktop), the chat providers (Anthropic, Google AI, OpenAI, Ollama, LM Studio),
and the services under **Integrations**. A pill fed by hooks says whether its
hooks are installed, never asks for a key; a local model server's pill says
whether the chat is connected to it. A session on a pill you didn't
declare still shows up, for as long as it runs.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Peika's entries.

The relay is a tiny executable, `peika-hook.exe`, copied to
`%LOCALAPPDATA%\Peika\bin\` at launch. It is given 300 ms to reach Peika and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Peika.** If nobody answers a permission request
in time, Peika stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

### Plan usage

As on the Mac, the island's header can show your plan limits: a small pill
("Claude 73%", green below 50 %, orange up to 80 %, red above) for the 5-hour and
weekly Claude limits, and another for Codex. Click one for the details and the
reset times. Both are off by default; turn them on in **Settings… → Plan usage**.

- **Claude** (Pro and Max plans): the numbers come from Claude Code's own status
  line. **Show in notch** first shows you the diff of the `statusLine` change in
  `%USERPROFILE%\.claude\settings.json`, takes a dated backup and writes only
  after your click, with the same writer as the hooks: the status line becomes `peika-hook --statusline`, which
  passes only the limits on (300 ms at most) and runs the status line you had
  before — kept in `statusline-previous.json` next to the relay — with the same
  input, printing what it prints. On Windows that one runs through Git Bash, as
  Claude Code runs it (`CLAUDE_CODE_GIT_BASH_PATH`, then the Git for Windows that
  `git.exe` on `PATH` belongs to, then the usual install folders); it gets 10 s
  and 64 KB of output. **Uninstall relay** puts your status line back. The
  numbers arrive with Claude Code's replies. They come from the Claude Code
  command-line tool only: the Claude desktop app does not run the status line, so
  if you only use the desktop app the Claude gauge stays on "—".
- **Codex**: nothing is installed. When the pill shows (or is clicked, at most
  once a minute) Peika starts `codex app-server` and asks it
  `account/rateLimits/read`, as Codex's `/status` does, then stops it (15 s at
  most, never while paused). Codex must be signed in with ChatGPT.

## Weekly recap

On Monday from 8 am, the first time Peika starts, an agent starts working or
you wake the island, a card sums up the past week: time spent, sessions, files
and lines changed, commands run, permissions and questions, your top agent,
top project, busiest day and longest session. **Tray → Weekly recap** opens it
any day.

**Share image** turns it into a 1080 × 1920 picture with Peika. **Save image**
writes it to your Pictures folder (Downloads if there is none) as
`Peika weekly recap YYYY-MM-DD.png`, never over an existing file; **Copy** puts
it on the clipboard. **Hide project names** leaves the project out of the image.

The history is `recap.json` next to the log, a 12-week rolling window: counts,
the agent and the project folder's name — never a command, a file path, file
contents or a prompt. It never leaves your machine. **Settings → General →
Weekly recap** turns it off or clears it.

## Languages

Peika speaks the same ten languages as the Mac app: English, 简体中文, हिन्दी,
Español, العربية, Français, বাংলা, Português (Brasil), Русский and Bahasa
Indonesia. **Settings… → General → Language** picks one; **System** (the
default) follows your system's language when it is one of these, English
otherwise. The island, the settings window and the tray menu switch at once —
nothing restarts, and the island keeps its sessions, steps and chat.

In Arabic the island's cards read right to left; Peika, the pills and the
header stay where they are, and commands, code and file paths stay left to
right. Steps already in a session's ticker keep the language they were written
in, as on the Mac.

The translations are the Mac's own (`NotchBuddy/Resources/Localizable.xcstrings`,
turned into `src/i18n/strings.json` by `node scripts/gen-strings.mjs`), plus
`src/i18n/extra.json` for what only Windows and Linux show. Both are keyed by
the English text; a string missing in a language shows in English. The Rust
side (tray, errors) embeds the same two files.

## Chat and keys

**Settings… → Claude** takes your Anthropic API key. Keys live in the **Windows
Credential Manager**, never on disk and never in the interface — the island can
only ask whether a key exists. Same for every integration key.

The chat also talks to **Google AI (Gemini)**, **OpenAI** and **OpenRouter**:
add their keys in **Settings… → Chat providers**, then click the model name
above the chat box to switch provider and model, as on the Mac. The model list
is fetched from the provider only once you pick it and it has a key. Switching
mid-conversation carries the conversation over as plain text, so nothing in one
provider's format is ever sent to another. These providers get no web search
and no tools — they answer, they never act on your PC.

No API key? Pick **Claude Code** in the same picker. Peika then asks the
Claude Code CLI installed on your PC (`claude -p`), which answers with its own
sign-in — a Claude Pro or Max plan, usually — so each question counts against
that plan's limits rather than an API bill. Peika reads no credential.

Under its models, the picker has Claude Code's own options:

- **Folder** — none by default: Claude Code is then a plain chat model. Web
  search is its only tool, no settings file is read (your hooks do not fire)
  and nothing is saved to disk. With a folder, it is Claude Code as it runs in
  a terminal there — its tools, your settings and the project's — and the
  conversation is a Claude Code session, resumed turn after turn.
- **Effort** — Claude Code's `--effort`, or its own default.
- **Permissions** — Ask, Accept edits, Plan or Auto (`--permission-mode`).
  Peika never answers a permission request itself: with the Claude Code hooks
  installed the request shows in the island and waits for your click, like any
  other session's; without them it is denied. Bypassing permissions is not
  offered.

While Claude Code answers, the send button stops it.

Claude Code's conversations are saved: the title on the left of the model name
opens their list, grouped by the folder they work in, newest first. Opening one
puts it back in the chat and, in a folder, resumes its Claude Code session;
`+` on a folder starts a new one there. Peika keeps their text in
`conversations.json` in its local data folder (a dropped file by name only),
the last 100 of them, and deleting one there leaves Claude Code's own session
untouched. Other providers' conversations are not saved yet;
`src-tauri/src/conversations.rs` says how to add one.

The list also shows the sessions Claude Code holds itself — from a terminal or
the Claude app — read from `~/.claude/projects`: opening one shows what was
said and the next question resumes that session. Peika only reads there; it
never writes, moves or deletes anything of Claude Code's. The other way round
needs nothing: a conversation held in a folder from Peika is a Claude Code
session from its first turn, so `claude --resume` in that folder finds it. A
chat without a folder is not a Claude Code session and stays in Peika.

In a folder, each file Claude Code edits shows as a pill under its answer —
the file's name and the lines added and removed — and a click opens the diff
there. The pills last as long as the chat is on screen; they are not saved
with the conversation. Next to the conversations, a second button lists the
folder's pull requests: the open ones on GitHub (a click opens one in the
browser) and the local branches that have commits but no pull request yet.
Peika asks `git` and the GitHub CLI (`gh`, with its own sign-in) for them,
only when the list is opened; without `gh` the local half still shows.

**Local models**: **Settings… → Local models** connects **Ollama** or **LM
Studio** (leave the address empty for the usual one on this PC; Ollama's
`OLLAMA_HOST` is honoured) or any server that speaks the OpenAI API (vLLM,
llama.cpp…), with an optional key kept in the credential store. Answers stream
in as they are written, and the `<think>` blocks of reasoning models stay
hidden. A text file you dropped goes along inline (24 000 characters at most);
images and PDFs by name only. Settings tells you whether the address is this
PC — nothing leaves it then — and warns before a key would travel over plain
`http://` to another machine.

Answers from every provider are shown as **Markdown**: headings, lists, bold,
inline code, quotes, and code blocks with a copy button. It is built from text
nodes, never parsed as HTML, and only `http`/`https` links open. Peika greets
you by your first name when your account has one (the Windows display name or
the Linux GECOS full name; a bare login name is not used).

To send the Claude chat through an Anthropic-compatible gateway, set
`PEIKA_ANTHROPIC_BASE_URL` (for example `https://gateway.example.com`;
`/v1/messages` is added). It must be `https://`, or `http://` to this PC only.
Claude Code's own `ANTHROPIC_BASE_URL` is deliberately ignored: your key only
goes where you told Peika to send it. The gateway's host is written to the log
once; the key never is.

No telemetry. The only network requests Peika makes are to the services you
configure yourself.

## GitHub

With a token in **Settings… → Integrations → GitHub** — a classic token with
the `repo` scope, or a fine-grained one with read access to Pull requests,
Commit statuses and Actions — the GitHub pill shows:

- **My PRs**: your open pull requests and their CI status.
- **To review**: the pull requests waiting for your review.
- **Default branch CI**: the CI of the default branch of your 10 most recently
  pushed repositories.
- Your stars and the **last 7 days of contributions** in the card header; click
  them for the past 23 weeks, and hover or click a day for its count.

Click a row for the list, then an item to open it on github.com. The pill gets
a badge and a sound when the CI of one of your pull requests turns red or green
(fast runs between two checks included), when a default branch breaks, or when
someone requests your review. Pull requests are checked every 5 minutes, every
minute while a CI is running, and as soon as you open the card on data older
than a minute; contributions every 30 minutes. Nothing is fetched while the pill
is off or Peika is paused.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see — and `dev/recap-preview.html`,
the weekly recap card and its shared image on a sample week. None of these pages
ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Peika-Windows-X.Y.Z-setup.exe    the versioned installer
Peika-Windows-setup.exe          the same file under the rolling name
```

Toasts — the notes and Yes/No questions in the top-right corner — have no
caller yet. To see them, send sample ones to the running app:

```powershell
peika.exe --toast-sample all        # or info, success, warning, error, decision
```

The decision samples answer to Shift+Y and Shift+N while they are on screen. In
code, `toast::warn(&app, title, text)` (Rust) or `showToast` / `askToast`
(`src/toast/api.ts`) show one.

Installing is optional — `target/release/peika.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Peika in the notification area are the whole app, and Quit lives in its menu.

The 29 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of
`vite.config.ts` — when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Peika itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    peika/             Peika and the launch greeting, in Canvas 2D
    desktop/           Peika's own little window, when he lives on the desktop
    toast/             the toasts' window: the stack, its timings and its look
    island/            state machine, hooks, integrations, what voice reports
    voice/             what a command means and what it does (parser, pill names, runner,
                       and the tools a local model may propose)
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
    src/voice/         "OK Peika": the session, Windows' recogniser, and the free-speech
                       engine (its download, the microphone, the voice detector)
  hook/                peika-hook.exe, the Claude Code relay
  scripts/             icon generator
```

### Log

`%LOCALAPPDATA%\Peika\peika.log` — hook events, permission decisions, poller
problems. It stays on your machine. The weekly recap's history sits beside it in
`recap.json`.

## Supported agents

Every agent below is installed from **Settings → Agents** with the same steps as
Claude Code: the exact diff, the path of the dated backup, nothing written until
you click, and uninstalling removes only Peika's entries. A config Peika cannot
read, or where it finds something it does not expect, is left alone and the
reason is shown. Each agent gets its own pill (`agent_<name>`, the Mac's ids and
colours). The files are the Mac's, under `%USERPROFILE%` on Windows and `~` on
Linux.

| Agent | Installs | Permissions |
|---|---|---|
| Claude Code | `.claude\settings.json` (**Settings → Claude Code**) | Allow / Deny and questions in the island |
| Codex | `.codex\hooks.json` — then trust the hooks once with `/hooks` in Codex | Allow / Deny in the island |
| GitHub Copilot CLI | `.copilot\hooks\peika.json` | Allow / Deny in the island |
| Muse Code | `.config\muse\settings.json` | Allow / Deny in the island |
| Gemini CLI | `.gemini\settings.json` | asked in Gemini CLI |
| Antigravity | `.gemini\config\hooks.json` (a `peika` hook group) | asked in Antigravity |
| Cursor Agent | `.cursor\hooks.json` — Claude Code in Cursor's terminal also goes on the Cursor pill, through the Claude Code hooks | asked in Cursor |
| Claude Desktop (Windows) | nothing to install: Claude Code sessions from the Claude app are tagged by the relay | asked in the Claude app |
| OpenCode | plugin `.config\opencode\plugins\peika.js` | asked in OpenCode |
| Amp | plugin `.config\amp\plugins\peika.ts` | asked in Amp |
| Hermes Agent | plugin `.hermes\plugins\peika\` — then `hermes plugins enable peika` once | asked in Hermes |
| Any other | run `peika-hook --agent <name> [<Event>]` from your tool's hooks | asked in the tool |

The relay maps every agent's event and field names onto Claude Code's (Gemini
CLI's `BeforeTool`, Copilot's `preToolUse`, Cursor's `beforeSubmitPrompt`…), and
answers each agent the way it expects. It never lets anything through on its
own: with no click it prints no decision at all (`{}` for the agents that need
JSON, `"ask"` for Copilot, which is fail-closed), so the agent asks in its own
terminal exactly as without Peika — including when Peika is closed.

The plugins start the relay directly, with no shell in between, and never wait
for it. Amp's steps appear as each tool finishes: its "before" hook must return
a verdict, and Peika never gives one.

**How each agent runs the relay on Windows.** Hook commands are written for the
shell that runs them: Git Bash for Claude Code (quoted, forward slashes),
PowerShell for Gemini CLI and Copilot CLI (`& '…\peika-hook.exe'`), `cmd /C`
for Codex. Cursor, Antigravity and Muse Code do not document theirs: the relay
path is written bare when it has no space or special character — which works in
cmd, PowerShell and when started directly — and in double quotes otherwise.
These three are untested on Windows.

A pill is **connected** when Peika finds its own entries in the files above —
the same check as Settings → Agents (for Claude Code: a SessionStart hook
running Peika's relay; the Cursor pill also counts Claude Code's hooks).
Peika only reads these files, each time the island opens. Permission requests
get the island's card for Claude Code (in any terminal, and in Cursor's),
Codex, Copilot CLI and Muse Code; other agents and Claude Desktop ask in their
own window.

## What's different from the Mac version

- "OK Peika" is in English and on Windows only (see ["OK Peika"](#ok-peika)),
  and does the first three of the Mac's ten voice functions: music, the active
  pills, the main pill. Music is Spotify alone, without songs by name or
  volume; the limit Peika asks about is six pills, not four.
- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- "Open terminal" finds the session's window by walking up from the relay's
  process to the terminal or editor that runs it. A session in a classic
  console window (`cmd.exe` or PowerShell without Windows Terminal) has no such
  ancestor — conhost owns that window — so its folder opens in VS Code instead,
  as it does when `code` is on your `PATH` and nothing was found. Linux walks
  the same tree; what it can bring forward depends on the desktop (see Linux).
- Global keyboard shortcuts are hot keys on Windows, key grabs on Linux under
  X11, and go through the desktop's GlobalShortcuts portal under Wayland (see
  [Linux](#linux)). A waiting card is also folded with its **⌃** or `Esc` in
  the island, and reopened by clicking the island, Open in the tray or **Go to
  alert**.
- Apple Music, the one pill from the Mac catalog with nothing behind it here,
  is left out.
- **Spotify** (Settings → Integrations) is read from Windows' own media
  controls on Windows — the ones behind the volume flyout and the media keys
  — and over MPRIS on Linux (see [Linux](#linux)); the Mac uses AppleScript.
  On Windows nothing is polled: one thread sleeps until Windows says Spotify's
  track, status or timeline changed, and ends when the pill is turned off.
  The cover is the one Windows holds, never fetched from the network. The
  card has no volume slider on Windows: Windows is not told Spotify's volume,
  and Spotify's level in the Windows volume mixer is a different thing. Ads
  are told from tracks by a
  guess (a short title with no artist and no album). Both the installer's
  Spotify and the Microsoft Store's are found.
- Attaching a window: only on Windows, and dropping Peika on a window attaches
  it only with `Ctrl` held. On the Mac any drop on a window does, but here
  windows usually cover the screen, and a plain drag has to stay a move. A
  browser's address is read from its address bar (UI Automation) when it
  answers within a second and a half, and kept only when it is an http(s)
  address; otherwise the title goes alone.
- Not in this version: sending a dropped file by email. On the Mac, email goes through Resend or
  Apple Mail's scripting; neither has a safe equivalent that attaches a file
  here, and the drop card would need a third button it doesn't have.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.
- The Cursor pill carries both Cursor Agent's own hooks and Claude Code running
  in Cursor's terminal.
- Hermes: Peika writes the plugin but does not run the `hermes` CLI, so it is
  turned on once by hand. Hermes runs natively on Linux; on Windows it is
  untested.
- Plan usage: the user's previous status line runs through Git Bash on Windows
  (`/bin/sh` on Linux and Mac); without Git Bash it is not run, rather than
  guessed at with `cmd`. The Codex CLI is looked for on `PATH` and in npm's,
  Volta's, Bun's and pnpm's folders (and nvm's on Linux).
- The chat's model picker opens inside the chat card instead of a popover, and
  it also offers OpenRouter and any OpenAI-compatible server, which the Mac
  does not. Google AI, OpenAI and OpenRouter can see an image you dropped (sent
  inline), where the Mac sends its name only.
- Live diff: the relay forwards an edit's text whole only once the edit is done
  (PostToolUse), up to 256 KB per string and 512 KB per event. A bigger edit
  shows its "Edits · file" step without counts rather than wrong ones. The
  diff's ↗ needs `code` on your `PATH`; without it, it opens the file's folder —
  never the file itself. Counts and diffs come from Claude Code's Edit,
  MultiEdit and Write, on whichever pill its session is on (VS Code, Cursor,
  Claude Desktop); other agents' edits show as plain steps.
- There is no iPhone to keep fetching the GitHub lists while the pill is off.
- Keyboard shortcuts use `Ctrl+Alt` where the Mac uses `⌃⌥`, with different
  keys (see [Keyboard shortcuts](#keyboard-shortcuts)), and `Ctrl` where the
  Mac uses `⌘` inside the island. "Bring the terminal forward" is "Open
  terminal" here. Attaching the front window is `Ctrl+Alt+F` (the Mac's
  `⌃⌥W`; AltGr+W types a character on several layouts), on Windows only. The island only reads its own shortcuts while it has the
  keyboard: in the chat, or after a global shortcut opened it. `Ctrl+↓`
  `Ctrl+↑` `Ctrl+O` walk the GitHub lists, as on the Mac, and the highlighted
  row scrolls into view where the Mac's three-row list doesn't follow it; in the
  chat field `Ctrl+↑` `Ctrl+↓` keep moving the cursor. **Go to alert** brings
  up any agent's waiting card on its own pill; **Toggle the island** folds a
  waiting card rather than dropping it, like `Esc` in the island. **Send Peika
  to the desktop** (`Ctrl+Alt+D`, the Mac's `⌃⌥D`)
  flies him to his spot, or to the bottom-right corner when that spot was on a
  display that is gone; pressed again, he flies home.
- Weekly recap:
  - Sharing happens inside the island instead of a separate panel, and Save
    writes straight into Pictures (or Downloads) instead of asking where. There
    is no system Share sheet; Copy uses the web clipboard.
  - Questions are counted when an agent asks one (`AskUserQuestion`), whether
    it is then answered in the island or in the terminal. Permissions count the
    Allow and Deny clicks on the island's card, for every agent that gets one.
  - There is no sleep/wake notification to listen to without a background
    loop, so after the machine wakes the Monday card waits for the first agent
    to start or for you to hover the island.
  - The card is 24 px taller than the Mac's: it also lists top agent, project,
    busiest day, longest session, permissions and questions, which the Mac
    leaves to the image. A turn cut short by the session ending still counts.
  - Tray → Pause doesn't stop the history (it stays on the machine anyway);
    switch it off in Settings → General.
- The wardrobe opens with a right-click on Peika, from the tray menu, or with
  its global shortcut (`Ctrl+Alt+G` by default). In the compact island a tall hat
  is cut by the top edge of the screen, as it is by the notch on a Mac.
- Languages: chosen in Settings, independently of the system, and applied
  without a restart (the Mac's **Restart Peika** isn't needed). Arabic turns
  the island's text right to left but not its layout: Peika and the pills keep
  their sides.
- Peika on the desktop dances to Spotify. While he dances he stays awake (the
  Mac lets him doze off mid-dance). Dropping him on a window doesn't attach it
  to the chat. While he
  sleeps, the transparent square around him (120 px) takes the first mouse
  move, which wakes him and gives the rest back to the desktop.

## Linux

The same app builds for Linux: everything that differs lives in
`src-tauri/src/platform/`, and the relay's transport in `hook/src/unix.rs`.

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # AppImage, .deb and .rpm in windows/release/
```

On Arch Linux, build and install the package from `linux/arch/`:

```bash
git clone https://github.com/kura120/peika.git
cd peika/linux/arch
makepkg -si
```

It needs `webkit2gtk-4.1`, `gtk-layer-shell` and `libayatana-appindicator`
(pulled in as dependencies); store API keys with GNOME Keyring or KWallet.

What changes on Linux:

- **The island** is a gtk-layer-shell overlay anchored to the top edge, over any
  top panel, on compositors that support it: COSMIC, KDE Plasma, Hyprland, Sway
  and other wlroots compositors. GNOME has no layer-shell and ignores where a
  Wayland window asks to go, so there Peika runs through XWayland as a dock
  window: top centre, on every workspace, still there after Super+D.
  `PEIKA_X11=0` keeps the native Wayland window, `PEIKA_DOCK=0` makes it a
  utility window instead of a dock. `PEIKA_LAYER_SHELL=0` forces the regular
  window anywhere.
- **Click-through** is the window's input region, kept equal to the island
  shape, so the compositor sends every other click to what is underneath.
- **Peika's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else. On the desktop, likewise,
  they follow it only while it is over him, and "the cursor is far away" (so
  he may fall asleep) means it hasn't been over him for a few seconds.
- **Peika on the desktop** is a layer-shell surface on the island's display
  (KDE Plasma, COSMIC, Hyprland, Sway…), placed with margins and dragged within
  that display; on X11 it is an ordinary always-on-top window that goes
  anywhere. **GNOME on Wayland** has no layer-shell and lets no app place its
  own window, so there Peika can't leave the island: dragging him does nothing,
  and the desktop shortcut only makes him grumble.
- **Claude Code hooks** go through `~/.local/share/peika/bin/peika-hook` and a
  Unix socket at `$XDG_RUNTIME_DIR/peika.sock`. Both ends check that the other
  runs as the same user. Every other agent uses the same relay, single-quoted
  for `sh`, and its config under `~` (see Supported agents). A config that is a
  symlink (dotfiles) is written through to its target, with its permissions
  kept.
- **Global shortcuts** are X11 key grabs in an X11 session.
  On X11, AltGr is a modifier of its own and never clashes with `Ctrl+Alt`;
  combinations the desktop already uses (GNOME's `Ctrl+Alt+T` terminal and
  `Ctrl+Alt+←`/`→` workspace switching) show up as *In use*.
  Wayland has no key grabs, so there Peika hands its shortcuts to the desktop
  through the XDG **GlobalShortcuts portal** (`xdg-desktop-portal`, with a
  backend that has it: KDE Plasma 6, GNOME 48+, Hyprland, COSMIC…). Each
  shortcut goes with its description and your keys as the preferred trigger;
  the desktop may show its own window to confirm them or to pick other keys,
  and it has the last word: a shortcut it already knows keeps the keys it was
  given there, and you change them in the desktop's own shortcut settings.
  **Settings → Shortcuts** says the shortcuts are registered with the desktop,
  shows next to each one the keys the desktop reports (*Desktop: …*), and flags
  one it left out. Changing or turning off a shortcut in Peika binds the new
  set in a new portal session. Peika names itself `dev.kura120.peika` to
  the portal where the portal allows it (`xdg-desktop-portal` 1.19+); a
  desktop that wants an app name may otherwise refuse.
  Where there is no such portal, or the desktop refuses, nothing is registered
  and **Settings → Shortcuts** lists commands to bind in your
  desktop's own keyboard settings instead (they are shown with the portal too,
  for any shortcut that doesn't work):
  `peika --shortcut openChat` (or the AppImage's path) runs the action in the
  Peika that is already open. The ids are `toggleIsland`, `openChat`,
  `goToAlert`, `jumpToTerminal`, `nextPill`, `prevPill`, `muteToggle`,
  `desktopToggle` and `wardrobeToggle`.
- **Keys** live in the Secret Service (GNOME Keyring, KWallet).
- **Spotify** (Settings → Integrations) is read over MPRIS, Spotify's D-Bus
  interface on the session bus: the pill shows the track and plays, pauses
  or skips on hover, the card has the cover, the progress bar (drag to
  seek), shuffle, previous, next, repeat and the volume, and Peika dances
  while it plays — in the compact island, on the Spotify card, on the pill
  and on the desktop. Nothing is polled: one thread waits on the bus for
  Spotify's own signals while the pill is declared, and stops when it isn't.
  **Open Spotify** brings it forward or starts `spotify` from your `PATH`,
  else the Flatpak (`com.spotify.Client`) or the Snap; without one, **Get
  Spotify** opens its download page. Covers come from Spotify's image CDN
  (or a local track's file) and are fetched by Peika itself, not the page.
  Spotify builds that don't report the position over MPRIS show the bar
  from where the track started; the Mac's Automation prompt has no
  equivalent here.
- **Plan usage**: the status line relay is `~/.local/share/peika/bin/peika-hook
  --statusline` and runs your previous status line with `/bin/sh -c`, like Claude
  Code. Codex is found on `$PATH`, in `~/.local/bin`, npm's global prefix, Volta,
  Bun, pnpm, or nvm (newest Node first), since a desktop launch often has a
  shorter `$PATH` than your shell.
- **Peika's greeting** uses the full name in your account's GECOS field
  (`chfn` sets it); without one the chat stays neutral.
- **Files**: preferences in `~/.config/peika/`, the log at
  `~/.local/share/peika/peika.log`, the weekly recap history beside it in
  `recap.json`. A saved recap image goes to the pictures folder named in
  `~/.config/user-dirs.dirs`, else `~/Pictures`, else `~/Downloads`.
- **Languages**: Hindi, Bengali, Chinese and Arabic need fonts that carry those
  scripts; Peika asks for the Noto families (`fonts-noto-core` and
  `fonts-noto-cjk` on Debian and Ubuntu, `noto-fonts` and `noto-fonts-cjk` on
  Arch). **System** reads the language from the webview, which follows
  `LANGUAGE` / `LANG`.
- **Copying the recap image** needs a WebKitGTK with image clipboard support;
  where it is missing, the island says so and Save still works.
- What the Windows build leaves out, this one does too: sending a file by
  email and dragging Peika onto a window.
- **Open terminal** walks up from the relay through `/proc` (stopping at
  systemd, logins, ssh, session managers and panels, and at any process of
  another user) to the terminal or editor the session runs in, then brings its
  window forward — the one titled after the session's folder if it has several:
  - **X11** (any desktop): EWMH — the window whose `_NET_WM_PID` is the nearest
    ancestor gets a `_NET_ACTIVE_WINDOW` request, on its workspace. A terminal
    that doesn't set `_NET_WM_PID` (some old `xterm` builds) isn't found.
  - **KDE Plasma on Wayland**: a few lines of KWin script, loaded over D-Bus
    from `$XDG_RUNTIME_DIR`, activate the window by process ID and are unloaded
    right after; Plasma 5 and 6.
  - **kitty**, anywhere: its tab is selected too when remote control listens on
    a socket (`allow_remote_control` and `listen_on` in kitty.conf).
  - **GNOME on Wayland** and other Wayland compositors let no app bring another
    app's native window forward (an XWayland one, such as VS Code's by default,
    still can be). There, and for a session under tmux, screen or ssh, whose
    terminal is no ancestor, the folder opens in VS Code as before.
- No **Claude Desktop** pill: the Claude app has no Linux build.
