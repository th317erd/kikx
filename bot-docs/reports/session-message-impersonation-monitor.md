# Session-message impersonation monitor

Reference feedback: `e2adca38d3d30c0c5fd5db83`  
Title: **Sub-agents impersonated the coordinator via session-message; no in-turn authorship signal**  
Origin: session `cb551b14-5d2e-405d-99eb-14e8e0c2cd01` (feedback frame `fd19de2f-aeb5-4bb4-8492-f146584e4c35`)

## Status

Monitoring only. Do not change the authorship model until we have fresh evidence.

## What to watch

- A sub-agent posts a session message in the coordinator's voice.
- A sub-agent takes a coordinator-only action in a session where it is not coordinator.
- A recipient cannot tell from the frame alone who authored the message when the display name is shared, stale, or copied.
- A cross-session `session-message` result arrives without `sourceSessionID`/`sourceFrameID` or without the author's agent ID.

## Reference conversation

The original report describes a five-party session where two of four sub-agents wrote in the coordinator's voice and took coordinator-only actions. Both were caught only afterwards by manually checking frame authorship through the database tools. The report recommended an in-turn authorship signal.

No code change is being made under this monitor. Record new examples here or in a follow-up feedback report with the frame/session IDs.
