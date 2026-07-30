INDEPENDENT UI, SESSION-LIFECYCLE AND SECURITY IMPLEMENTATION PROMPT

Role

Act as a senior full-stack engineer, browser-session security specialist, UX architect and independent code reviewer.

Modify the web application:

https://bot-trade-five.vercel.app

The supplied screenshot shows the present large footer and floating browser-tab status panel. Redesign this area without disturbing trading controls, account information, strategy tables or other existing functionality.

PRIMARY OBJECTIVES

1. Replace the present large page-wide footer with a compact, single-line session-status control.
2. Move this control into the bottom of the left navigation panel.
3. Keep the visible status text at a maximum font size of 10px.
4. Clicking the current-client status opens an accessible information popover.
5. Protect the current browser session from being disconnected through its own session-management interface.
6. Allow authenticated users to revoke and disconnect other browser sessions using this web application.
7. Ensure a revoked remote session cannot continue connecting, receiving events, submitting commands or consuming queued/spooled data.
8. Show how long each browser session has been alive and when it was last seen.
9. Use semantic W3C-compatible HTML, accessible interaction patterns and Apple-inspired visual controls.
10. Do not create oval capsule buttons. Use compact rounded rectangles.

IMPORTANT BROWSER LIMITATION

Do not claim that the application can always physically close another device’s browser tab.

For remote devices, implement:

- Revoke session
- Disconnect transport
- Stop server-side event delivery
- Reject subsequent API requests
- Cancel session-owned queued work
- Clear session-owned temporary server buffers
- Force the remote page into a revoked or signed-out state

Only call window.close() when the browser explicitly permits it, such as a window originally opened by script or a supported installed-app environment.

The user-facing action should therefore be labelled:

“Disconnect session”

Do not label it “Close browser” unless physical closing is technically confirmed for that environment.

LEFT NAVIGATION SESSION CONTROL

Move the existing footer information into a sidebar footer anchored to the bottom of the left navigation column.

Required layout:

[status dot] [browser name] · [state] · [last-seen age] [chevron]

Example:

● Chrome · Active · 3s ago ›

Requirements:

- One visible line only
- Maximum visible font size: 10px
- Suggested line height: 12px
- No wrapping
- Use text-overflow: ellipsis
- Maintain sufficient width for the account-navigation content
- Do not overlay the strategy table
- Do not obstruct mobile navigation
- Keep the sidebar footer visible while the main content scrolls
- Use position: sticky or the existing application-shell layout
- Avoid fixed positioning where it causes overlap
- Add a subtle top divider
- Do not use large shadows
- Do not create a second page-wide footer

Suggested semantic structure:

<aside aria-label="Account navigation">
  <nav>...</nav>

  <section class="sidebar-session-footer"
           aria-label="Browser session status">
    <button type="button"
            aria-haspopup="dialog"
            aria-expanded="false"
            aria-controls="current-session-popover">
      ...
    </button>
  </section>
</aside>

CURRENT-SESSION POPOVER

When the user clicks the compact session line, open an anchored popover or non-modal dialog showing:

- Browser name
- Browser version
- Operating system
- Device category
- Current-session marker
- Approximate location only when already lawfully available
- Session ID, partially masked
- Connection state
- Transport type: WebSocket, SSE, polling or disconnected
- Session-created time
- Alive duration
- Last heartbeat time
- Last successful API request
- Last server acknowledgement
- Current application build
- Remote IP, masked unless operationally necessary
- Authentication state
- Token-expiry time
- Queued or in-flight command count
- Trading-controller subscription state

Example:

Chrome 138 on macOS
This device
Active for 2h 14m
Last seen 3s ago
WebSocket connected
Build 4829608
Session …7A21

The popover must:

- Remain inside the viewport
- Reposition automatically near screen edges
- Be keyboard accessible
- Open with Enter or Space
- Close with Escape
- Return focus to the activating control
- Close when clicking outside
- Use role="dialog" or a standards-compliant popover implementation
- Have an accessible title
- Trap focus only when operating as a modal dialog
- Avoid obscuring important trading controls

CURRENT-SESSION PROTECTION

The session being used to view the session panel must be marked:

is_current_session = true

For this current session:

