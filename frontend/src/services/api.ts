import type {
    Sensor,
    SensoresResponse,
    ImageData,
} from '../types/sensor';

export { geocode, reverseGeocode } from '../utils/geocoding';

const API_URL =
    '/api/sensores?fields=id,nombre,ubicacion,nivelPolucion,metricas.concentracion,metricas.pm25,metricas.pm10,fechaInicio,fechaRecogida,taxonomyModel';

type ApiEnvelope<T> = {
    success?: boolean;
    data?: T;
    error?: string;
    details?: string;
};

type ParsedResponse<T> = {
    data: T | null;
    rawText: string;
    contentType: string;
};

async function parseApiResponse<T>(response: Response): Promise<ParsedResponse<T>> {
    const rawText = await response.text();
    const contentType = response.headers.get('content-type') || '';
    if (!rawText) {
        return { data: null, rawText, contentType };
    }

    try {
        const parsed = JSON.parse(rawText) as T;
        return { data: parsed, rawText, contentType };
    } catch {
        return { data: null, rawText, contentType };
    }
}

function buildApiError(
    response: Response,
    parsed: ParsedResponse<ApiEnvelope<unknown>>,
    fallbackMessage: string
): string {
    const data = parsed.data;
    const baseError = typeof data?.error === 'string' ? data.error : fallbackMessage;
    const details = typeof data?.details === 'string' ? data.details : '';
    if (details) {
        return `${baseError}: ${details}`;
    }

    if (response.status === 413) {
        return 'La imagen es demasiado grande para el servidor de producción.';
    }

    const looksLikeHtml =
        parsed.contentType.includes('text/html') ||
        parsed.rawText.trimStart().startsWith('<!DOCTYPE') ||
        parsed.rawText.trimStart().startsWith('<html');
    if (looksLikeHtml) {
        return `${fallbackMessage} (status ${response.status}). El servidor respondió HTML en lugar de JSON.`;
    }

    return `${baseError} (status ${response.status})`;
}

function parseOfficialStationsCsv(csvText: string): Sensor[] {
    const rawLines = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!rawLines.length) return [];

    const headerParts = rawLines[0].split(',').map((item) => item.trim().toLowerCase());
    const headerIndexMap = {
        gml_id: headerParts.indexOf('gml_id'),
        name: headerParts.indexOf('name'),
        latitude: headerParts.indexOf('latitude'),
        longitude: headerParts.indexOf('longitude'),
    };
    const hasNewHeader =
        headerIndexMap.name >= 0 &&
        headerIndexMap.latitude >= 0 &&
        headerIndexMap.longitude >= 0;
    const lines = rawLines.slice(1);

    return lines
        .map((line, index): Sensor | null => {
            const parts = line.split(',');
            if (parts.length < 3) return null;

            const latitude = hasNewHeader
                ? Number(parts[headerIndexMap.latitude])
                : Number(parts[parts.length - 1]);
            const longitude = hasNewHeader
                ? Number(parts[headerIndexMap.longitude])
                : Number(parts[parts.length - 2]);
            const name = hasNewHeader
                ? parts[headerIndexMap.name]?.trim()
                : parts.slice(0, parts.length - 2).join(',').trim();
            const gmlId =
                hasNewHeader && headerIndexMap.gml_id >= 0
                    ? parts[headerIndexMap.gml_id]?.trim()
                    : '';
            if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

            return {
                id: gmlId || `official-csv-${index + 1}`,
                nombre: name,
                ubicacion: {
                    latitud: latitude,
                    longitud: longitude,
                },
                metricas: {
                    pm25: null,
                    pm10: null,
                },
                nivelPolucion: 'Sin datos',
                fechaInicio: '',
                fechaRecogida: '',
                type: 'official',
            };
        })
        .filter((station): station is Sensor => station !== null);
}

