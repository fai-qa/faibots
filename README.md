# faibots desktop preview

faibots is a Windows desktop app from fai.qa for working with a small AI team. Set up bots with their own roles and model routes, attach project notes, and run a mission. The app saves the proposal and the reviewer's decision so you can inspect both before deciding what to use.

## Run from source

Use Windows x64, Git and Node.js 24.20.0. From the source directory:

```powershell
npm ci
npm run dev
```

Open **Settings → Providers** to configure a supported model you already have access to. Use **Test connection** before starting a mission. Model availability and sign-in are provider-specific.

If Electron exits immediately on Windows, run `npm run prestart` to download the locked runtime. Copy `node_modules/electron/dist` to a standalone folder outside `node_modules`, set `ELECTRON_EXEC_PATH` in your current PowerShell session to the copied `electron.exe`, then run `npm run dev` again. Keep sandboxing enabled. [Electron's Windows launch issue](https://github.com/electron/electron/issues/54614)

## Try the proposal workflow

1. Create a visible **Proposal Drafter** as the primary bot. Assign a working model and tell it to draft only from the selected project notes.
2. Create a **Proposal Reviewer**, assign a working model, and tell it to review the supplied notes and draft in the chat. The mission uses another visible bot with a model as the reviewer. In the reviewer's **Tools** tab, set `read_file` to **Never** for this sample. The reviewer receives the selected evidence as part of the task.
3. Create a project, attach [the fictional workshop notes](examples/workshop-notes.md), and select **Start the mission**.
4. Open **Artifacts & review** and expand **Latest revision**. Read the review decision, then decide whether the draft is useful.

Use Markdown or plain-text notes. Model calls may send the selected text and draft to your configured provider. Local app records stay on your computer. Your provider and any connector you configure have their own data policies.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

The desktop app uses Electron. The optional browser UI preview uses example data. Routines require the desktop process to be running. This release is a source preview. Build configuration is included for maintainers preparing a Windows installer.

On Windows, `npm run prestart` followed by `node tests/windows-desktop-smoke.cjs` checks the built desktop app with a local model fixture. It checks proposal creation, review, and reopening without credentials.

## Licensing

The fai.qa-owned code and documentation are available under the [MIT License](LICENSE). The brand assets and integrated affectUI Pro component keep their separate terms. See [Notice](NOTICE.md) and [third-party notices](THIRD_PARTY_LICENSES/README.md).

See [Contributing](CONTRIBUTING.md) for feedback and changes, and [Security](SECURITY.md) for private vulnerability reports.
