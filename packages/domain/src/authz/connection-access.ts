import type { LibraryAccess, Scope } from '../enums';

/**
 * Plain-language summary of what an agent connection can read and change,
 * shown when the owner creates or reviews a connection ("Connection setup
 * explains the readable/writable data"). Pure: derived from scopes + grant.
 */
export interface ConnectionAccessSummary {
  reads: string[];
  writes: string[];
  limits: string[];
}

export function describeConnectionAccess(
  scopes: readonly Scope[],
  libraryAccess: LibraryAccess,
  collectionNames: readonly string[] = [],
): ConnectionAccessSummary {
  const has = (s: Scope) => scopes.includes(s);
  const selected = libraryAccess === 'selected_collections';
  const all = libraryAccess === 'all';
  const where = selected
    ? `the ${collectionNames.length === 1 ? 'collection' : 'collections'} ${collectionNames.length ? collectionNames.map((n) => `“${n}”`).join(', ') : 'you selected'}`
    : 'your whole library';

  const reads: string[] = [];
  const writes: string[] = [];
  const limits: string[] = [];
  if (has('setup:read')) reads.push('Your safe device setup and observed capabilities');
  if (has('preferences:read')) reads.push('Your ordinary preferences, not your taste profile');
  if (has('media:read') && libraryAccess !== 'none') reads.push(`Preview photos and videos in ${where}`);
  if (has('media:download') && libraryAccess !== 'none') reads.push(`Download original media in ${where}`);
  if (has('preferences:write')) writes.push('Change ordinary preferences, never security or capture consent');
  if (has('media:write')) writes.push('Upload media and manage drafts created by this connection');
  if (has('media:analyze')) writes.push('Request analysis within your consent and spending limits');
  if (has('devices:command')) writes.push('Request capture on selected phones only while locally allowed');

  if (has('collections:read') && libraryAccess !== 'none') reads.push(`Items in ${where}`);
  if (has('captures:read')) {
    reads.push(
      all
        ? 'Compiled results of your photos (not the original images)'
        : selected
          ? `Compiled results of photos in ${where} or uploaded by this connection`
          : 'Compiled results of photos uploaded by this connection',
    );
  }
  if (has('taste:read')) reads.push(all ? 'Your saved interests' : selected ? `Interests within ${where}` : 'No saved interests');
  if (has('plans:read')) reads.push(all ? 'Your plans' : `Plans made only from items in ${where}`);

  if (has('captures:write')) writes.push('Upload photos and start discovery');
  if (has('collections:write') && libraryAccess !== 'none') {
    writes.push(all ? 'Create collections and add or remove items' : `Add or remove items in ${where}`);
  }
  if (has('taste:write')) writes.push(all ? 'Save, hide or remove items when you ask' : `Save items into ${where} when you ask`);
  if (has('plans:write')) writes.push('Create plans and replace plan sections');

  if (selected) {
    limits.push('Unfiled saves, other collections and your overall taste stay private.');
    limits.push('New collections are not added automatically.');
    limits.push('Cannot delete photos or unsave items everywhere.');
  }
  if (libraryAccess === 'none') limits.push('No access to your collections or saved items.');
  limits.push(has('media:download')
    ? 'Original downloads are audited. Sensor credentials and other connections are never shared.'
    : 'Original photos, Sensor credentials and other connections are never shared.');
  limits.push('You can revoke this connection at any time; it stops working immediately.');
  return { reads, writes, limits };
}