async function fetchOfficialStationsCsvFallback(): Promise<Sensor[]> {
    try {
        const response = await fetch('/official_stations_coordinates.csv');
        if (!response.ok) return [];
        const csvText = await response.text();
        return parseOfficialStationsCsv(csvText);
    } catch (error) {
        console.error('Error loading official stations CSV fallback:', error);
        return [];
    }
}

function withFetchedAtForOfficialStations(stations: Sensor[]): Sensor[] {
    const fetchedAt = new Date().toISOString();
    return stations.map((station) => ({
        ...station,
        type: 'official',
        fechaRecogida: station.fechaRecogida || fetchedAt,
    }));
}

export async function fetchSensores(): Promise<Sensor[]> {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) {
            console.error(`Error fetching sensors: ${response.status}`);
            return [];
        }
        const data: SensoresResponse = await response.json();
        return Array.isArray(data.data) ? data.data : [];
    } catch (error) {
        console.error('Error fetching sensors:', error);
        return [];
    }
}

export async function fetchSensorById(id: string): Promise<Sensor | null> {
    try {
        const response = await fetch(`/api/sensores/${encodeURIComponent(id)}`);
        if (!response.ok) {
            console.error(`Error fetching sensor ${id}: ${response.status}`);
            return null;
        }

        const data = (await response.json()) as {
            success?: boolean;
            data?: Sensor | null;
        };

        return data?.data ?? null;
    } catch (error) {
        console.error(`Error fetching sensor ${id}:`, error);
        return null;
    }
}

