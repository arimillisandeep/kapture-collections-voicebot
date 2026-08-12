# Kapture Finance Collections Voice AI - HLD

## 1. Objective and assumptions

Maya is an outbound collections voice agent for a mock Kapture Finance account. Node.js 18+, Express, Vapi, Deepgram Nova-2, GPT-4o-mini, and Cartesia/ElevenLabs are assumed. The datastore is in memory plus `customer.json`; `1234` and `1995` are valid mock verification codes.

## 2. Architecture and voice pipeline

Telephony routes the call through Vapi. Deepgram performs STT; GPT-4o-mini handles dialogue/tool selection; Express is the state manager and mock API; Cartesia or ElevenLabs generates TTS; Vapi returns audio to the customer. See `System_Architecture.md` for implementation-matching diagrams.

## 3. Latency budget

Target total round-trip is under 1.2 seconds: STT 200-350 ms, LLM/orchestrator 250-400 ms, first TTS audio 200-300 ms, network/tool overhead 100-200 ms. Tool failures return promptly as structured errors; Maya must not invent completion.

## 4. Conversation state machine and transition rules

States: `INIT -> AUTH_PENDING -> AUTHENTICATED -> NEGOTIATION -> PTP_COLLECTED -> CALL_ENDED`; `ESCALATED -> CALL_ENDED` is also valid. `verify_customer(account_id, verification_code)` is the only handler that can set `AUTHENTICATED`, and only when `verified === true`. Failed attempts remain `AUTH_PENDING`, with two attempts maximum. A final disposition transitions to `CALL_ENDED`; later non-disposition tools are blocked.

## 5. Intents and entities

Intents: identity confirmation, will pay, already paid, hardship, dispute, DNC, wrong person, callback, hostile caller, no input/voicemail, and English/Hindi/Hinglish. Entities: `account_id`, verification code, PTP date, PTP amount, hardship reason, payment reference, preferred channel, and callback time.

## 6. Tools and API schemas

All tools are defined in `vapi/tool_definitions.json`, revalidated in `server.js`, and return a JSON-stringified `{ok,...}` object in Vapi's `{results:[{name,toolCallId,result}]}` response. Every tool requires `account_id`.

| Tool | Required inputs | Safe behavior |
|---|---|---|
| `get_account_details` | `account_id` | Returns debt data only after authentication. |
| `verify_customer` | `account_id`, `verification_code` | Sets authenticated only for valid mock code. |
| `log_promise_to_pay` | `account_id`, `ptp_date`, `amount` | Validates real ISO date and positive number. |
| `send_payment_link` | `account_id`, `channel` | Allows SMS, WhatsApp, BOTH after authentication. |
| `escalate_to_agent` | `account_id`, `reason` | Allows HARDSHIP_REQUEST, DISPUTE, COMPLEX_CASE, CUSTOMER_REQUEST. |
| `mark_disposition` | `account_id`, `status`, `notes` | Records one final status and ends the call. |

## 7. Authentication, data safety, compliance, and guardrails

Before verified=true, backend responses cannot expose loan, EMI, overdue amount, debt, payment details, account ID, or days past due. PTP and payment-link actions are also rejected. This prevents prompt injection from bypassing authentication. Maya never discloses to a third party, calls only 08:00-19:00 local time, uses no threats/harassment, honors DNC immediately, invents no information/waivers, masks verification values and names in logs, and escalates disputes/hardship.

## 8. Edge cases, escalation, and dispositions

Wrong person -> WRONG_PERSON; DNC -> DO_NOT_CALL; already paid -> ALREADY_PAID; dispute -> escalation DISPUTE then DISPUTED; hardship -> HARDSHIP_REQUEST then HARDSHIP_ESCALATED; callback -> CUSTOMER_REQUEST then CALLBACK_REQUEST; repeated silence/voicemail -> NO_RESPONSE; sustained hostility -> HOSTILE; failed verification -> AUTH_FAILED. Every call receives exactly one final disposition.

## 9. Observability and failure handling

Structured logs include timestamp, call ID context through request state, state, tool name, tool outcome, authentication result, final disposition, and escalation; values such as codes/names are masked. Monitor containment rate, PTP rate, authentication success rate, average latency, tool failure rate, call drop rate, escalation rate, DNC rate, and first-call resolution. On malformed, unknown, or simulated-failed tools, return a safe result and let Maya apologize/escalate/disposition.

## 10. Testing strategy and future improvements

Node automated tests cover health, verification success/failure, pre-auth guardrail, PTP, payment link, DNC, dispute escalation, unknown tool, Vapi response format, and batch calls. Acceptance scenarios are in `tests/test_cases.json`. Production upgrades: durable Redis/Postgres state, signed Vapi webhooks, idempotency, persistent consent/DNC records, CRM/payment integration, timezone enforcement, and metrics dashboards.
