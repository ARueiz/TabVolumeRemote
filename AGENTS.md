# AGENTS.md — TabVolumeRemote

## 1. Project Overview

TabVolumeRemote is a lightweight, LAN-only remote volume controller.

Its primary goal is to allow an Android phone to control the audio volume of a specific browser tab running in Google Chrome or Microsoft Edge on Windows 11.

The project owner has installed Chrome and confirmed basic functionality on Chrome and Edge. These are now the acceptance browsers. Samsung Internet for Windows has an unresolved access/request-source failure: record it as a Known Issue, do not fix it in the multi-site phase, and do not relax Origin or authentication checks for compatibility. Prior Samsung Milestone 1 and 2 results remain historical records.

The user should be able to select a browser tab and adjust its volume without affecting other tabs, applications, or the Windows system volume.

### Core Principles

- Keep the implementation simple and maintainable.
- Prioritize a working MVP over advanced features.
- Avoid unnecessary frameworks, abstractions, and dependencies.
- Prefer native browser APIs and standard web technologies.
- Do not introduce a database, cloud infrastructure, or external authentication provider.
- Do not implement features outside the agreed scope without discussion.
- Prioritize security because the application exposes controls over a local network.

## 2. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js LTS |
| Backend | Node.js with minimal dependencies |
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Browser Extension | Chrome Extension Manifest V3 |
| Communication | HTTP / JSON, polling for MVP |
| Target OS | Windows 11 |
| Mobile Client | Android browser |
| Browser Support | Google Chrome and Microsoft Edge (acceptance browsers) |

Use JavaScript initially. Do not introduce TypeScript, React, Vue, Next.js, or other frameworks unless there is a demonstrated need.

## 3. Project Structure

```text
TabVolumeRemote/
├── AGENTS.md
├── README.md
├── .gitignore
├── server/
│   ├── package.json
│   ├── server.js
│   └── public/
│       ├── index.html
│       ├── style.css
│       └── app.js
└── extension/
    ├── manifest.json
    ├── background.js
    └── content.js
```

Keep files small and responsibilities clearly separated.

Do not introduce additional architectural layers unless complexity justifies them.

## 4. System Architecture

The system consists of three components.

### Android Web Client

Responsibilities:

- Display available browser tabs.
- Allow the user to select a target tab.
- Display a volume slider ranging from 0 to 100.
- Provide mute and unmute controls.
- Display connection and error states.

The client communicates with the Node.js server over the local network.

### Node.js Server

Responsibilities:

- Serve the mobile web interface.
- Receive commands from authenticated mobile clients.
- Maintain a temporary list of browser tabs reported by the extension.
- Queue or relay commands to the browser extension.
- Validate all incoming requests.
- Keep state in memory.

The server must not directly modify browser audio.

### Browser Extension

Responsibilities:

- Discover browser tabs using the Chrome Tabs API.
- Report relevant tab information to the Node.js server.
- Receive pending commands from the server.
- Route commands to the correct browser tab.
- Adjust HTMLMediaElement volume and muted properties.
- Report command success or failure.

Use Manifest V3 APIs.

Do not assume that the background service worker runs continuously.

## 5. MVP Functional Requirements

### FR-01: Browser Tab Discovery

- Retrieve open browser tabs.
- Display each tab's title and URL when available.
- Use Chrome's tab ID to identify the target tab.
- Exclude internal browser pages that cannot be controlled.
- Handle closed, refreshed, and navigated tabs gracefully.
- Treat tab IDs as temporary identifiers, not persistent identities.

### FR-02: Tab Selection

- Allow the Android user to select one tab.
- Show the currently selected tab.
- Prevent commands from affecting other tabs.
- Handle unavailable tabs without crashing.

### FR-03: Volume Adjustment

- Accept volume values from 0 to 100.
- Convert the value into the HTMLMediaElement range of 0.0 to 1.0.
- Modify applicable video and audio elements in the selected tab.
- Do not change the Windows master volume.
- Do not modify audio elements in other tabs.
- Do not use Chrome's tabCapture API for the initial MVP.

### FR-04: Mute Control

- Support mute and unmute commands.
- Preserve the previously selected volume when muting.
- Treat muted state separately from the volume value.
- Do not assume setting volume to zero is equivalent to muting.

### FR-05: Mobile Interface

