# Kapture Finance - Maya Collections Voicebot

Maya is a working Vapi outbound collections demo with an Express tool webhook. The backend, not the LLM prompt, is the authority for authentication: it withholds account/debt data and blocks payment actions until `verify_customer(account_id, verification_code)` returns `verified: true` for that Vapi call.

## Project map

- `mock-server/server.js` - Express webhook and authoritative call-state machine.
- `mock-server/data/customer.json` - mock Rahul Sharma account and test verification codes.
- `vapi/system_prompt.txt` - constrained production-style Maya prompt.
- `vapi/tool_definitions.json` - six Vapi function definitions.
- `mock-server/test/server.test.js` - automated webhook tests using Vapi's `toolCallList` request shape.
- `docs/` - architecture and HLD.

## AUTOMATED/LOCAL WORK COMPLETED

The Express webhook, `/health`, server-enforced authentication state machine, six Vapi tools, mock datastore, architecture/HLD, acceptance cases, and automated backend tests are included and runnable locally.

## Run locally

Requirements: Node.js 18+ and ngrok. In Windows PowerShell environments that block `npm.ps1`, use `npm.cmd` as below.

```powershell
cd "C:\Users\Arimilli sandeep\Documents\ChatGPT\kapture-collections-voicebot\mock-server"
Copy-Item .env.example .env
npm.cmd install
npm.cmd test
npm.cmd start
```

In another terminal:

```powershell
ngrok http 3000
```

## Deploy on Render

This repository includes `render.yaml` for a Node web service. In Render, select **New + → Blueprint**, connect the GitHub repository, and select this repository. Render uses `mock-server` as the root directory, runs `npm ci`, then `npm start`, and checks `/health`. After deployment, use `https://YOUR-RENDER-SERVICE.onrender.com/webhook` as the Vapi Server URL.

Confirm it locally with:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Use `Rahul Sharma` with mock code `1234` or `1995`. To demonstrate a safe downstream error, set `SIMULATE_TOOL_FAILURE=true` in `mock-server/.env`, restart the server, and make a test call.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Local Express listening port. |
| `LOG_LEVEL` | `info` | Reserved log-level setting for the demo. |
| `SIMULATE_TOOL_FAILURE` | `false` | Set to `true` to make non-disposition tools return a safe mock failure. |

## MANUAL VAPI STEPS REQUIRED

## Exact Vapi setup

1. Create a Vapi assistant and use model provider `openai`, model `gpt-4o-mini` (low latency and sufficient tool-calling quality).
   Set temperature to `0.1` for predictable compliance behavior.
2. Choose transcriber provider `deepgram`, model `nova-2` (fast conversational transcription).
3. Choose a Cartesia or ElevenLabs English-India voice available in your Vapi account (natural local delivery).
4. Set the first message exactly to: `Hello, this is Maya calling from Kapture Finance. Am I speaking with Rahul Sharma?`
5. Paste the complete contents of `vapi/system_prompt.txt` into the assistant's system prompt/instructions field.
6. Add six server-side function tools in the assistant model configuration. Paste the six objects from `vapi/tool_definitions.json` into the `model.functions` array (not as client-side tools).
7. Set the assistant Server URL to `https://YOUR_NGROK_SUBDOMAIN.ngrok-free.app/webhook`. Alternatively, set this URL on every tool's `server.url`; a tool server URL has precedence for tool calls.
8. Save the assistant and make a Vapi test call. Vapi sends `message.type: "tool-calls"` with `message.toolCallList`; this backend returns the required `results[{name, toolCallId, result}]` response.
9. Schedule outbound calls only between 08:00 and 19:00 in the customer's local time. The repository cannot configure your Vapi account; these dashboard changes are manual.

## Test plan

Run `npm.cmd test` from `mock-server`. It verifies health, pre-auth debt withholding, invalid verification, successful authentication, valid PTP, payment-link queueing, invalid PTP rejection, DNC termination, already-paid disposition, and simulated tool failure. Conversation-level acceptance scenarios, including Hindi/Hinglish, voicemail, dispute, callback, and hostile callers, are in `tests/test_cases.json`.

## Demo conversation

Maya: "Hello, this is Maya calling from Kapture Finance. Am I speaking with Rahul Sharma?"

Caller: "Speaking."

Maya: "For security purposes, could you please confirm the last 4 digits of your PAN or your year of birth?"

Caller: "1234."

Only once `verify_customer` reports `verified:true` may Maya call `get_account_details`. Then say: "I can help with the Kapture Finance account. The overdue EMI is INR 8,499 for the personal loan. Can you make a payment today or commit to a date?"

Caller: "I will pay INR 8,499 on 2026-08-20. Send an SMS link."

Maya confirms the amount/date, calls `log_promise_to_pay` with `account_id`, `ptp_date`, and `amount`, calls `send_payment_link` with `SMS` (which returns a clearly mock `https://pay.kapture-finance.mock/...` URL), calls `mark_disposition` with `PTP_AGREED`, and closes. For the contrast demo, start a new call and say "Do not call me again" before identity confirmation; Maya must immediately call `mark_disposition` with `DO_NOT_CALL`, without disclosure.

## Debugging notes

Use `GET /health` to verify the local process, inspect the structured console logs for the tool name/state/outcome, and use the Vapi call log to compare the incoming `toolCallId` with the returned result. The webhook intentionally returns HTTP 200 with a structured error result for malformed or unsupported tool calls so Vapi can process the failure safely.

## Design choices and limitations

The mock call store is in memory and resets on restart; customer data is local JSON. Structured logs mask names and verification codes. The demo intentionally lacks CRM/payment integration, durable audit storage, consent/time-zone lookup, webhook signature verification, real payment links, and production monitoring.

## Future improvements

Use Redis/Postgres for durable state and DNC records; add signed Vapi webhook validation, idempotency keys, customer time-zone/consent checks, CRM and payment-provider integrations, dashboards for HLD metrics, and monitored human-agent escalation queues.

## Submit

Submit `README.md`, `docs/`, `vapi/`, `mock-server/` (including `package-lock.json` but excluding `node_modules` and `.env`), and `tests/`.