export async function fetchEstacionesOficiales(
    startDate?: string,
    endDate?: string
): Promise<Sensor[]> {
    try {
        const params = new URLSearchParams();
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        const query = params.toString();
        const url = query ? `/api/estaciones-oficiales?${query}` : '/api/estaciones-oficiales';

        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Error fetching official stations: ${response.status}`);
            const fallbackStations = await fetchOfficialStationsCsvFallback();
            return withFetchedAtForOfficialStations(fallbackStations);
        }
        const data: SensoresResponse = await response.json();
        const stations = Array.isArray(data.data) ? data.data : [];
        if (stations.length > 0) return withFetchedAtForOfficialStations(stations);
        const fallbackStations = await fetchOfficialStationsCsvFallback();
        return withFetchedAtForOfficialStations(fallbackStations);
    } catch (error) {
        console.error('Error fetching official stations:', error);
        const fallbackStations = await fetchOfficialStationsCsvFallback();
        return withFetchedAtForOfficialStations(fallbackStations);
    }
}

export async function fetchImages(ids: string[]): Promise<ImageData[]> {
    if (!ids.length) return [];

    const CHUNK_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + CHUNK_SIZE));
    }

    const results: ImageData[] = [];
    for (const chunk of chunks) {
        const response = await fetch('/api/imagenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: chunk }),
        });
        if (!response.ok) {
            throw new Error(`Error obteniendo imágenes (lote de ${chunk.length})`);
        }
        const data = (await response.json()) as ImageData[];
        if (Array.isArray(data) && data.length) {
            results.push(...data);
        }
    }

    return results;
}

export interface ImagesEstimate {
    requestedIds: number;
    validIds: number;
    foundImages: number;
    estimatedBytes: number;
}

export async function estimateImagesDownload(ids: string[]): Promise<ImagesEstimate> {
    const response = await fetch('/api/imagenes/estimacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    });
    if (!response.ok) {
        throw new Error('Error estimando la descarga de imágenes');
    }
    return response.json();
}

export interface ProcessedAnalysis {
    contourImageB64: string;
    roiImageB64: string;
    binaryB64: string;
    overlayB64: string;
    validation?: SensorValidationResult;
    analysisResults: {
        num_contours?: number;
        area_percentage?: number;
        total_area?: number;
    };
    pollutionData: {
        model_type?: string;
        selected_model_type?: string;
        PM10?: {
            concentration_standard?: number;
            concentration_sensor?: number;
            num_particles?: number;
            particles_per_contour?: number;
            model_type?: string;
        };
        PM25?: {
            concentration_standard?: number;
            concentration_sensor?: number;
            num_particles?: number;
            particles_per_contour?: number;
            model_type?: string;
        };
        concentration_standard_pm10?: number;
        concentration_standard_pm25?: number;
        concentration_standard?: number;
        concentration_sensor?: number;
        num_particles?: number;
        particles_per_contour?: number;
    };
    pollutionLevel: string;
    pollutionLevels?: {
        PM10?: string;
        PM25?: string;
    };
    taxonomyModel?: {
        status?: string;
        top_category?: string;
        top_category_label?: string;
        feature_count?: number;
        used_formula_features?: string[];
        note?: string;
        is_definitive_truth?: boolean;
        ranked_categories?: Array<{
            category: string;
            label: string;
            score: number;
            percentage: number;
            evidence?: Array<{
                feature: string;
                z: number;
                weight: number;
                contribution: number;
            }>;
        }>;
    } | null;
    datasetOutputs?: {
        execution_scope?: string[];
        images_metadata?: Record<string, unknown>;
        particles?: Array<Record<string, unknown>>;
        image_features?: Record<string, unknown>;
        feature_sets?: Record<string, string[]>;
    } | null;
}

export type PollutionModelType = 'PM10' | 'PM25';

export interface SensorValidationResult {
    is_sensor: boolean;
    sensor_probability: number;
    non_sensor_probability: number;
    threshold: number;
    model_input_size: {
        width: number;
        height: number;
    };
}

export async function validateSensorImage(imageB64: string): Promise<SensorValidationResult> {
    const response = await fetch('/api/analysis/validate-sensor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageB64 }),
    });
    const parsed = await parseApiResponse<ApiEnvelope<SensorValidationResult>>(response);
    const data = parsed.data;
    if (!response.ok || !data?.success) {
        throw new Error(buildApiError(response, parsed, 'Error validando la imagen'));
    }
    if (!data.data) {
        throw new Error('Respuesta inválida del servidor al validar la imagen');
    }
    return data.data as SensorValidationResult;
}

export async function processAnalysisImage(
    imageB64: string,
    modelType?: PollutionModelType
): Promise<ProcessedAnalysis> {
    const payload = modelType ? { imageB64, modelType } : { imageB64 };
    const response = await fetch('/api/analysis/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const parsed = await parseApiResponse<ApiEnvelope<ProcessedAnalysis>>(response);
    const data = parsed.data;
    if (!response.ok || !data?.success) {
        throw new Error(buildApiError(response, parsed, 'Error procesando imagen'));
    }
    if (!data.data) {
        throw new Error('Respuesta inválida del servidor al procesar la imagen');
    }
    return data.data as ProcessedAnalysis;
}

export async function submitExperiment(payload: {
    sensorEnvironment: 'indoor' | 'outdoor';
    isTestSensor?: boolean;
    startDate: string;
    endDate: string;
    latitude: number;
    longitude: number;
    pm10Concentration: number;
    pm25Concentration: number;
    concentration?: number;
    pollutionLevel?: string;
    inputImageB64: string;
    context: string;
    analysisResults: {
        numContours: number;
        areaPercentage: number;
    };
    taxonomyModel?: ProcessedAnalysis['taxonomyModel'];
}): Promise<{ success: boolean; id?: string; imageUrl?: string }> {
    const response = await fetch('/api/experimentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    const parsed = await parseApiResponse<{
        success?: boolean;
        id?: string;
        imageUrl?: string;
        error?: string;
        details?: string;
    }>(response);
    const data = parsed.data;
    if (!response.ok || !data?.success) {
        const normalizedForError: ParsedResponse<ApiEnvelope<unknown>> = {
            ...parsed,
            data: data
                ? {
                      error: data.error,
                      details: data.details,
                  }
                : null,
        };
        throw new Error(buildApiError(response, normalizedForError, 'Error guardando experimento'));
    }

    return { success: true, id: data.id, imageUrl: data.imageUrl };
}
