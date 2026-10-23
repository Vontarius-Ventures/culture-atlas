import { describe, expect, it } from 'vitest';
import { destinationFromQlooProperties, forDisplayUpsert, imageFromQlooProperties, preferPicturedCards, qlooImageIfRenderable, sourceImageTooSmall } from './display';

describe('imageFromQlooProperties', () => {
  it('keeps an https url Qloo returned as a string', () => {
    expect(imageFromQlooProperties({ image: 'https://images.example/artist.jpg' }, 'Nina Simone')).toEqual({
      url: 'https://images.example/artist.jpg',
      alt: 'Nina Simone',
    });
  });

  it('keeps { url, attribution } and drops http or missing pictures', () => {
    expect(
      imageFromQlooProperties(
        { image: { url: 'https://images.example/cover.jpg', attribution: 'Qloo', license: 'source' } },
        'Cover',
      ),
    ).toMatchObject({ url: 'https://images.example/cover.jpg', attribution: 'Qloo', license: 'source' });
    expect(imageFromQlooProperties({ image: 'http://insecure.example/x.jpg' }, 'x')).toBeNull();
    expect(imageFromQlooProperties({ image: '/samples/local.jpg' }, 'x')).toBeNull();
    expect(imageFromQlooProperties({}, 'x')).toBeNull();
  });

  it('keeps the first https url from a Qloo images array', () => {
    expect(
      imageFromQlooProperties(
        { images: [{ url: 'https://images.example/place.jpg', attribution: 'Qloo' }] },
        'Place',
      ),
    ).toMatchObject({ url: 'https://images.example/place.jpg', attribution: 'Qloo' });
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

describe('qlooImageIfRenderable', () => {
  const image = { url: 'https://images.qloo.com/i/placeholder-420x-auto.jpg', alt: 'Hani Village' };

  it('drops a URL whose Content-Length is a stub', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'content-length': '117' } });
    await expect(qlooImageIfRenderable(image, fetchImpl)).resolves.toBeNull();
  });

  it('keeps a URL whose Content-Length is a real picture', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 200, headers: { 'content-length': '48000' } });
    await expect(qlooImageIfRenderable(image, fetchImpl)).resolves.toEqual(image);
  });

  it('keeps the URL when the probe throws', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('timeout');
    };
    await expect(qlooImageIfRenderable(image, fetchImpl)).resolves.toEqual(image);
  });
});

describe('destinationFromQlooProperties', () => {
  it('keeps an https website Qloo returned', () => {
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
    expect(forDisplayUpsert({ image: { url: 'https://images.example/a.jpg', alt: 'A' } })).toEqual({
      image: { url: 'https://images.example/a.jpg', alt: 'A' },
    });
  });
});

describe('preferPicturedCards', () => {
  it('drops imageless cards when sourced pictures exist', () => {
    const photo = { id: 'a', image: { url: 'https://images.example/a.jpg' } };
    const poster = { id: 'b', image: null };
    expect(preferPicturedCards([poster, photo, { id: 'c' }])).toEqual([photo]);
  });

  it('keeps the original rail when nothing has a picture', () => {
    const rail = [{ id: 'a' }, { id: 'b', image: null }];
    expect(preferPicturedCards(rail)).toEqual(rail);
  });
});