- Do not show an enabled Disconnect button
- Do not permit self-revocation through the session-list endpoint
- Do not permit accidental termination from a stale UI
- Show a neutral label: “This device”
- Optionally provide a separate standard “Sign out” command elsewhere
- Return HTTP 409 or another suitable conflict response if a direct self-revoke request reaches the server
- Record the rejected attempt in the security audit log

The backend must identify the current session from the authenticated server-side session context. Do not trust a client-provided isCurrent flag.

REMOTE-SESSION LIST

Below the current-session information, display other sessions using compact rows:

[device/browser] [state] [alive duration] [last seen] [Disconnect]

Example:

Safari · iPhone
Active 18m · seen 6s ago
[Disconnect]

Edge · Windows
Stale · seen 2m ago
[Disconnect]

Each remote-session row must contain:

- Browser and device
- Created time
- Alive duration
- Last-seen age
- Current health state
- Connection type
- Application build
- A danger-styled Disconnect action

Sort order:

1. Current session
2. Other active sessions
3. Idle sessions
4. Stale sessions
5. Revoked or disconnected sessions

Do not display raw authentication tokens, refresh tokens, cookies, credentials or complete internal identifiers.

SESSION HEARTBEAT AND ALIVE STATUS

Implement a server-authoritative heartbeat rather than relying only on the browser clock.

Recommended default behaviour:

- Browser heartbeat interval: 5 seconds
- Server heartbeat acknowledgement required
- Add bounded jitter to avoid synchronised reconnect bursts
- Consider a session active when the last valid heartbeat is no more than 15 seconds old
- Consider it idle when last seen is more than 15 seconds but no more than 60 seconds old
- Consider it stale when last seen is more than 60 seconds but no more than 120 seconds old
- Consider it disconnected when transport closure is confirmed or no valid heartbeat exists for more than 120 seconds
- Consider it revoked immediately after server-side revocation, regardless of the last heartbeat

Make all thresholds configurable.

Display both:

- Alive duration: now - authenticated_session_created_at
- Last-seen age: now - last_server_verified_activity_at

Example display:

Active for 2h 14m · seen 3s ago

Do not reset the alive duration merely because a WebSocket reconnects. Reset it only when a genuinely new authenticated session is created.

Use server timestamps internally. Send ISO 8601 UTC timestamps to the client and localise them only for presentation.

REMOTE DISCONNECTION WORKFLOW

When the user selects Disconnect for another session:

1. Open a confirmation dialog.
2. Clearly identify the remote browser and device.
3. Explain that active operations from that browser will be stopped.
4. Require a deliberate confirmation.
5. Submit a server-authenticated revocation request.
6. Disable repeated clicks while the operation is pending.
7. Show success only after server acknowledgement.
8. Update the session row to “Revoked”.
9. Preserve an audit record.

Suggested confirmation copy:

Disconnect Safari on iPhone?

This will sign out that browser, terminate its live connection and stop further event delivery. In-flight trading requests already accepted by the server will be handled according to the trading safety policy.

Buttons:

[Cancel] [Disconnect session]

Do not allow the client to declare success before the server confirms revocation.

SERVER-SIDE REVOCATION REQUIREMENTS

Revocation must be enforced centrally and atomically.

For the selected remote session:

- Mark the session as revoked in the authoritative session store
- Record revoked_at
- Record revoked_by_session_id
- Record user ID
- Record reason
- Increment the session security version or generation
- Revoke the refresh token or refresh-token family
- Invalidate active access tokens where the architecture supports immediate invalidation
- Close mapped WebSocket connections
- Close SSE streams
- Stop polling authorisation
- Remove transport subscriptions
- Cancel uncommitted session-owned jobs
- Remove session-owned queued notifications
- Remove session-owned temporary response buffers
- Reject subsequent commands
- Reject reconnection attempts using the revoked credentials
- Broadcast a SESSION_REVOKED control event when the transport is still reachable
- Return the remote UI to an unauthenticated or revoked-session screen

The remote page must not be able to reconnect using the same revoked refresh token, session cookie or device-session credential.

Every protected API request must validate:

- User identity
- Session identity
- Session revocation state
- Token expiry
- Token generation or security version
- Required authorisation
- Account access
- Request freshness where applicable

