// Integration suite. Uses its own temporary database; never touches your network.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const dir = fs.mkdtempSync(path.join(__dirname, '.test-'));
fs.mkdirSync(path.join(__dirname, 'checks'), { recursive: true });
const port = 3197;
const base = `http://localhost:${port}`;
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, ADMIN_INITIAL_PASSWORD: '5121', PORT: String(port), DATA_FILE: path.join(dir, 'network.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browsers = [], sockets = [], count = 0;
child.stdout.on('data', b => log += b);
child.stderr.on('data', b => process.stderr.write(b));
function pass(s) { console.log('  ✓ ' + s); count++; }
async function request(route, { cookie, key, method = 'GET', body, expected = 200 } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (cookie) headers.Cookie = cookie; if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(base + '/api' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); assert.equal(r.status, expected, `${method} ${route}: ${JSON.stringify(data)}`); return { data, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function socket(cookie) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie, Origin: base } }); ws.inbox = []; ws.on('message', b => ws.inbox.push(JSON.parse(b))); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); sockets.push(ws); return ws;
}
function waitMessage(ws, predicate) { const existing = ws.inbox.find(predicate); if (existing) return Promise.resolve(existing); return new Promise((resolve, reject) => { const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('Timed out waiting for socket event')); }, 5000); function listener(b) { const d = JSON.parse(b); if (predicate(d)) { clearTimeout(timer); ws.off('message', listener); resolve(d); } } ws.on('message', listener); }); }
async function main() {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 15000); child.stdout.on('data', b => { if (String(b).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => reject(new Error('Server exited: ' + code))); });
  console.log('\nOrbit integration tests');
  const pool = (await request('/numbers')).data.numbers;
  assert.equal(new Set(pool.map(n => n.number)).size, pool.length); assert(pool.every(n => ['+12', '+67', '+30'].includes(n.prefix))); pass('Unique random numbers use only the three allowed prefixes');
  const admin = await request('/auth/login', { method: 'POST', body: { identity: 'Angelbrs12', password: '5121' } }); assert.equal(admin.data.user.role, 'admin'); pass('Requested admin account signs in');
  const alice = await request('/auth/register', { method: 'POST', expected: 201, body: { username: 'Alice', password: 'correct-horse-99', number: pool.find(n => n.prefix === '+12').number } });
  const bob = await request('/auth/register', { method: 'POST', expected: 201, body: { username: 'Bob', password: 'correct-horse-88', number: pool.find(n => n.prefix === '+67').number } }); pass('Users claim numbers and create password-protected accounts');
  await request('/auth/register', { method: 'POST', expected: 409, body: { username: 'AnotherAlice', password: 'secure-pass', number: alice.data.user.number } });
  await request('/auth/register', { method: 'POST', expected: 409, body: { username: 'BadPrefix', password: 'secure-pass', number: '+441234567' } }); pass('Duplicate and unsupported numbers are rejected');
  const otherDevice = await request('/auth/login', { method: 'POST', body: { identity: alice.data.user.number, password: 'correct-horse-99' } }); assert.equal(otherDevice.data.user.id, alice.data.user.id); pass('Number and password work on a second device');
  await request('/admin', { cookie: alice.cookie, expected: 403 }); pass('Members cannot access admin tools');
  const aWS = await socket(alice.cookie), bWS = await socket(bob.cookie), adminWS = await socket(admin.cookie);
  const msg = await request('/messages', { cookie: alice.cookie, method: 'POST', expected: 201, body: { to: bob.data.user.number, text: 'A real-time hello!' } });
  const event = await waitMessage(bWS, d => d.type === 'message' && d.message.id === msg.data.message.id); assert.equal(event.message.text, 'A real-time hello!'); assert(!adminWS.inbox.some(d => d.type === 'message')); pass('Messages arrive over WebSocket only to the participants');
  const contact = await request('/contacts', { cookie: alice.cookie, method: 'POST', expected: 201, body: { number: bob.data.user.number, name: 'Best friend' } }); assert.equal(contact.data.contact.name, 'Best friend');
  const restored = await request('/bootstrap', { cookie: otherDevice.cookie }); assert(restored.data.messages.some(m => m.id === msg.data.message.id)); assert.equal(restored.data.contacts.length, 1); pass('Contacts and conversations persist across sessions');
  const writeKey = await request('/keys', { cookie: alice.cookie, method: 'POST', expected: 201, body: { name: 'Integration', scopes: ['messages:write', 'calls:write'] } });
  await request('/messages', { key: writeKey.data.token, expected: 403 });
  await request('/messages', { key: writeKey.data.token, method: 'POST', expected: 201, body: { to: bob.data.user.number, text: 'Hello from the API.' } });
  await request('/admin', { key: writeKey.data.token, expected: 403 }); pass('Bearer keys send messages and enforce scopes');
  const call = await request('/calls', { key: writeKey.data.token, method: 'POST', expected: 201, body: { to: bob.data.user.number, kind: 'video' } });
  await waitMessage(bWS, d => d.type === 'call:incoming');
  await request(`/calls/${call.data.call.id}/accept`, { cookie: bob.cookie, method: 'POST', body: {} });
  aWS.send(JSON.stringify({ type: 'signal', callId: call.data.call.id, signal: { type: 'offer', sdp: { type: 'offer', sdp: 'test-offer' } } }));
  const sig = await waitMessage(bWS, d => d.type === 'signal'); assert.equal(sig.signal.sdp.sdp, 'test-offer');
  await request(`/calls/${call.data.call.id}/end`, { key: writeKey.data.token, method: 'POST', body: {} }); pass('API call invitations, acceptance, signaling, and hangup work');
  await request('/keys/' + writeKey.data.key.id, { cookie: alice.cookie, method: 'DELETE' });
  await request('/me', { key: writeKey.data.token, expected: 401 }); pass('Revoked keys stop working immediately');
  const newNumbers = await request('/admin/numbers', { cookie: admin.cookie, method: 'POST', expected: 201, body: { prefix: '+30', count: 2 } });
  const assigned = newNumbers.data.numbers[0]; await request('/admin/users/' + bob.data.user.id, { cookie: admin.cookie, method: 'PATCH', body: { number: assigned.number } });
  assert.equal((await request('/me', { cookie: bob.cookie })).data.user.number, assigned.number);
  await request('/admin/numbers/' + assigned.id, { cookie: admin.cookie, method: 'DELETE', expected: 409 }); pass('Admin generates and reassigns numbers; assigned numbers are protected');
  await request('/admin/users/' + bob.data.user.id, { cookie: admin.cookie, method: 'PATCH', body: { suspended: true } });
  await request('/me', { cookie: bob.cookie, expected: 401 });
  await request('/admin/users/' + bob.data.user.id, { cookie: admin.cookie, method: 'PATCH', body: { suspended: false } });
  await request('/auth/login', { method: 'POST', body: { identity: 'Bob', password: 'correct-horse-88' } }); pass('Suspension invalidates sessions and restoration allows login');
  await request('/auth/logout', { cookie: otherDevice.cookie, method: 'POST', body: {} });
  await request('/me', { cookie: otherDevice.cookie, expected: 401 }); pass('Logout invalidates the session on the server');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'network.json'), 'utf8')); assert(!JSON.stringify(disk).includes('correct-horse-99')); assert(!JSON.stringify(disk).includes(writeKey.data.token)); pass('Passwords and API secrets are not stored as plaintext');
  if (process.argv.includes('--browser')) await browserTests();
  console.log(`\n${count} checks passed.\n`);
}
async function browserTests() {
  const { chromium, expect } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(browser);
  const a = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['microphone', 'camera'] });
  const b = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['microphone', 'camera'] });
  const page = await a.newPage(), peer = await b.newPage(); const errors = [];
  [page, peer].forEach(p => p.on('pageerror', e => errors.push(e.message)));
  await page.goto(base); await page.locator('#identity').fill('Angelbrs12'); await page.locator('#password').fill('5121'); await page.locator('[type=submit]').click(); await expect(page.locator('.hero')).toBeVisible();
  await page.screenshot({ path: path.join(__dirname, 'checks', 'overview.png'), fullPage: true });
  await peer.goto(base); await peer.locator('[data-action=auth-toggle]').click(); await expect(peer.locator('.number-choice')).toHaveCount(6);
  await peer.locator('[data-action=prefix][data-prefix="+67"]').click(); await peer.locator('[data-action=signup-next]').click(); await peer.locator('#new-username').fill('BrowserFriend'); await peer.locator('#new-password').fill('browser-password-90'); await peer.locator('[type=submit]').click(); await expect(peer.locator('.hero')).toBeVisible();
  const friendNumber = await peer.evaluate(() => S.user.number);
  await page.locator('[data-action=new-message]').first().click(); await page.locator('#lookup-number').fill(friendNumber); await page.locator('#lookup-form [type=submit]').click(); await page.locator('[data-action=message-lookup]').click();
  await page.locator('#message-text').fill('A hello from a real browser'); await page.locator('#message-text').press('Enter'); await expect(page.locator('.bubble')).toContainText('A hello from a real browser');
  await peer.locator('.nav-item[data-route=messages]').click(); await peer.locator('.conversation-row').first().click(); await expect(peer.locator('.bubble')).toContainText('A hello from a real browser');
  await peer.locator('#message-text').fill('And a reply, across sessions!'); await peer.locator('#message-text').press('Enter'); await expect(page.locator('.bubble').last()).toContainText('And a reply'); pass('Browser signup, number lookup, and two-way live messaging');
  await page.screenshot({ path: path.join(__dirname, 'checks', 'messages.png'), fullPage: true });
  await page.locator('[data-action=call-peer][data-kind=video]').click(); await expect(peer.locator('[data-action=accept-call]')).toBeVisible(); await peer.locator('[data-action=accept-call]').click();
  await page.waitForFunction(() => pc?.connectionState === 'connected', { timeout: 20000 }); await peer.waitForFunction(() => pc?.connectionState === 'connected', { timeout: 20000 });
  assert(await page.evaluate(() => remoteStream?.getVideoTracks().length > 0)); assert(await peer.evaluate(() => remoteStream?.getAudioTracks().length > 0)); pass('Two browsers establish WebRTC video and audio with simulated devices');
  await page.locator('[data-action=toggle-mic]').click(); assert.equal(await page.evaluate(() => localStream.getAudioTracks()[0].enabled), false); await page.locator('[data-action=end-call]').click(); await expect(peer.locator('.call-card')).toHaveCount(0); pass('Microphone mute and call termination');
  await page.locator('.nav-item[data-route=developers]').click(); await page.locator('[data-action=create-key]').first().click(); await page.locator('#key-name').fill('Browser key'); await page.locator('#key-form [type=submit]').click(); await expect(page.locator('.secret')).toContainText('orb_live_'); await page.locator('[data-action=close-modal]').first().click(); await page.locator('[data-tab=docs]').click(); await expect(page.locator('.docs-content')).toBeVisible(); pass('Browser key creation and rendered API documentation');
  await page.locator('.nav-item[data-route=admin]').click(); await expect(page.locator('table')).toContainText('BrowserFriend'); await page.locator('[data-tab=numbers]').click(); await expect(page.locator('table')).toContainText('Available'); pass('Admin member and number-pool screens render');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('button.mobile-menu').click(); await page.locator('.nav-item[data-route=overview]').click();
  assert.equal(await page.evaluate(() => document.body.scrollWidth), 390); await page.screenshot({ path: path.join(__dirname, 'checks', 'mobile.png'), fullPage: true }); pass('Mobile layout fits a 390px screen');
  assert.deepEqual(errors, []); pass('No browser JavaScript errors across the tested flows');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { for (const b of browsers) await b.close(); for (const ws of sockets) ws.close(); child.kill(); await new Promise(r => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });
