import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { geocode, reverseGeocode } from '../src/utils/geocoding.ts';

afterEach(() => mock.restoreAll());

const city = {
    lat: '43.3', lon: '-2.9', osm_type: 'relation', osm_id: 123,
    category: 'boundary', type: 'administrative', addresstype: 'city',
};
const centre = { type: 'node', id: 456, lat: 43.26, lon: -2.93 };
const relation = (members) => ({ elements: [{ type: 'relation', id: 123, members }] });

function responses(...values) {
    let index = 0;
    return mock.method(globalThis, 'fetch', async () => {
        assert.ok(index < values.length, 'Unexpected extra request');
        const value = values[index++];
        if (value instanceof Error) throw value;
        return value instanceof Response ? value : Response.json(value);
    });
}

test('uses the settlement centre instead of the municipality centroid', async () => {
    const fetch = responses([city], relation([{ type: 'node', ref: 456, role: 'admin_centre' }]), { elements: [centre] });
    assert.deepEqual(await geocode('Bilbao'), { lat: 43.26, lon: -2.93 });
    const urls = fetch.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(new URL(urls[0]).searchParams.get('featureType'), 'city');
    assert.ok(urls[1].endsWith('/relation/123.json'));
    assert.ok(urls[2].endsWith('/node/456.json'));
});

test('prefers the conventional label centre when both centre roles exist', async () => {
    const fetch = responses([city], relation([
        { type: 'node', ref: 789, role: 'admin_centre' },
        { type: 'node', ref: 456, role: 'label' },
    ]), { elements: [centre] });
    assert.deepEqual(await geocode('Bilbao'), { lat: 43.26, lon: -2.93 });
    assert.ok(String(fetch.mock.calls[2].arguments[0]).endsWith('/node/456.json'));
});

test('already mapped city nodes require no further lookup', async () => {
    const fetch = responses([{ ...city, osm_type: 'node' }]);
    assert.deepEqual(await geocode('Bilbao'), { lat: 43.3, lon: -2.9 });
    assert.equal(fetch.mock.callCount(), 1);
});

test('falls back for smaller settlements when the city filter finds nothing', async () => {
    const fetch = responses([], [{ ...city, osm_type: 'node', addresstype: 'village' }]);
    assert.deepEqual(await geocode('Small village'), { lat: 43.3, lon: -2.9 });
    assert.equal(new URL(fetch.mock.calls[1].arguments[0]).searchParams.has('featureType'), false);
});

test('missing centre members and unavailable centre APIs retain the geocoded point', async () => {
    for (const result of [relation([]), new Error('Network failure'), new Response(null, { status: 503 })]) {
        responses([city], result);
        assert.deepEqual(await geocode('Bilbao'), { lat: 43.3, lon: -2.9 });
        mock.restoreAll();
    }
});

test('invalid centre coordinates fall back to valid search coordinates', async () => {
    responses([city], relation([{ type: 'node', ref: 456, role: 'admin_centre' }]), {
        elements: [{ ...centre, lat: 200 }],
    });
    assert.deepEqual(await geocode('Bilbao'), { lat: 43.3, lon: -2.9 });
});

test('empty results, invalid coordinates and failed searches report errors', async () => {
    for (const results of [[[], []], [[{ ...city, lat: 'invalid' }]], [new Response(null, { status: 429 })]]) {
        responses(...results);
        await assert.rejects(geocode('Bilbao'));
        mock.restoreAll();
    }
});

test('reverse lookup requests the address at the dropped marker coordinates', async () => {
    const fetch = responses({ display_name: 'Gran Vía, Bilbao, Bizkaia, España' });
    assert.equal(await reverseGeocode(43.26, -2.93), 'Gran Vía, Bilbao, Bizkaia, España');
    const url = new URL(fetch.mock.calls[0].arguments[0]);
    assert.equal(url.pathname, '/reverse');
    assert.equal(url.searchParams.get('lat'), '43.26');
    assert.equal(url.searchParams.get('lon'), '-2.93');
    assert.equal(url.searchParams.get('zoom'), '18');
});

test('reverse lookup respects cancellation for obsolete marker positions', async () => {
    const controller = new AbortController();
    const fetch = responses({ display_name: 'Bilbao' });
    await reverseGeocode(43.26, -2.93, controller.signal);
    controller.abort();
    assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
});

test('reverse lookup rejects missing addresses and invalid coordinates', async () => {
    for (const result of [{ error: 'Unable to geocode' }, { display_name: '' }, new Response(null, { status: 429 })]) {
        responses(result);
        await assert.rejects(reverseGeocode(43.26, -2.93));
        mock.restoreAll();
    }
    const fetch = responses();
    await assert.rejects(reverseGeocode(100, -2.93));
    assert.equal(fetch.mock.callCount(), 0);
});
