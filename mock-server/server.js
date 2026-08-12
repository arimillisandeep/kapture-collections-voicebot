require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const calls = new Map();
const customerData = require('./data/customer.json');
const customer = { ...customerData, verificationCodes: new Set(customerData.verificationCodes) };
const STATES = Object.freeze({ INIT: 'INIT', AUTH_PENDING: 'AUTH_PENDING', AUTHENTICATED: 'AUTHENTICATED', NEGOTIATION: 'NEGOTIATION', PTP_COLLECTED: 'PTP_COLLECTED', ESCALATED: 'ESCALATED', CALL_ENDED: 'CALL_ENDED' });

function mask(value) { const s = String(value || ''); return s.length < 4 ? '***' : `${s.slice(0, 2)}***${s.slice(-2)}`; }
function log(event, data = {}) { console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })); }
function callIdFrom(body, fallback) { return body?.message?.call?.id || body?.call?.id || body?.callId || fallback || 'demo-call'; }
function getCall(callId) {
  if (!calls.has(callId)) calls.set(callId, { state: STATES.INIT, verified: false, verificationAttempts: 0, dispositions: [], ptps: [] });
  return calls.get(callId);
}
function result(ok, data = {}, error = null) { return { ok, ...data, ...(error ? { error } : {}) }; }
function isString(value) { return typeof value === 'string' && value.trim().length > 0; }
function requireAuth(call) { return call.state === STATES.AUTHENTICATED || call.state === STATES.NEGOTIATION || call.state === STATES.PTP_COLLECTED; }
function safeAccount() { return { customerName: customer.name, accountId: customer.accountId, loan: customer.loan, overdueEmi: customer.overdueEmi, currency: 'INR', daysPastDue: customer.daysPastDue }; }
function validAccountId(value) { return value === customer.accountId; }
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function transition(call, nextState, callId, reason) {
  const previousState = call.state;
  call.state = nextState;
  if (previousState !== nextState) log('state_transition', { callId: mask(callId), previousState, nextState, reason });
}

const handlers = {
  get_account_details(args, call) {
    if (call.state === STATES.INIT) transition(call, STATES.AUTH_PENDING, args._callId, 'account_details_before_auth');
    if (!requireAuth(call)) return result(true, { state: call.state, verified: false, message: 'Identity verification is required before account details can be disclosed.' });
    if (!validAccountId(args.account_id)) return result(false, { state: call.state }, 'Invalid account_id.');
    if (call.state === STATES.AUTHENTICATED) transition(call, STATES.NEGOTIATION, args._callId, 'account_details_retrieved');
    return result(true, { state: call.state, verified: true, account: safeAccount() });
  },
  verify_customer(args, call) {
    const code = String(args.verification_code || '').trim();
    if (!validAccountId(args.account_id) || !code) return result(false, { verified: false, state: call.state }, 'Valid account_id and verification_code are required.');
    if (call.verificationAttempts >= 2) return result(true, { verified: false, state: STATES.AUTH_PENDING, retryAllowed: false, message: 'Verification retry limit reached. End the call safely.' });
    transition(call, STATES.AUTH_PENDING, args._callId, 'verification_requested');
    call.verificationAttempts += 1;
    const verified = customer.verificationCodes.has(code);
    if (!verified) { log('verification_failed', { attempt: call.verificationAttempts, code: mask(code) }); return result(true, { verified: false, state: STATES.AUTH_PENDING, retryAllowed: call.verificationAttempts < 2, message: 'Verification failed. Do not disclose account information.' }); }
    call.verified = true;
    transition(call, STATES.AUTHENTICATED, args._callId, 'verification_succeeded'); // Only successful verification can set this state.
    log('verification_succeeded', { customer: mask(customer.name) });
    return result(true, { verified: true, customer_name: customer.name, state: STATES.AUTHENTICATED });
  },
  log_promise_to_pay(args, call) {
    if (!requireAuth(call)) return result(false, { state: call.state }, 'Authentication is required before recording a payment promise.');
    if (!validAccountId(args.account_id)) return result(false, { state: call.state }, 'Invalid account_id.');
    const amount = args.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !isValidDate(args.ptp_date)) return result(false, {}, 'amount must be a positive number and ptp_date must be a real YYYY-MM-DD date.');
    const ptp = { id: `PTP-${crypto.randomUUID().slice(0, 8)}`, amount, ptp_date: args.ptp_date };
    call.ptps.push(ptp); transition(call, STATES.PTP_COLLECTED, args._callId, 'ptp_logged');
    log('ptp_logged', { amount, ptpDate: ptp.ptp_date });
    return result(true, { state: call.state, promiseToPay: ptp });
  },
  send_payment_link(args, call) {
    if (!requireAuth(call)) return result(false, { state: call.state }, 'Authentication is required before sending a payment link.');
    if (!validAccountId(args.account_id)) return result(false, { state: call.state }, 'Invalid account_id.');
    const channel = args.channel;
    if (!['SMS', 'WhatsApp', 'BOTH'].includes(channel)) return result(false, {}, 'channel must be SMS, WhatsApp, or BOTH.');
    const linkId = `PAY-${crypto.randomUUID().slice(0, 8)}`;
    log('payment_link_sent', { channel, linkId });
    return result(true, {
      paymentLinkId: linkId,
      paymentUrl: `https://pay.kapture-finance.mock/${linkId}`,
      channel,
      status: 'queued',
      message: `Mock payment link queued by ${channel}.`
    });
  },
  escalate_to_agent(args, call) {
    const reason = args.reason;
    if (!validAccountId(args.account_id) || !['HARDSHIP_REQUEST', 'DISPUTE', 'COMPLEX_CASE', 'CUSTOMER_REQUEST'].includes(reason)) return result(false, {}, 'Valid account_id and allowed reason are required.');
    transition(call, STATES.ESCALATED, args._callId, 'agent_escalation');
    log('escalated', { reasonLength: reason.trim().length });
    return result(true, { state: call.state, escalationId: `ESC-${crypto.randomUUID().slice(0, 8)}`, status: 'queued' });
  },
  mark_disposition(args, call) {
    const allowed = ['PTP_AGREED', 'ALREADY_PAID', 'DISPUTED', 'HARDSHIP_ESCALATED', 'WRONG_PERSON', 'DO_NOT_CALL', 'NO_RESPONSE', 'CALLBACK_REQUEST', 'HOSTILE', 'AUTH_FAILED', 'ESCALATED', 'OTHER'];
    if (call.state === STATES.CALL_ENDED) return result(true, { state: STATES.CALL_ENDED, disposition: call.dispositions.at(-1)?.disposition, message: 'Call already has a final disposition.' });
    if (!validAccountId(args.account_id)) return result(false, { state: call.state }, 'Invalid account_id.');
    if (!allowed.includes(args.status)) return result(false, {}, `status must be one of: ${allowed.join(', ')}.`);
    const entry = { disposition: args.status, notes: String(args.notes || '').slice(0, 300), at: new Date().toISOString() };
    call.dispositions.push(entry); transition(call, STATES.CALL_ENDED, args._callId, 'final_disposition');
    log('disposition_marked', { disposition: entry.disposition });
    return result(true, { state: call.state, disposition: entry.disposition });
  }
};

