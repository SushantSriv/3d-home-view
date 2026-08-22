# Project Brief: 360° Home Tour Web App

Paste this whole document into Claude Code as your starting prompt.

## What I'm building

A free web app where a property seller or real estate broker (megler) can:
1. Record one short video per room (slow phone pan around the room)
2. Upload the video(s) plus a floor plan image
3. Click a point on the floor plan for each room, label it (e.g. "Kitchen"), and optionally add its size in m²
4. The app automatically extracts frames from each video and stitches them into a 360° panorama per room
5. The buyer/viewer gets a single interactive tool: click a room on the floor plan → jump into that room's 360° view → click a hotspot/pin → jump to the next room
6. Once the full tour is built (all rooms linked), the app generates a unique shareable URL for that property. Anyone with the link can open it in a browser and view/navigate the full tour remotely — no login or app install needed. This link is what gets shared with buyers, or placed in a finn.no listing description / broker profile.

This is NOT one continuous 3D scan (like Matterport). It's multiple linked 360° panoramas, one per room, navigated via a floor plan. Must be free to build and run — no paid APIs.

## Tech stack (all free tiers / open source)

- **Frontend**: Plain HTML/CSS/JS to start (or React if easier to scaffold), no paid frameworks
- **360° viewer**: Pannellum (MIT license) — https://pannellum.org
- **Panorama stitching**: Base this on Kronbii/360-spherical-stitching (MIT license) — https://github.com/Kronbii/360-spherical-stitching — takes a video, extracts frames, stitches an equirectangular panorama, generates a Three.js viewer. Adapt/wrap it rather than rebuild from scratch.
- **Backend**: Python (for the stitching pipeline) + a lightweight API layer (FastAPI or Node/Express) to handle uploads and serve data
- **Storage + DB**: Supabase (free tier) — stores uploaded videos, generated panoramas, floor plan images, room labels, dimensions, and pin coordinates
- **Hosting**: Vercel or Netlify (free tier) for the frontend; backend/stitching job can run as a serverless function or a small free-tier server (evaluate what fits Supabase Edge Functions vs a separate free host)
- **Domain**: Not free, but cheap (~$10–15/year) — not needed for local dev

## Core data model (rough)

- `properties`: id, name/address, floor_plan_image_url, share_slug (unique, used to build the public tour URL, e.g. yourapp.com/tour/abc123), created_at
- `rooms`: id, property_id, label (e.g. "Kitchen"), dimensions_m2 (nullable), pin_x, pin_y (coordinates on the floor plan image), panorama_url
- `room_videos`: id, room_id, raw_video_url, processing_status

## Build milestones (in order)

**Milestone 1 — Stitching pipeline proof of concept**
- Get Kronbii/360-spherical-stitching running locally
- Feed it a test phone video, confirm it outputs a usable equirectangular panorama
- Note any tuning needed (frame extraction rate, minimum video length/overlap)

**Milestone 2 — Basic 360° viewer**
- Take one stitched panorama, load it into Pannellum, confirm it's navigable in a browser

**Milestone 3 — Upload flow**
- Simple page: upload a video for "Room 1"
- Backend triggers the stitching pipeline, stores the result in Supabase, returns a panorama URL

**Milestone 4 — Floor plan + pins**
- Upload a floor plan image
- Click-to-place a pin on the image, enter a room label and optional size
- Store pin coordinates + linked panorama in Supabase

**Milestone 5 — Connected viewer**
- Single page: floor plan on one side (or as an overlay), clicking a pin opens that room's Pannellum panorama
- Room label (and dimensions, if provided) shown as a tag/overlay inside the 360° view

**Milestone 6 — Shareable link + polish**
- Handle multiple rooms end-to-end for one property
- Once all rooms for a property are linked, generate a unique public URL (e.g. yourapp.com/tour/abc123) that opens the full tour — viewable by anyone with the link, no login required
- This is the link meant to be shared with buyers or placed in a finn.no listing/broker profile
- Basic error handling (e.g. video too short/no overlap → ask user to re-record)

**Milestone 7 — Deploy**
- Deploy frontend to Vercel/Netlify, backend + Supabase wired up, confirm it works on a real phone-recorded video end to end

## Constraints to keep in mind throughout

- Everything must run on free tiers — flag if any step would require a paid API or paid compute
- Code should be structured as a private/closed-source app, even though it's built on MIT-licensed open source components (keep the MIT attribution for Pannellum and the stitching library somewhere in the repo)
- This is a weekend/pet project — prioritize getting a working end-to-end flow over polish at each milestone

## First task

Start with Milestone 1. Set up the project structure, pull in the Kronbii/360-spherical-stitching code as a base, and get it running locally on a sample video so we can evaluate output quality before building anything else on top of it.
