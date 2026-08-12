# System Architecture

```mermaid
flowchart LR
  Customer[Customer] <-- audio --> Telephony[Telephony / Vapi]
  Telephony --> STT[Deepgram Nova-2 STT]
  STT --> LLM[GPT-4o-mini Orchestrator]
  LLM --> TTS[Cartesia or ElevenLabs TTS]
  TTS --> Telephony
  LLM -->|POST /webhook message.toolCallList| API[Express Mock API]
  API <--> State[(State Manager\nper Vapi call ID)]
  API --> Data[customer.json]
  API --> Logs[Masked structured logs]
  API -->|results: name, toolCallId, JSON string| LLM
```

```mermaid
sequenceDiagram
  participant C as Customer
  participant V as Vapi / Maya
  participant A as Express API
  C->>V: “Yes, this is Rahul”
  V->>C: Request verification code (AUTH_PENDING)
  C->>V: “1234”
  V->>A: verify_customer(account_id, verification_code)
  A-->>V: verified:true, state:AUTHENTICATED
  V->>A: get_account_details(callId)
  A-->>V: Authenticated account data only
  V->>C: Discuss returned data / collect commitment
  V->>A: log_promise_to_pay + mark_disposition(PTP_AGREED)
  A-->>V: PTP_COLLECTED then CALL_ENDED
```

The Express layer, not prompt text, owns the authentication gate. It will not return debt data or allow payment actions until `verify_customer` succeeds for the same Vapi call ID. Any final disposition, including DNC, transitions the call to `CALL_ENDED` and blocks later tools.