function toolName(toolCall) { return toolCall.function?.name || toolCall.name; }
function parseArgs(toolCall) {
  try {
    const raw = toolCall.function?.arguments ?? toolCall.parameters ?? toolCall.arguments ?? {};
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch { return null; }
}
app.post('/webhook', (req, res) => {
  const startedAt = Date.now();
  const message = req.body?.message || {};
  const toolCalls = message.toolCallList || message.toolCalls || req.body?.toolCalls || (message.toolCall ? [message.toolCall] : []);
  if (!Array.isArray(toolCalls) || !toolCalls.length) return res.status(200).json({ results: [], error: 'No Vapi tool calls found.' });
  const callId = callIdFrom(req.body);
  const call = getCall(callId);
  const results = toolCalls.map((toolCall) => {
    const name = toolName(toolCall);
    const parsedArgs = parseArgs(toolCall);
    const args = parsedArgs && typeof parsedArgs === 'object' ? { ...parsedArgs, _callId: callId } : parsedArgs;
    let payload;
    if (!args) payload = result(false, {}, 'Tool arguments must be valid JSON.');
    else if (!handlers[name]) payload = result(false, {}, `Unsupported tool: ${name}`);
    else if (call.state === STATES.CALL_ENDED && name !== 'mark_disposition') payload = result(false, { state: STATES.CALL_ENDED }, 'Call has already ended; no further action is allowed.');
    else if (process.env.SIMULATE_TOOL_FAILURE === 'true' && name !== 'mark_disposition') payload = result(false, {}, 'Simulated downstream tool failure.');
    else { try { payload = handlers[name](args, call); } catch (err) { log('tool_error', { name, error: err.message }); payload = result(false, {}, 'Internal mock tool error.'); } }
    log('tool_called', { callId: mask(callId), name, callState: call.state, ok: payload.ok, latencyMs: Date.now() - startedAt });
    return { name, toolCallId: toolCall.id || toolCall.toolCallId || crypto.randomUUID(), result: JSON.stringify(payload) };
  });
  log('webhook_completed', { callId: mask(callId), toolCount: results.length, latencyMs: Date.now() - startedAt });
  res.json({ results });
});
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'kapture-vapi-mock-server' }));
app.get('/', (_req, res) => res.sendFile(`${__dirname}/public/index.html`));
if (require.main === module) {
  app.listen(PORT, () => log('server_started', { port: PORT }));
}
module.exports = { app, handlers, STATES };
