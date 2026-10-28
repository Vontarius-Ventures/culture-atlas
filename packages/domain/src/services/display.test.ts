import { describe, expect, it } from 'vitest';
import {
  clearedDisplayImage,
  destinationFromQlooProperties,
  forDisplayUpsert,
  isClearedDisplayImageUrl,
  isProviderBackedItem,
  preferPicturedCards,
  qlooImageUrl,
  qlooImageUrlIfRenderable,
  sourceImageTooSmall,
  storeSanitizedDisplayMetadata,
} from './display';

describe('qlooImageUrl (transient-only extraction)', () => {
  it('extracts an https url Qloo returned, transiently and only for probing', () => {
    expect(qlooImageUrl({ image: 'https://images.example/artist.jpg' })).toBe('https://images.example/artist.jpg');
    expect(qlooImageUrl({ image: { url: 'https://images.example/cover.jpg' } })).toBe('https://images.example/cover.jpg');
    expect(qlooImageUrl({ images: [{ url: 'https://images.example/place.jpg' }] })).toBe(
      'https://images.example/place.jpg',
    );
  });

  it('rejects http, relative and missing pictures', () => {
    expect(qlooImageUrl({ image: 'http://insecure.example/x.jpg' })).toBeNull();
    expect(qlooImageUrl({ image: '/samples/local.jpg' })).toBeNull();
    expect(qlooImageUrl({})).toBeNull();
    expect(qlooImageUrl(undefined)).toBeNull();
  });
});

describe('sourceImageTooSmall', () => {
  it('rejects Qloo 30×30 placeholder bytes and keeps a real cover', () => {
    expect(sourceImageTooSmall(117)).toBe(true);
    expect(sourceImageTooSmall(2047)).toBe(true);
    expect(sourceImageTooSmall(2048)).toBe(false);
    expect(sourceImageTooSmall(48_000)).toBe(false);
    expect(sourceImageTooSmall(null)).toBe(true);
  });
});

describe('qlooImageUrlIfRenderable (transient probe, boolean answer only)', () => {
  it('drops a URL whose Content-Length is a stub', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'content-length': '117' } });
    await expect(qlooImageUrlIfRenderable('https://images.example/a.jpg', fetchImpl)).resolves.toBe(false);
  });

  it('keeps a URL whose Content-Length is a real picture', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'content-length': '48000' } });
    await expect(qlooImageUrlIfRenderable('https://images.example/a.jpg', fetchImpl)).resolves.toBe(true);
  });

  it('keeps the card when the probe throws or the URL is absent', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('timeout');
    };
    await expect(qlooImageUrlIfRenderable('https://images.example/a.jpg', fetchImpl)).resolves.toBe(true);
    await expect(qlooImageUrlIfRenderable(null, fetchImpl)).resolves.toBe(false);
  });
});

describe('display clearance (VAL-EVID-005)', () => {
  it('treats HTTPS, provider licenses and assurances as clearance for nothing', () => {
    expect(isClearedDisplayImageUrl('https://images.example/a.jpg')).toBe(false);
    expect(isClearedDisplayImageUrl('https://qloo.media/licensed.jpg')).toBe(false);
    expect(isClearedDisplayImageUrl('//protocol-relative.example/a.jpg')).toBe(false);
  });

  it('clears app-served relative assets only', () => {
    expect(isClearedDisplayImageUrl('/samples/dish.jpg')).toBe(true);
    expect(isClearedDisplayImageUrl('/v1/media/signed')).toBe(true);
  });

  it('serves user-owned stored media and app assets, never uncleared external URLs', () => {
    expect(clearedDisplayImage({ object_key: 'captures/abc/photo.jpg', alt: 'Your photo' })).toMatchObject({
      object_key: 'captures/abc/photo.jpg',
    });
    expect(clearedDisplayImage({ url: '/samples/dish.jpg', alt: 'Dish' })).toMatchObject({ url: '/samples/dish.jpg' });
    expect(
      clearedDisplayImage({ url: 'https://images.example/a.jpg', attribution: 'Qloo', license: 'source', alt: 'A' }),
    ).toBeNull();
    expect(clearedDisplayImage(null)).toBeNull();
  });

  it('marks items provider-backed only when they carry a Qloo id', () => {
    expect(isProviderBackedItem({ qloo: 'urn:entity:x' })).toBe(true);
    expect(isProviderBackedItem({ qloo_tag: 'urn:tag:cuisine:x' })).toBe(true);
    expect(isProviderBackedItem({})).toBe(false);
    expect(isProviderBackedItem(null)).toBe(false);
  });

  it('sanitizes provider prose and uncleared imagery at the store boundary, keeping owned content', () => {
    expect(
      storeSanitizedDisplayMetadata(
        {
          subtitle: '1957',
          year: 1957,
          description: 'Qloo prose that must stay transient.',
          image: { url: 'https://images.example/boundary.jpg', attribution: 'Qloo', alt: 'Boundary' },
          destination_url: 'https://official.example.com',
        },
        { qloo: 'urn:entity:x' },
      ),
    ).toEqual({
      subtitle: '1957',
      year: 1957,
      description: null,
      image: null,
      destination_url: 'https://official.example.com',
    });
    // Independently produced prose survives on non-provider rows; so does owned media.
    expect(
      storeSanitizedDisplayMetadata(
        { description: 'A model-composed idea.', image: { object_key: 'captures/abc/photo.jpg', alt: 'Your photo' } },
        {},
      ),
    ).toEqual({ description: 'A model-composed idea.', image: { object_key: 'captures/abc/photo.jpg', alt: 'Your photo' } });
    // Even a non-provider row cannot persist an uncleared external URL.
    expect(storeSanitizedDisplayMetadata({ image: { url: 'https://images.example/x.jpg', alt: 'X' } }, {})).toEqual({
      description: null,
      image: null,
    });
  });
});

describe('destinationFromQlooProperties', () => {
  it('keeps an https website Qloo returned (a link out, not retained content)', () => {
    expect(destinationFromQlooProperties({ website: 'https://ninasimone.com' })).toBe('https://ninasimone.com');
    expect(destinationFromQlooProperties({ website: { url: 'https://ninasimone.com' } })).toBe('https://ninasimone.com');
    expect(destinationFromQlooProperties({ website: 'http://insecure.example' })).toBeNull();
    expect(destinationFromQlooProperties({})).toBeNull();
  });
});

describe('forDisplayUpsert', () => {
  it('omits null image so a JSONB merge cannot wipe an existing picture', () => {
    expect(forDisplayUpsert({ subtitle: '1968', image: null, destination_url: null, example: true })).toEqual({
      subtitle: '1968',
      example: true,
    });
    expect(forDisplayUpsert({ image: { url: '/samples/a.jpg', alt: 'A' } })).toEqual({
      image: { url: '/samples/a.jpg', alt: 'A' },
    });
  });
});

describe('preferPicturedCards', () => {
  it('drops imageless cards when cleared pictures exist', () => {
    const photo = { id: 'a', image: { object_key: 'captures/x/photo.jpg' } };
    const poster = { id: 'b', image: null };
    expect(preferPicturedCards<{ id: string; image?: unknown }>([poster, photo, { id: 'c' }])).toEqual([photo]);
  });

  it('keeps the original rail when nothing has a picture', () => {
    const rail = [{ id: 'a' }, { id: 'b', image: null }];
    expect(preferPicturedCards(rail)).toEqual(rail);
  });
});