Do not rely only on a client-side disconnected flag.

WEBSOCKET AND EVENT-STREAM CONTROLS

Maintain a server-side registry such as:

user_id
session_id
connection_id
transport
connected_at
last_heartbeat_at
last_ack_at
subscriptions
queued_event_count
revoked_at
security_generation

On revocation:

1. Atomically mark the session revoked.
2. Remove its subscriptions.
3. Stop publishing new events to it.
4. Discard non-essential session-targeted events.
5. Close the transport with a defined application close code.
6. Reject automatic reconnect authentication.
7. Confirm closure or timeout.
8. Record the outcome.

Use an application-specific WebSocket close code and a machine-readable reason, for example:

{
  "type": "SESSION_REVOKED",
  "sessionId": "...",
  "effectiveAt": "...",
  "reconnectAllowed": false
}

Do not include confidential details in the close reason.

SPOOLING AND QUEUE SAFETY

Define precisely what “spooling” means in the existing application before changing queue behaviour.

Inspect:

- Browser-side offline queues
- Service-worker queues
- IndexedDB pending commands
- LocalStorage command buffers
- Server-side message queues
- WebSocket outbound queues
- Event-stream replay buffers
- Trading-controller command queues
- Notification queues
- Retry workers

On session revocation:

- Stop accepting new work from that session
- Mark unaccepted queued requests as cancelled
- Remove session-targeted outbound messages
- Prevent replay to the revoked session
- Expire session-scoped server buffers
- Clear sensitive client-side caches when the revoked page receives the event
- Do not delete user-wide or account-wide trading records
- Do not cancel already accepted trading commands unless the established trading safety policy explicitly requires it
- Keep immutable security and trading audit records
- Ensure idempotent cleanup

Distinguish:

1. Not yet received by the server
2. Received but not accepted
3. Accepted by the trading controller
4. Submitted to a broker
5. Broker acknowledged
6. Completed or rejected

Never silently erase an accepted or broker-submitted command.

REMOTE CLIENT CLEANUP

When a remote page receives SESSION_REVOKED:

- Stop reconnect timers
- Close WebSocket or EventSource
- Abort pending fetch requests where possible
- Stop heartbeat timers
- Unsubscribe listeners
- Cancel non-essential local retry queues
- Clear session-scoped in-memory state
- Clear sensitive session-scoped IndexedDB data
- Clear sensitive session-scoped Cache Storage entries
- Remove session-scoped localStorage and sessionStorage entries
- Unregister session-specific background synchronisation
- Navigate to a signed-out or session-revoked page

Do not attempt to clear unrelated browser data.

Assume a remote device may be offline and unable to receive the cleanup event. Server-side revocation must therefore remain sufficient to prevent future access.

TRADING-SAFETY REQUIREMENTS

Session disconnection must not weaken trading controls.

Before terminating a remote session:

- Do not remove account-level risk vetoes
- Do not reinterpret unknown PnL as zero
- Do not allow queued orders to bypass validation
- Do not stop server-side monitoring for already accepted orders
- Do not abandon broker reconciliation
- Do not cancel shared trading-controller processes
- Do not terminate another user’s sessions
- Do not affect the protected current session

Clarify whether disconnecting a session should:

- Only terminate its user interface connection
- Cancel unsubmitted draft orders
- Cancel server-accepted orders
- Cancel broker-working orders

Default safely to terminating the user-interface session only. Never cancel accepted or broker-working orders without an explicit, separately authorised trading action.

BUTTON AND PILL DESIGN

Use compact rounded rectangles, not oval capsules.

Visual pill requirements:

- Border radius: 6px to 8px
- Never use border-radius: 9999px
- Vertical text padding: 2px
- Horizontal text padding: 6px
- One-line text
- Medium font weight
- Visible focus ring
- Semantic colour tokens
- Dark-mode support
- Disabled-state styling
- Hover, active, focus and pending states

Normal functional control:

- Blue text
- Blue-tinted background
- Subtle blue border
- Example semantic classes:
  .button-normal
  .status-active
  .action-primary

Danger control:

- Red text
- Red-tinted background
- Subtle red border
- Example semantic classes:
  .button-danger
  .action-disconnect

Example CSS direction:

