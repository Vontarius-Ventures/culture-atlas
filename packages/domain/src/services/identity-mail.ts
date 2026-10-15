import { AppError } from '../errors';

/** Delivery provider boundary. Production supplies an adapter during startup. */
export interface IdentityMail {
  send(message: {
    to: string;
    purpose: 'sign_in' | 'verify' | 'recover';
    callback: string;
  }): Promise<void>;
}
export class DevIdentityOutbox implements IdentityMail {
  readonly messages: Parameters<IdentityMail['send']>[0][] = [];
  async send(message: Parameters<IdentityMail['send']>[0]): Promise<void> {
    this.messages.push(message);
  }
  clear(): void {
    this.messages.length = 0;
  }
}
let adapter: IdentityMail | undefined;
const dev = new DevIdentityOutbox();
export function setIdentityMail(adapterOverride: IdentityMail | undefined): void {
  adapter = adapterOverride;
}
export function getIdentityMail(environment: string): IdentityMail {
  if (adapter) return adapter;
  if (environment === 'production')
    throw new AppError('service_unavailable', { message: 'Email sign-in is not configured.' });
  return dev;
}
