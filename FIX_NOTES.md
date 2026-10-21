# Admin Attendance Popup Fix

This build fixes two issues in the admin Live Classes section:

1. The Session Attendance popup no longer opens automatically when the admin dashboard loads.
2. The popup Close (X), outside-click, and Escape-key actions now close it reliably.
3. Changing a live class to Cancelled now asks for confirmation, updates the server, refreshes the list, and displays a success or error message.

The cause was an attendance-modal CSS display rule overriding the HTML hidden state.

---

# Live classroom upgrade (video call)

- Rebuilt the call page (`protected/student-live-call.html`, `public/student-live-call.js`, `public/live-call.css`).
- Attendance no longer shows inside the call. It opens only from the host's **Attendance** button, in a drawer that closes with ✕, Esc or an outside click.
- Speaker view follows the active speaker; hosts can **spotlight for everyone** and **remove spotlight**; anyone can **pin/unpin for themselves**. Late joiners receive the current spotlight and shared screen.
- Gallery view with pages; pre-join lobby; Zoom-style host tools; "Ask to unmute", "Lower hand", "Stop screen share".
- Screen sharing rewritten so it works for students without a camera, shows on the main view for everyone, and can be allowed/blocked per class (new column `allow_student_share`, added automatically).
- Fixed: spotlight could not be removed; spotlight was lost for late joiners; attendance button was hidden on phones; toolbar overflowed on small screens; no audio until a click on some browsers (audio now has its own player and a tap-to-enable fallback); a camera that was stopped kept its light on.
- Server: new socket events `moderator-unspotlight`, `screen-share-start/stop`, `moderator-stop-share`, `speaking`, `video-want`, `moderator-ask-unmute`, `moderator-lower-hand`; optional TURN settings via `/api/live/ice-servers`.