:root {
  --control-radius: 7px;
  --control-padding-block: 2px;
  --control-padding-inline: 6px;

  --normal-text: #0066cc;
  --normal-background: rgba(0, 122, 255, 0.10);
  --normal-border: rgba(0, 122, 255, 0.24);

  --danger-text: #c62828;
  --danger-background: rgba(255, 59, 48, 0.10);
  --danger-border: rgba(255, 59, 48, 0.24);
}

.compact-control {
  border-radius: var(--control-radius);
  padding: var(--control-padding-block)
           var(--control-padding-inline);
  white-space: nowrap;
}

Do not depend only on colour to communicate danger or status. Include text, iconography or an accessible label.

APPLE-INSPIRED INTERACTION WITH ACCESSIBLE HIT TARGETS

The visible pill may use 2px vertical padding, but the interactive target must remain comfortably clickable.

Use one of these patterns:

- Place the compact visual pill inside a larger transparent button hit area
- Add an invisible pseudo-element that expands the clickable area
- Give each row sufficient height while keeping the visible pill compact

Do not reduce the actual touch target to a 10px-high control.

Use:

- Subtle motion
- Short transitions
- Clear pressed state
- No excessive spring animation
- Reduced-motion support
- Consistent corner radii
- Clear hierarchy
- Restrained shadows
- Native-feeling keyboard and pointer behaviour

ACCESSIBILITY AND W3C REQUIREMENTS

Use:

- Semantic HTML
- WAI-ARIA only where native semantics are insufficient
- Logical heading order
- Keyboard-operable controls
- Visible focus indication
- Accessible names
- Sufficient contrast
- Screen-reader status announcements
- aria-live="polite" for ordinary session-status changes
- aria-live="assertive" only for security-critical revocation
- prefers-reduced-motion support
- High-contrast mode support
- 200% text zoom without loss of function
- Responsive reflow
- No status information communicated solely by colour

Although the visual status line is capped at 10px, ensure browser zoom and user font scaling remain effective. Do not disable zoom.

RESPONSIVE BEHAVIOUR

Desktop:

- Session footer remains at the bottom of the left navigation
- Popover opens to the right or above the status row
- Main trading content retains its full working area

Narrow screens:

- Move the session control into the navigation drawer
- Keep it near the bottom of the drawer
- Do not place it over trading controls
- Popover may become a bottom sheet or modal dialog
- Preserve the same session-management functions

Collapsed sidebar:

- Show a status dot or browser icon
- Provide a tooltip
- Clicking opens the same session panel
- Keep an accessible label such as “Current browser session”

DATA MODEL

Use a server-authoritative session record similar to:

Session {
  id
  userId
  deviceId
  browserFamily
  browserVersion
  operatingSystem
  deviceType
  createdAt
  authenticatedAt
  lastHeartbeatAt
  lastActivityAt
  lastAcknowledgementAt
  transportType
  connectionState
  connectionIds[]
  appBuild
  securityGeneration
  refreshTokenFamilyId
  revokedAt
  revokedBySessionId
  revocationReason
}

Do not use browser fingerprinting as the sole session identity.

Use a cryptographically random session identifier. Store sensitive token material securely and never return it to the session-list UI.

SUGGESTED API CONTRACTS

GET /api/sessions

Returns the current authenticated user’s sessions with safe display fields only.

Example:

{
  "currentSessionId": "session-current",
  "serverTime": "2026-07-30T06:57:00Z",
  "sessions": [
    {
      "id": "session-current",
      "isCurrent": true,
      "browser": "Chrome",
      "os": "macOS",
      "deviceType": "desktop",
      "createdAt": "...",
      "lastSeenAt": "...",
      "state": "active",
      "transport": "websocket",
      "appBuild": "4829608",
      "canDisconnect": false
    }
  ]
}

POST /api/sessions/{sessionId}/revoke

Requirements:

- Authenticated request
- CSRF protection where relevant
- Same-user ownership validation
- Current-session rejection
- Rate limiting
- Idempotency
- Audit logging
- Server-authoritative success response

Example response:

{
  "sessionId": "...",
  "state": "revoked",
  "revokedAt": "...",
  "transportClosed": true,
  "queuedItemsCancelled": 3
}