- Responsive layout optimized for Android.
- Large, touch-friendly controls.
- Clear selected-tab information.
- Volume slider with numeric percentage.
- Mute/unmute button.
- Connection status indicator.
- Clear error messages.

### FR-06: State Synchronization

- Refresh tab information periodically.
- Update the mobile interface when tabs are opened or closed.
- Handle temporary disconnections.
- Avoid excessive polling.
- Prevent obsolete commands from being applied to a different tab.

## 6. Audio Control Strategy

For the MVP, use HTMLMediaElement.

Example:

```javascript
let mediaElements = document.querySelectorAll(
  "video, audio"
);

for (let element of mediaElements) {
  element.volume = 0.5;
}
```

This is an illustrative example, not the complete implementation.

Important limitations:

- Some websites use custom audio systems.
- Cross-origin iframes may require additional permissions.
- Websites may replace media elements dynamically.
- Some websites may reset their own volume.
- Web Audio API-based audio may not be controllable through HTMLMediaElement.
- DRM-protected or otherwise restricted content may behave differently.

Do not claim universal website compatibility.

The target websites are YouTube, Twitch and Hami Video, using an explicit origin allowlist. Reuse HTMLMediaElement controls, and inspect actual frame structure before adding iframe permissions or routing. Do not infer playback control failure merely from DRM.

Additional websites should be supported incrementally after testing.

If multiple media elements exist in the same tab, apply the command to all accessible relevant elements for the MVP.

## 7. Communication Design

Use a simple HTTP/JSON protocol initially.

Suggested endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/tabs | Retrieve known browser tabs |
| POST | /api/volume | Submit volume command |
| POST | /api/mute | Submit mute command |
| POST | /api/extension/register | Register extension session |
| POST | /api/extension/tabs | Report browser tabs |
| GET | /api/extension/commands | Retrieve pending commands |
| POST | /api/extension/results | Report command results |

These endpoints are proposals and may be refined during implementation.

Example volume command:

```json
{
  "tabId": 123,
  "volume": 45
}
```

Example mute command:

```json
{
  "tabId": 123,
  "muted": true
}
```

Internal extension commands should include a unique command ID and extension session identifier.

Use explicit acknowledgements to distinguish:

- Command received by the server.
- Command delivered to the extension.
- Command successfully applied.
- Command failed.

Do not report success to the user before the extension confirms execution.

## 8. Manifest V3 Requirements

- Use manifest_version 3.
- Use the minimum required permissions.
- Use a background service worker.
- Use chrome.tabs and chrome.scripting only where necessary.
- Use content scripts to interact with webpage media elements.
- Avoid broad host permissions when narrower permissions are practical.
- Do not use remotely hosted executable code.
- Do not rely on persistent background execution.

The extension must tolerate service worker suspension and restart.

If periodic polling cannot meet responsiveness requirements, evaluate an alternative communication mechanism and explain the tradeoffs before implementing it.

## 9. Security Requirements

The application is intended for trusted local networks only.

Security requirements:

- Never expose the server directly to the public internet.
- Do not configure router port forwarding.
- Use a random authentication token or pairing secret.
- Authenticate mobile requests and extension communication.
- Validate request origins where applicable.
- Validate every command and parameter.
- Reject invalid volume values and unknown commands.
- Bind the server only to explicitly configured local interfaces.
- Do not treat LAN access alone as authentication.
- Avoid storing secrets in source control.
- Do not log authentication secrets.
- Do not expose arbitrary filesystem or command execution APIs.
- Avoid wildcard CORS policies.
- Restrict Chrome extension permissions.

Use separate credentials or appropriately scoped authorization for mobile control and extension communication.

Consider HTTPS or a safer pairing mechanism if the application will be used on untrusted networks.

## 10. Coding Conventions

### JavaScript

- Prefer `let` for variable declarations.
- Use `const` only when it materially improves clarity.
- Never use `var`.
- Use async/await for asynchronous operations.
- Use meaningful names.
- Prefer small functions with a single responsibility.
- Avoid unnecessary classes.
- Avoid deeply nested conditions.
- Handle errors explicitly.
- Avoid unexplained magic numbers.

### Naming

- Variables and functions: camelCase
- Classes: PascalCase
- Constants: UPPER_SNAKE_CASE when appropriate
- Filenames: lowercase or kebab-case, consistently

### Comments

Explain why code exists rather than merely describing what it does.

Use comments for:

- Browser API limitations.
- Security decisions.
- Non-obvious synchronization behavior.
- Important technical tradeoffs.

