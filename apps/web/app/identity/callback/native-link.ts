/** Only forward the existing one-use proof to the fixed app callback. No authority is exchanged here. */
export function iosHandoffLink(fragment: URLSearchParams): string | undefined {
  const fields = ['challenge_id', 'token', 'state', 'nonce'] as const;
  if (fields.some((field) => fragment.getAll(field).length !== 1)) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fragment.get('challenge_id')!))
    return undefined;
  if (fields.slice(1).some((field) => {
    const length = fragment.get(field)!.length;
    return length < 32 || length > 256;
  })) return undefined;
  const proof = new URLSearchParams(fields.map((field) => [field, fragment.get(field)!]));
  return `cultureatlas://identity/callback#${proof}`;
}