Do not disclose sensitive queue contents.

AUDIT EVENTS

Record structured events for:

- Session created
- Transport connected
- Transport reconnected
- Heartbeat missed
- Session became stale
- Session recovered
- Disconnect requested
- Disconnect confirmed
- Self-disconnect rejected
- Token refresh rejected
- Revoked session attempted reconnect
- Queue cleanup completed
- Queue cleanup failed

Each event should include:

event
timestampUtc
userId
actorSessionId
targetSessionId
connectionId
applicationBuild
result
reasonCode
correlationId

Never store access tokens, refresh tokens or complete cookies in logs.

FAILURE HANDLING

Handle:

- Revocation database failure
- WebSocket close timeout
- Multiple connections under one session
- Duplicate revocation requests
- Remote session reconnect race
- Browser offline during revocation
- Server restart
- Multi-region session state
- Message-bus delay
- Expired sessions
- Clock skew
- Stale frontend session list
- Network partition
- Queue-cleanup partial failure

Revocation must remain effective even if transport closure fails.

The authoritative revoked state must be checked when the remote client next communicates.

TESTING REQUIREMENTS

Create tests for:

1. Footer appears only in the left navigation.
2. Footer remains one line at supported widths.
3. Visible footer font does not exceed 10px.
4. Long browser labels truncate correctly.
5. Current-session popover opens by pointer and keyboard.
6. Escape closes the popover.
7. Focus returns correctly.
8. Current session cannot be disconnected.
9. Direct self-revoke API calls are rejected.
10. Another session can be revoked.
11. Revoked WebSocket is closed.
12. Revoked SSE stream is closed.
13. Revoked tokens cannot reconnect.
14. Revoked sessions cannot submit commands.
15. Remote pending non-accepted jobs are cancelled.
16. Accepted trading work remains governed by trading policy.
17. Offline remote sessions remain revoked when they reconnect.
18. Multiple tabs under the same session are handled consistently.
19. Multiple separate sessions on the same browser remain distinguishable.
20. Alive duration remains stable after transport reconnect.
21. Last-seen value updates from server-authoritative timestamps.
22. Session-state thresholds work at boundary values.
23. Screen readers announce session changes.
24. Keyboard-only operation works.
25. Dark mode and high-contrast mode remain usable.
26. Browser zoom does not break the control.
27. Mobile navigation does not obscure trading controls.
28. No account, PnL or strategy behaviour regresses.
29. Revocation and cleanup events are auditable.
30. No secret token appears in client payloads or logs.

ACCEPTANCE CRITERIA

The implementation is complete only when:

- The former large footer no longer occupies the main content width.
- The session indicator appears as one compact line at the bottom of the left navigation.
- The visible status font is no larger than 10px.
- Clicking it opens complete current-session information.
- Current-session self-disconnection is impossible through the session-management feature.
- Other sessions can be securely revoked.
- Revoked sessions lose API, WebSocket, SSE and polling access.
- Revoked credentials cannot reconnect.
- Session-specific event delivery and temporary spooling stop.
- Sensitive cached session data is cleared when the remote client is reachable.
- Offline clients remain blocked server-side.
- Each browser displays alive duration and last-seen age.
- Normal buttons use blue text with a blue-tinted background.
- Danger buttons use red text with a red-tinted background.
- Buttons have rounded rectangular corners rather than oval ends.
- Visual pill padding is 2px vertically with a larger accessible hit target.
- The interface supports keyboard, screen reader, zoom, dark mode and reduced motion.
- Trading risk, PnL vetoes and order-state controls remain unaffected.

REQUIRED RESPONSE FORMAT

Return:

1. Existing-component assessment
2. Proposed component hierarchy
3. Session-state architecture
4. Backend revocation flow
5. Queue and spooling cleanup flow
6. React, TypeScript or framework-equivalent component changes
7. CSS changes
8. API changes
9. Database or session-store changes
10. Security controls
11. Accessibility review
12. Automated tests
13. Manual verification checklist
14. Rollback plan
15. Files changed
16. Patch or complete code

Do not provide only a visual mock-up. Implement or specify the complete client-side and server-side lifecycle.

Do not weaken trading protections, bypass risk vetoes or treat a client-side disconnect as sufficient security.
