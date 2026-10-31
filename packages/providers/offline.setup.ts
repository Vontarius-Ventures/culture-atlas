import net from 'node:net';
import { beforeEach } from 'vitest';

// Defense in depth: accidental ambient PostgreSQL or real HTTPS transport use
// must fail BEFORE opening a socket or resolving its host. All HTTP/DNS tests
// in this runner supply explicit fakes; this is not a qualification mechanism.
function forbidRealSockets(): void {
  net.Socket.prototype.connect = (() => {
    throw new Error('Real sockets forbidden in providers offline tests');
  }) as typeof net.Socket.prototype.connect;
  net.Server.prototype.listen = (() => {
    throw new Error('Real servers forbidden in providers offline tests');
  }) as typeof net.Server.prototype.listen;
}
// Install before test-file imports/beforeAll, not merely before individual tests.
forbidRealSockets();
beforeEach(forbidRealSockets);
