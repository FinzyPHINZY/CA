/**
 * Quick Socket.io test client for analysis notifications.
 *
 * Usage:
 *   node test-ws-notifications.mjs <jwt_token>
 *   node test-ws-notifications.mjs <jwt_token> ws://localhost:3003
 */
import { io } from 'socket.io-client';

const token = process.argv[2];
const baseUrl = process.argv[3] || 'ws://localhost:3003';

if (!token) {
  console.error('Usage: node test-ws-notifications.mjs <jwt_token> [ws_url]');
  process.exit(1);
}

const url = `${baseUrl}/notifications`;
console.log(`Connecting to ${url} ...`);
console.log(baseUrl, 'baseurl');

const socket = io(url, {
  auth: { token },
  transports: ['websocket'],
  reconnection: true,
});

socket.on('connect', () => {
  console.log(`✓ Connected (id=${socket.id})`);
});

socket.on('connect_error', (err) => {
  console.error('error:', err);
  console.error(`✗ Connection error: ${err.message}`);
});

socket.on('disconnect', (reason) => {
  console.log(`Disconnected: ${reason}`);
});

// Listen to all analysis events
socket.on('analysis.progress', (data) => {
  console.log('\n── analysis.progress ──');
  console.log(JSON.stringify(data, null, 2));
});

socket.on('analysis.completed', (data) => {
  console.log('\n── analysis.completed ──');
  console.log(JSON.stringify(data, null, 2));
});

// Also listen for any event (catch-all)
socket.onAny((event, ...args) => {
  if (event === 'analysis.progress' || event === 'analysis.completed') return;
  console.log(`\n── ${event} ──`);
  console.log(JSON.stringify(args, null, 2));
});

console.log('Listening for events... (Ctrl+C to exit)\n');
