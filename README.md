# faibots

Local Windows desktop app for a team of AI agents.

Create bots, pick their models, and chat one-to-one or in a group. Run routines. Bring your own model providers and MCP connectors. Chats and settings stay on your computer.

[![Windows checks](https://github.com/fai-qa/faibots/actions/workflows/windows-checks.yml/badge.svg)](https://github.com/fai-qa/faibots/actions/workflows/windows-checks.yml)
[![MIT license](https://img.shields.io/github/license/fai-qa/faibots)](https://github.com/fai-qa/faibots/blob/main/LICENSE)
[![Latest release](https://img.shields.io/github/v/release/fai-qa/faibots?include_prereleases)](https://github.com/fai-qa/faibots/releases)

<!-- demo GIF: two-bot group chat, added in a later PR -->

## Quick start

Use Windows x64, Git and Node.js 24.20.0.

```powershell
git clone https://github.com/fai-qa/faibots.git
cd faibots
npm ci
npm run dev
```

1. In **Settings**, open **Models & providers**, choose **Add provider**, and press **Test**.
2. Choose **New Bot**, give it a name and a **Label**, and select its model on **Profile**.
3. Open its chat. Create a second bot, then use **New chat** and select both for a group.

## faibots desktop preview

faibots is a local Windows workspace for running your own team of AI bots. Give each bot a role and model, talk to it directly or bring several bots into a group chat. Bots can ask each other for help. You control which tools and connectors they can use, and which actions need your approval.

## Run from source

Use Windows x64, Git and Node.js 24.20.0. From the source directory:

```powershell
npm ci
npm run dev
```

Model availability and sign-in depend on your provider.

If Electron exits immediately on Windows, run `npm run prestart` to download the locked runtime. Copy `node_modules/electron/dist` to a standalone folder outside `node_modules`, set `ELECTRON_EXEC_PATH` in your current PowerShell session to the copied `electron.exe`, then run `npm run dev` again. Keep sandboxing enabled. [Electron's Windows launch issue](https://github.com/electron/electron/issues/54614)

## Try your first bot

1. In **Settings → Models & providers**, add a provider you already use and test the connection.
2. Choose **New Bot**, give it a name and role, and select its model in the bot’s profile.
3. Open its chat and give it a small task. Close and reopen the app to pick up the conversation.
4. To work with two bots, create a second bot and use **New chat** to select both. Mention the bot you want to answer.

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
