# DATA-SCIENCE-PORTAL

![Node.js](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=node.js&logoColor=white)

A full-stack university data science portal with a public department website, student and staff dashboards, protected admin tools, and a Zoom-style live classroom experience built on Socket.IO and WebRTC.

## Overview

This project combines:

- a public-facing academic website
- staff/admin management workflows
- student registration and authentication
- portal announcements and learning materials
- a live classroom mode for internal sessions or external meeting links
- attendance tracking and reporting for classroom activity

## Core features

- Internal browser-based classroom with host, co-host, student, and moderation controls
- External meeting support for Zoom, Google Meet, Microsoft Teams, and other https links
- Protected web routes for staff and student access
- SQLite-backed data storage for portals, sessions, attendance, and uploads
- Student material uploads and resource links
- Attendance reports and per-session tracking

## Tech stack

- Node.js
- Express
- Socket.IO
- SQLite
- HTML/CSS/JavaScript frontend

## Requirements

- Node.js 22.5 or newer
- npm
- A modern browser like Chrome, Edge, Firefox, or Opera

## Local setup

```bash
npm install
```

Copy the example environment file and configure a secure session secret:

```bash
copy .env.example .env
```

Then start the app:

```bash
npm start
```

Open the portal at:

```text
http://localhost:3000
```

## Important default accounts

These accounts are present in the provided database for testing and setup:

| Staff | Login code | Password |
|---|---|---|
| Dr. Uduak D. George (HOD) | `DS-ADM-001-XN29` | `HODDataSci01!` |
| Dr. Samuel S. Udoh | `DS-ADM-002-KP57` | `UdohDataSci02!` |
| Prof. Udoinyang G. Inyang | `DS-ADM-003-HM84` | `InyangDataSci03!` |
| Mr. Emmanuel Ambrose Dan | `DS-ADM-004-ZQ62` | `DanDataSci04!` |

Change default credentials before production use.

## Project notes

- Database: `data/portal.db`
- Uploads: `uploads/`
- Approved registration numbers: `db/allowed_students.csv`

See `LIVE_CLASS_GUIDE.md` for live classroom instructions and usage notes.
