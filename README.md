# Mary Voice Bridge

Realtime WebSocket transport for **Mary**, Hampshire Waste Clearance's AI receptionist.

## Purpose

This service is the thin transport layer between Twilio ConversationRelay and Mary's existing Floot business brain. Floot remains the source of truth for conversation rules, customer/call memory, enquiry persistence, SMS follow-up and the dashboard.

The bridge:
- accepts Twilio's persistent WebSocket connection at `/conversation-relay`;
- validates the initial `X-Twilio-Signature`;
- forwards completed caller prompts to Floot's authenticated `/_api/twilio/bridge-turn` endpoint;
- sends Mary's reply back to ConversationRelay in short text chunks;
- cancels an in-flight turn when the caller interrupts;
- exposes `/health` for Render health checks.

## Required environment variables

- `FLOOT_BASE_URL` — published Mary app origin.
- `MARY_BRIDGE_SECRET` — shared secret matching the Floot project.
- `TWILIO_AUTH_TOKEN` — used to verify Twilio's WebSocket upgrade signature.
- `PUBLIC_WSS_URL` — informational deployed `wss://.../conversation-relay` URL.

Do not commit credentials to this repository.

## Deployment

`render.yaml` targets a Render web service in Frankfurt. Keep Mary's existing Twilio `<Gather>` flow live until this bridge is deployed, configured and proven by test calls. The live telephone webhook should only move to ConversationRelay after rollback/fallback testing passes.
