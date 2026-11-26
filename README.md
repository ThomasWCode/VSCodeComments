# Margin Notes

Word-style comment boxes for code in VS Code. Comments are attached to line ranges and shown two ways:

- **Inline threads**: VS Code's native comment widgets, with reply, edit, delete and resolve/reopen.
- **A margin panel** beside the editor, whose boxes line up with the commented lines, like comments in the margin of a Word document.

Comments are stored in sidecar JSON files next to your code, stay attached to their code as it is edited, and are kept out of git unless you choose otherwise. It is single-user: there are no author names.

## Install

Margin Notes is not on the Marketplace. Download the `.vsix` from the latest [release](https://github.com/ThomasWCode/VSCodeComments/releases/latest), then install it:

```bash
code --install-extension margin-notes-0.1.1.vsix
```

You can also install it from inside VS Code: in the Extensions view, open the **…** menu and choose **Install from VSIX…**.

To build it from source instead (Node.js 20 or later):

```bash
npm install
npx vsce package
code --install-extension margin-notes-0.1.1.vsix
```

## Using it

- **Add a comment:** click the **+** in the gutter beside a line (drag over several lines for a range). Or select code and press **Ctrl+Alt+M** (**Cmd+Alt+M** on a Mac, as in Word), or right-click and choose **Add Comment**. Pick a category; Escape keeps the default, **Note**.
- **Reply, edit, delete, resolve:** use the buttons on the inline thread, or on its box in the margin.
- **Margin panel:** **Margin Notes: Toggle Margin** (or the button in the editor title bar). Click a box to jump to its code: the code is selected, scrolled into view and briefly highlighted. Moving the cursor into commented code outlines its box. Boxes for comments above or below the visible lines collapse into "↑ 3 more" / "↓ 2 more" markers; click one to scroll there.
- **Sidebar:** the Margin Notes view in the activity bar lists every thread by file. Filter it by category, open/resolved and attached/orphaned. Its badge counts open threads.
- **Export:** **Margin Notes: Export Comments** writes Markdown or a standalone HTML page, for the current file or the whole workspace, with each thread's code snippet.

### Commands

| Command | What it does |
|---|---|
| Margin Notes: Add Comment (Ctrl+Alt+M) | Comment on the selection (or the cursor's line) |
| Margin Notes: Toggle Margin | Open or close the margin panel |
| Margin Notes: Show All Comments | Open the sidebar overview |
| Margin Notes: Export Comments | Export to Markdown or HTML |
| Margin Notes: Reattach Orphaned Comment | Attach an orphaned thread to the current selection |
| Margin Notes: Change Category | Change the category of the thread at the cursor |
| Margin Notes: Toggle Show Resolved | Show or hide resolved threads in the editor and margin |
| Margin Notes: Delete All Resolved | Delete every resolved thread (asks first) |

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `marginNotes.storageFolder` | `.codecomments` | Where sidecar files go, relative to each workspace folder |
| `marginNotes.commitComments` | `false` | Leave the storage folder visible to git |
| `marginNotes.categories` | Note, Question, To do, Bug, Idea | Category ids, labels and colours (`#rrggbb`) |
| `marginNotes.showResolved` | `true` | Show resolved threads in the editor and margin |
| `marginNotes.contextLines` | `2` | Lines above and below stored for re-anchoring |
| `marginNotes.autoOpenMargin` | `false` | Open the margin when a file with comments opens |
| `marginNotes.expandInlineOnReveal` | `true` | Expand the inline thread when jumping from the margin or sidebar |
| `marginNotes.showMarginButton` | `true` | Show the Toggle Margin button in the editor title bar |

## Storage

Each commented file gets one sidecar file that mirrors its path: `src/foo.py` → `.codecomments/src/foo.py.json`. A sidecar is deleted with its file's last comment. Writes are debounced and atomic (a temporary file, then a rename), and sidecars changed on disk by something else, such as a restore or a sync tool, are reloaded.

### Git

By default (`marginNotes.commitComments: false`) the first comment in a git repository adds the storage folder to `.git/info/exclude`. That file is local and never committed, so your tracked `.gitignore` is not touched. Turning the setting on removes the line again.

If git already tracks the storage folder, excluding it has no effect. Margin Notes warns you and offers to run `git rm -r --cached` on it. Your files stay on disk, and it only runs if you agree.

**Comments are local by default.** With the default setting, comments exist only in this working copy: they are lost if it is deleted, and they don't sync between computers. Turn on `commitComments` to keep them in the repository.

## How comments stay attached

- **Edits in VS Code** move every comment exactly. Edits inside a commented range grow or shrink it, and its stored text is updated when you save.
- **Changes outside VS Code** (a git checkout, pull or rebase, another editor) are matched by text when the file opens or reloads. A thread is first looked for at its old line. Next comes the same text elsewhere, preferring copies whose surrounding lines also match, then the nearest. Last is a fuzzy match on the text and its surroundings near the old line.
- **Orphaned comments:** when the code is deleted, or can't be found, the thread is kept and marked **orphaned**. Orphans appear in the sidebar and at the bottom of the margin with their last known code. Reattach one to a selection, or delete it. Undoing the deletion reattaches it automatically.

## Known limitations

- **Margin alignment is approximate.** VS Code does not tell extensions the pixel positions of lines, so box positions are computed from the line height and the visible lines. Folded regions are accounted for. Word wrap, CodeLens, inlay hints, open inline comment widgets and sticky scroll still shift the code without the margin knowing. Each box shows its line number, and clicking a box always jumps to the right code.
- The margin panel shows comment text as plain text; the inline threads render Markdown.
- Remote workspaces (SSH, WSL, containers) and files outside the workspace are not supported.

## Development

```bash
npm install
npm run compile        # type-check and bundle to dist/
npm run watch          # rebuild on change
npm run test:unit      # anchoring and storage tests in plain Node (fast)
npm test               # everything, inside a downloaded VS Code
```

`npm test` is `npm run compile-tests` followed by `npx vscode-test`. The first run downloads VS Code into `.vscode-test/`. On Linux without a display, run it under `xvfb-run -a`.

Press F5 in VS Code to launch an Extension Development Host with the extension loaded.

## Licence

MIT
