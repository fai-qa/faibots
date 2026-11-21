# faibots desktop preview

faibots is a local Windows workspace for running your own team of AI bots. Give each bot a role and model, talk to it directly or bring several bots into a group chat. Bots can ask each other for help. You control which tools and connectors they can use, and which actions need your approval.

## Run from source

Use Windows x64, Git and Node.js 24.20.0. From the source directory:

```powershell
npm ci
npm run dev
```

Model availability and sign-in depend on your provider.

If Electron exits immediately on Windows, run `npm run prestart` to download the locked runtime. Copy `node_modules/electron/dist` to a standalone folder outside `node_modules`, set `ELECTRON_EXEC_PATH` in your current PowerShell session to the copied `electron.exe`, then run `npm run dev` again. Keep sandboxing enabled. [Electron's Windows launch issue](https://github.com/electron/electron/issues/54614)

## Start with fai

1. The app opens in your chat with **fai**, the main bot. In **Settings → Models & providers**, connect a provider you already use. Choose its model in the profile for fai.
2. Give fai a job. For example, “Find a bot to edit this product description. If we need an editor, propose one. Bring the revised text back here.”
3. When a new bot is needed, review its role and model in the approval card. A specialist can use the configured default model or the model already assigned to fai.
4. You can also create bots yourself in **New Bot**, talk directly to a specialist or choose several bots in **New chat**. Reopening the app takes you back to fai.

When a job needs several steps, fai can keep a work brief in the chat. Open it to see the deliverable and checks, update that job, answer a question, or accept a result. A specialist can work in the background while you speak with fai. The brief and its verified returns survive reopening the app.

Projects have a Library for selected source revisions, a Space for reviewed Pages, and separate session histories. You choose which work to bring into a new session. Project instructions can be tried on two sets of notes before you activate them.

A bot’s profile gives you access to its tools, memory, skills and routines. Start a routine manually to check its result before giving it a schedule. Scheduled routines run while the desktop app is open.

Chats and settings are stored on your computer. A model request sends the conversation context it needs to the provider you configured. Tools and connectors can access additional information according to their permissions.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

The desktop app uses Electron. The optional browser UI preview uses example data. Routines require the desktop process to be running. This release is a source preview. Build configuration is included for maintainers preparing a Windows installer.

On Windows, `npm run prestart` followed by `node tests/windows-desktop-smoke.cjs` checks the built desktop app with a local model fixture. It exercises the desktop runtime with fictional data and checks that records survive reopening.

## Licensing

The fai.qa-owned code and documentation are available under the [MIT License](LICENSE). The brand assets and integrated affectUI Pro component keep their separate terms. See [Notice](NOTICE.md) and [third-party notices](THIRD_PARTY_LICENSES/README.md).

See [Contributing](CONTRIBUTING.md) for feedback and changes, and [Security](SECURITY.md) for private vulnerability reports.
