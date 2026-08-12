const test = require('node:test');
const assert = require('node:assert/strict');
const { app, STATES } = require('../server');
const ACCOUNT_ID = 'ACC-88392';

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise((resolve) => server.close(resolve)));

async function tool(callId, name, args) {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: callId }, toolCallList: [{ id: `${callId}-${name}`, name, parameters: args }] } })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return JSON.parse(body.results[0].result);
}

test('health endpoint is available', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'kapture-vapi-mock-server' });
});

test('root endpoint documents the deployed webhook service', async () => {
  const response = await fetch(`${baseUrl}/`);
  const body = await response.json();
  assert.equal(body.status, 'online');
  assert.equal(body.vapiWebhook, '/webhook');
});

test('non-tool Vapi messages receive a safe HTTP 200 acknowledgement', async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { type: 'status-update', call: { id: 'status-message' } } })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [], error: 'No Vapi tool calls found.' });
});

test('authentication gate withholds debt data before verification', async () => {
  const response = await tool('guard', 'get_account_details', { account_id: ACCOUNT_ID });
  assert.equal(response.verified, false);
  assert.equal(response.state, STATES.AUTH_PENDING);
  assert.equal(Object.hasOwn(response, 'account'), false);
  assert.equal(JSON.stringify(response).includes('8499'), false);
});

test('invalid verification never authenticates', async () => {
  const response = await tool('invalid-code', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '0000' });
  assert.equal(response.verified, false);
  assert.equal(response.state, STATES.AUTH_PENDING);
  const payment = await tool('invalid-code', 'send_payment_link', { account_id: ACCOUNT_ID, channel: 'SMS' });
  assert.equal(payment.ok, false);
});

test('verification retry limit cannot be bypassed by a later valid code', async () => {
  await tool('retry-limit', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '0000' });
  const second = await tool('retry-limit', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '1111' });
  assert.equal(second.retryAllowed, false);
  const third = await tool('retry-limit', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '1234' });
  assert.equal(third.verified, false);
  assert.equal(third.retryAllowed, false);
});

test('successful verification permits account data, PTP, and payment link', async () => {
  const verified = await tool('ptp', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '1234' });
  assert.equal(verified.verified, true);
  assert.equal(verified.state, STATES.AUTHENTICATED);
  const account = await tool('ptp', 'get_account_details', { account_id: ACCOUNT_ID });
  assert.equal(account.account.overdueEmi, 8499);
  assert.equal(account.state, STATES.NEGOTIATION);
  const ptp = await tool('ptp', 'log_promise_to_pay', { account_id: ACCOUNT_ID, amount: 8499, ptp_date: '2026-08-20' });
  assert.equal(ptp.state, STATES.PTP_COLLECTED);
  assert.deepEqual({ amount: ptp.promiseToPay.amount, ptpDate: ptp.promiseToPay.ptp_date }, { amount: 8499, ptpDate: '2026-08-20' });
  const link = await tool('ptp', 'send_payment_link', { account_id: ACCOUNT_ID, channel: 'SMS' });
  assert.equal(link.status, 'queued');
  assert.equal(link.channel, 'SMS');
  assert.match(link.paymentUrl, /^https:\/\/pay\.kapture-finance\.mock\/PAY-/);
});

test('PTP rejects impossible dates and invalid amounts', async () => {
  await tool('bad-ptp', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '1995' });
  const impossibleDate = await tool('bad-ptp', 'log_promise_to_pay', { account_id: ACCOUNT_ID, amount: 100, ptp_date: '2026-02-30' });
  assert.equal(impossibleDate.ok, false);
  const invalidAmount = await tool('bad-ptp', 'log_promise_to_pay', { account_id: ACCOUNT_ID, amount: 0, ptp_date: '2026-08-20' });
  assert.equal(invalidAmount.ok, false);
});

test('DNC ends the call and prevents later account disclosure', async () => {
  const dnc = await tool('dnc', 'mark_disposition', { account_id: ACCOUNT_ID, status: 'DO_NOT_CALL', notes: 'Caller requested no further calls.' });
  assert.equal(dnc.state, STATES.CALL_ENDED);
  const afterEnd = await tool('dnc', 'get_account_details', { account_id: ACCOUNT_ID });
  assert.equal(afterEnd.ok, false);
  assert.equal(JSON.stringify(afterEnd).includes('8499'), false);
});

test('already-paid has the correct final disposition', async () => {
  const outcome = await tool('paid', 'mark_disposition', { account_id: ACCOUNT_ID, status: 'ALREADY_PAID' });
  assert.equal(outcome.disposition, 'ALREADY_PAID');
  assert.equal(outcome.state, STATES.CALL_ENDED);
});

test('tool failures are returned safely while disposition remains available', async () => {
  const previous = process.env.SIMULATE_TOOL_FAILURE;
  process.env.SIMULATE_TOOL_FAILURE = 'true';
  const failure = await tool('failure', 'verify_customer', { account_id: ACCOUNT_ID, verification_code: '1234' });
  assert.equal(failure.ok, false);
  const disposition = await tool('failure', 'mark_disposition', { account_id: ACCOUNT_ID, status: 'OTHER', notes: 'Tool failure.' });
  assert.equal(disposition.ok, true);
  if (previous === undefined) delete process.env.SIMULATE_TOOL_FAILURE;
  else process.env.SIMULATE_TOOL_FAILURE = previous;
});

test('batch Vapi tool calls preserve names and tool-call IDs', async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls', call: { id: 'batch' },
        toolCallList: [
          { id: 'batch-verify', name: 'verify_customer', parameters: { account_id: ACCOUNT_ID, verification_code: '1234' } },
          { id: 'batch-account', name: 'get_account_details', parameters: { account_id: ACCOUNT_ID } }
        ]
      }
    })
  });
  const body = await response.json();
  assert.deepEqual(body.results.map((item) => [item.name, item.toolCallId]), [
    ['verify_customer', 'batch-verify'],
    ['get_account_details', 'batch-account']
  ]);
  assert.equal(JSON.parse(body.results[1].result).account.overdueEmi, 8499);
});

test('dispute escalation and unknown tools return predictable Vapi results', async () => {
  const escalation = await tool('dispute', 'escalate_to_agent', { account_id: ACCOUNT_ID, reason: 'DISPUTE' });
  assert.equal(escalation.state, STATES.ESCALATED);
  const unknown = await tool('unknown', 'not_a_real_tool', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unsupported tool/);
});

test('malformed tool arguments return a Vapi-formatted safe error', async () => {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'malformed' }, toolCallList: [{ id: 'malformed-1', function: { name: 'verify_customer', arguments: '{' } }] } })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].toolCallId, 'malformed-1');
  assert.equal(JSON.parse(body.results[0].result).ok, false);
});
