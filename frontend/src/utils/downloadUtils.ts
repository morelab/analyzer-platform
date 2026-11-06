import JSZip from 'jszip';
import type { Sensor } from '../types/sensor';
import { formatDate } from './dateUtils';

const CSV_POLLUTION_CATEGORIES = [
    'combustion_related',
    'mechanical_non_combustion_particulate',
    'biological',
    'fibrous_synthetic_materials',
    'industrial',
    'mixed_unknown',
] as const;

export function downloadCSV(sensors: Sensor[]): void {
    if (!sensors.length) {
        alert('No hay datos para exportar');
        return;
    }

    const header = [
        'id',
        'nombre',
        'latitud',
        'longitud',
        'fechaInicio',
        'fechaRecogida',
        'PM10',
        'PM2.5',
        ...CSV_POLLUTION_CATEGORIES.map((category) => `${category}_percentage`),
    ];
    const rows = sensors.map((s) =>
        [
            s.id,
            s.nombre,
            s.ubicacion.latitud,
            s.ubicacion.longitud,
            formatDate(s.fechaInicio),
            formatDate(s.fechaRecogida),
            typeof s.metricas?.pm10 === 'number' ? s.metricas.pm10.toFixed(1) : 'N/A',
            typeof s.metricas?.pm25 === 'number' ? s.metricas.pm25.toFixed(1) : 'N/A',
            ...CSV_POLLUTION_CATEGORIES.map((category) => {
                const percentage = s.taxonomyModel?.ranked_categories?.find(
                    (item) => item.category === category
                )?.percentage;
                return typeof percentage === 'number' && Number.isFinite(percentage)
                    ? percentage
                    : 'N/A';
            }),
        ].join(',')
    );

    const blob = new Blob([header.join(',') + '\n' + rows.join('\n')], {
        type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    link.download = `data_${yyyy}${mm}${dd}${hh}${min}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

export async function downloadImagesZip(
    sensors: Sensor[],
    imageData: { id: string; base64: string }[]
): Promise<void> {
    if (!sensors.length) {
        alert('No hay sensores tras el filtro.');
        return;
    }

    const zip = new JSZip();
    imageData.forEach(({ id, base64 }) => {
        try {
            const blob = b64ToBlob(base64, 'image/jpeg');
            zip.file(`${id}.jpg`, blob);
        } catch (error) {
            console.error(`Imagen inválida para ${id}, se omite del ZIP`, error);
        }
    });

    if (!Object.keys(zip.files).length) {
        throw new Error('No hay imágenes válidas para incluir en el ZIP');
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    link.download = `imgs_${yyyy}${mm}${dd}${hh}${min}.zip`;
    link.click();
    URL.revokeObjectURL(url);
}

function b64ToBlob(b64: string, mime: string): Blob {
    const normalized = b64.includes(',') ? b64.split(',').pop() || '' : b64;
    const byteStr = atob(normalized);
    const len = byteStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = byteStr.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}
