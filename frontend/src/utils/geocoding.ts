import type { GeocodingResult } from '../types/sensor';

interface Coordinates {
    lat: number;
    lon: number;
}

interface OsmElement {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    members?: Array<{ type: string; ref: number; role: string }>;
}

export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<string> {
    if (!coordinates(lat, lon)) throw new Error('Coordenadas inválidas');
    const params = new URLSearchParams({
        format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '18', layer: 'address',
        'accept-language': 'es',
    });
    const timeout = AbortSignal.timeout(10000);
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error('No se pudo identificar la ubicación');
    const data: { display_name?: string; error?: string } = await response.json();
    if (data.error || !data.display_name?.trim()) throw new Error('Ubicación no encontrada');
    return data.display_name.trim();
}

function coordinates(lat: unknown, lon: unknown): Coordinates | null {
    if ((typeof lat !== 'string' && typeof lat !== 'number') ||
        (typeof lon !== 'string' && typeof lon !== 'number') || lat === '' || lon === '') return null;
    const point = { lat: Number(lat), lon: Number(lon) };
    return Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
        Number.isFinite(point.lon) && Math.abs(point.lon) <= 180 ? point : null;
}

async function cityCentre(place: GeocodingResult): Promise<Coordinates | null> {
    const settlementTypes = ['city', 'town', 'village', 'hamlet', 'municipality'];
    if (place.osm_type !== 'relation' || !place.osm_id ||
        !settlementTypes.includes(place.addresstype ?? place.type ?? '')) return null;

    // A boundary's centroid can be far outside the urban centre. Its label or
    // administrative-centre node represents the named settlement instead.
    const signal = AbortSignal.timeout(6000);
    const relationResponse = await fetch(
        `https://api.openstreetmap.org/api/0.6/relation/${place.osm_id}.json`, { signal }
    );
    if (!relationResponse.ok) return null;
    const relationData: { elements: OsmElement[] } = await relationResponse.json();
    const members = relationData.elements.find(
        (element) => element.type === 'relation' && element.id === place.osm_id
    )?.members ?? [];
    const centre = members.find((member) => member.type === 'node' && member.role === 'label') ??
        members.find((member) => member.type === 'node' && member.role === 'admin_centre');
    if (!centre) return null;

    const nodeResponse = await fetch(
        `https://api.openstreetmap.org/api/0.6/node/${centre.ref}.json`, { signal }
    );
    if (!nodeResponse.ok) return null;
    const nodeData: { elements: OsmElement[] } = await nodeResponse.json();
    const node = nodeData.elements.find((element) => element.type === 'node' && element.id === centre.ref);
    return coordinates(node?.lat, node?.lon);
}

export async function geocode(city: string): Promise<Coordinates> {
    if (!city.trim()) throw new Error('Introduce una ubicación');
    const params = new URLSearchParams({ format: 'jsonv2', q: city.trim(), featureType: 'city', limit: '1' });
    const search = async (): Promise<GeocodingResult[]> => {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('No se pudo buscar la ubicación');
        return response.json();
    };
    let results = await search();
    if (!results.length) {
        // Retain support for smaller settlements and specific addresses.
        params.delete('featureType');
        results = await search();
    }
    const place = results[0];
    const fallback = place && coordinates(place.lat, place.lon);
    if (!fallback) throw new Error('Ubicación no encontrada');
    try {
        return await cityCentre(place) ?? fallback;
    } catch {
        // Missing centre data or an unavailable OSM API should not prevent selection.
        return fallback;
    }
}
