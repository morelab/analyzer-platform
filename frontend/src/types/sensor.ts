export interface Sensor {
    id: string;
    nombre: string;
    ubicacion: {
        latitud: number;
        longitud: number;
    };
    nivelPolucion: string;
    metricas?: {
        concentracion?: number;
        pm10?: number | null;
        pm25?: number | null;
    };
    fechaInicio: string;
    fechaRecogida: string;
    imagen?: string;
    type?: 'diy' | 'official';
    hasPM10?: boolean;
    hasPM25?: boolean;
    taxonomyModel?: {
        top_category?: string;
        top_category_label?: string;
        note?: string;
        ranked_categories?: Array<{
            category: string;
            label: string;
            percentage: number;
        }>;
    } | null;
}

export interface FilterOptions {
    centro?: {
        lat: number;
        lon: number;
    };
    radioKm?: number;
    fechaInicio?: string;
    fechaFin?: string;
    showDIY?: boolean;
}

export interface SensoresResponse {
    data: Sensor[];
}

export interface GeocodingResult {
    lat: string;
    lon: string;
    osm_type?: 'node' | 'way' | 'relation';
    osm_id?: number;
    category?: string;
    addresstype?: string;
    type?: string;
}

export interface ImageData {
    id: string;
    base64: string;
}
