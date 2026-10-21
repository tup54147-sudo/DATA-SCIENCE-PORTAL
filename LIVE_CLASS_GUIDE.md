# Live Classroom Guide

## Create an internal class
1. Log in through `/admin-login.html` and open **Live Classes**.
2. Choose **Internal Zoom-style Classroom**, fill in course code, topic, audience, start/end time, capacity and attendance threshold, then save.
3. Select **Join as Admin**. The staff member who created the class is the **Host**; other staff are **Co-hosts**.
4. In the lobby check your camera/microphone, join, then press **Start class** (top bar) to let students in.

## What the host / co-host sees
- **Speaker view (default)**: the main screen shows whoever is speaking. Everyone else sits in a small strip, so attendance is *not* on screen.
- **Pin (for me)**: pin anyone on your own screen. Double-click a tile or use its ⋯ menu. **Unpin** from the badge or the menu.
- **Spotlight for everyone**: ⋯ menu on a tile or in the Participants list. Everyone sees that person as the main video until you choose **Remove spotlight**. Spotlight overrides each person's own pin.
- **Gallery view**: paged grid (25 per page on desktop, 6 on phones). Use the View button.
- **Student actions (⋯ menu)**: Mute, Ask to unmute, Stop video, Lower hand, Stop screen share, Remove from class.
- **Host tools** (toolbar): lock room, allow students to unmute / start video / share screen, mute all, lower all hands, remove spotlight.
- **Leave** gives two choices: *Leave class* (class keeps running) or *End class for everyone*.

## Screen sharing
- Hosts and co-hosts can share any time the class is live. Students can share only after the host switches on **Share their screen**.
- Only one person shares at a time. A host can take over from, or stop, a student's share.
- Everyone sees the shared screen as the main view; the presenter's camera stays in the strip. Use the fit/fill button to zoom.
- Screen sharing needs a desktop browser (phones and tablets cannot share their screen from a web page).

## Attendance (only when you ask)
Press **Attendance** in the toolbar (or More on phones). A drawer opens with:
- **Active now** – live list of who is connected, with mic/camera/hand state.
- **Attendance report** – Present / Partial / Absent / Late, searchable, with **Export CSV**.

Close it with ✕, the Esc key, or by clicking outside. It never opens by itself.

## Student experience
Pre-join lobby with camera/microphone preview and device choice, then speaker view. Students can raise a hand, react, chat, and (if allowed) share their screen. On phones the toolbar shows Mute, Video, Participants, Chat and **More**.

## Keyboard shortcuts
`Alt+A` mute/unmute · `Alt+V` video on/off · `Alt+S` share screen · `Alt+H` raise hand · `Esc` close menus/panels.

## How video is sent (important for class size)
This portal uses browser-to-browser WebRTC. To keep it light, a camera is only uploaded to people who are currently looking at it (speaker, pinned, spotlight, visible tiles). Audio from muted people costs almost nothing.
- Works well for roughly **10–15 people**, fewer if many students are on mobile data.
- For bigger classes, put a media server (SFU) such as LiveKit, mediasoup or Jitsi behind the same UI.

## Deployment checklist
- Use **HTTPS** (browsers block camera, microphone and screen share on plain http, except localhost).
- Enable **WebSocket** proxying.
- Set a strong `SESSION_SECRET` and change the seed passwords.
- Add a **TURN server** in `.env` (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`). Without it, students on some campus or mobile networks will not connect.