Avoid excessive comments on straightforward code.

## 11. Error Handling

Handle at least these cases:

- Windows server is unavailable.
- Browser extension is disconnected.
- Target tab has been closed.
- Target tab is an unsupported browser page.
- Target page contains no controllable media.
- Extension permissions are insufficient.
- Command execution times out.
- Authentication fails.
- Invalid volume values are submitted.
- The browser service worker restarts.

Errors must not crash the entire application.

Provide understandable messages to the mobile user.

## 12. Testing Requirements

Prioritize practical tests.

### Backend

Test:

- Input validation.
- Authentication.
- Command routing.
- Command expiration.
- Unknown tab IDs.
- Invalid requests.

### Browser Extension

Test:

- Tab discovery.
- Correct tab targeting.
- Volume adjustment.
- Mute and unmute.
- Tab closure.
- Page refresh.
- Service worker restart.
- Unsupported pages.

### End-to-End

Test with:

- Windows 11.
- Google Chrome and Microsoft Edge.
- Android phone connected to the same LAN.
- YouTube video playback.

Verify that adjusting one tab does not modify another tab or the Windows system volume.

## 13. Development Milestones

### Milestone 1 — Extension Prototype

Implement a basic extension that can adjust the volume of a selected YouTube tab.

No Node.js server is required yet.

Acceptance criteria:

- Select a YouTube tab.
- Adjust its volume.
- Other tabs remain unaffected.

### Milestone 2 — Local Server

Implement a minimal Node.js HTTP server.

Acceptance criteria:

- Server starts locally.
- Android phone can open the control page over LAN.
- Authentication is required for control operations.

### Milestone 3 — Command Integration

Connect the mobile interface, server, and extension.

Acceptance criteria:

- Mobile commands reach the extension.
- Commands target the correct tab.
- Success or failure is reported accurately.

### Milestone 4 — Usability

Implement:

- Tab selection UI.
- Volume slider.
- Mute/unmute.
- Connection status.
- Error feedback.

### Milestone 5 — Reliability

Handle:

- Page refresh.
- Tab closure.
- Browser restart.
- Service worker suspension.
- Temporary network disconnection.

## 14. Out of Scope

Do not implement the following in the MVP:

- Native Android application.
- Windows audio driver integration.
- Windows system volume control.
- Per-application Windows audio mixer.
- Cloud hosting.
- Internet-based remote access.
- User accounts.
- Database persistence.
- Docker deployment.
- React or Vue frontend.
- Web Audio API audio interception.
- Chrome tabCapture.
- Universal support for every streaming website.
- AI-related functionality.

Only introduce these features after explicit approval.

## 15. Definition of Done

The MVP is complete when:

1. The Node.js server runs on Windows 11.
2. The Android phone can access the control interface over LAN.
3. The browser extension reports available tabs.
4. The user can select a YouTube tab.
5. The user can change its volume from 0 to 100.
6. The user can mute and unmute the tab.
7. Other tabs and Windows applications are unaffected.
8. Invalid or unauthorized commands are rejected.
9. The interface handles connection failures gracefully.
10. The README contains clear setup and usage instructions.

## 16. Instructions for Codex

Before implementing a feature:

1. Read this AGENTS.md.
2. Inspect the existing project structure.
3. Identify the smallest implementation that satisfies the requirement.
4. Explain any necessary architectural changes.
5. Avoid adding dependencies without justification.

During implementation:

- Follow the agreed architecture.
- Keep changes focused.
- Do not silently expand the feature scope.
- Do not weaken security for convenience.
- Prefer simple and testable solutions.
- Add tests for meaningful behavior.

After implementation:

- Summarize the files changed.
- Explain important implementation decisions.
- Report tests executed and their results.
- Identify limitations and unresolved issues.
- Suggest the next logical development step.

### Communication Language

Use Traditional Chinese (繁體中文) when communicating with the project owner.

Code identifiers, API names, filenames, and technical terminology may remain in English.

### Learning-Oriented Development

The project owner is an experienced web developer but may be unfamiliar with Chrome Extension APIs.

When introducing unfamiliar browser APIs or architectural concepts:

- Explain their purpose.
- Explain why they are needed.
- Describe relevant alternatives.
- Avoid unnecessary theoretical explanations.
- Prioritize practical understanding.

The goal is to build a useful tool while maintaining a clear understanding of how the system works.
