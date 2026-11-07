import express from 'express';
import { Client as MinioClient } from 'minio';
import { getDatabase } from '../config/database.js';

const router = express.Router();

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = Number(process.env.MINIO_PORT || 9000);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'images';
const MINIO_PUBLIC_BASE_URL = process.env.MINIO_PUBLIC_BASE_URL || 'http://localhost:9000';
const MINIO_REGION = process.env.MINIO_REGION || 'us-east-1';

const minioClient = new MinioClient({
    endPoint: MINIO_ENDPOINT,
    port: MINIO_PORT,
    useSSL: false,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
});

let bucketReady = false;

function numberOrNull(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

async function ensureBucketExists() {
    if (bucketReady) return;

    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
        await minioClient.makeBucket(MINIO_BUCKET, MINIO_REGION);
    }
    bucketReady = true;
}

function parseImagePayload(imageValue) {
    if (!imageValue || typeof imageValue !== 'string') return null;

    const dataUrlMatch = imageValue.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataUrlMatch) {
        const [, mimeType, payload] = dataUrlMatch;
        return { mimeType, payload };
    }

    return { mimeType: 'image/png', payload: imageValue };
}

function getExtensionFromMime(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

async function uploadInputImageToMinio(inputImageB64) {
    const parsed = parseImagePayload(inputImageB64);
    if (!parsed) return null;

    const { mimeType, payload } = parsed;
    let buffer;
    try {
        buffer = Buffer.from(payload, 'base64');
    } catch {
        throw new Error('Imagen de entrada inválida en base64');
    }

    if (!buffer || buffer.length === 0) {
        throw new Error('Imagen de entrada vacía');
    }

    await ensureBucketExists();

    const ext = getExtensionFromMime(mimeType);
    const objectName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    await minioClient.putObject(MINIO_BUCKET, objectName, buffer, buffer.length, {
        'Content-Type': mimeType,
    });

    const normalizedBase = MINIO_PUBLIC_BASE_URL.replace(/\/+$/, '');
    return `${normalizedBase}/${MINIO_BUCKET}/${objectName}`;
}

router.post('/experimentos', async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            latitude,
            longitude,
            pm10Concentration,
            pm25Concentration,
            inputImageB64,
            context,
            analysisResults,
            taxonomyModel,
            isTestSensor,
            sensorEnvironment,
        } = req.body || {};

        if (isTestSensor !== undefined && typeof isTestSensor !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Tipo de sensor inválido' });
        }

        if (sensorEnvironment !== 'indoor' && sensorEnvironment !== 'outdoor') {
            return res.status(400).json({
                success: false,
                error: 'Selecciona si el sensor es de interior o de exterior.',
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'Faltan fechas del experimento' });
        }

        if (
            typeof latitude !== 'number' ||
            typeof longitude !== 'number' ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
        ) {
            return res.status(400).json({ success: false, error: 'Coordenadas inválidas' });
        }

        const resolvedPm10 = numberOrNull(pm10Concentration);
        const resolvedPm25 = numberOrNull(pm25Concentration);
        if (resolvedPm10 === null || resolvedPm10 < 0 || resolvedPm25 === null || resolvedPm25 < 0) {
            return res.status(400).json({
                success: false,
                error: 'Concentraciones PM10/PM2.5 inválidas',
            });
        }

        const pm10Value = resolvedPm10;
        const pm25Value = resolvedPm25;
        if (typeof context !== 'string' || context.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Falta el contexto de la fotografía',
            });
        }

        // Test runs must never reach MongoDB or upload images to MinIO.
        if (isTestSensor === true) {
            return res.json({ success: true, saved: false });
        }

        const db = getDatabase();
        const collection = db.collection(process.env.MONGODB_COLLECTION || 'records');
        const inputImageUrl = inputImageB64 ? await uploadInputImageToMinio(inputImageB64) : null;

        const doc = {
            'Fecha de inicio': startDate,
            'Fecha de recogida': endDate,
            'Localización longitud': longitude,
            'Localización latitud': latitude,
            'Número de contornos detectados': Number(analysisResults?.numContours || 0),
            'Porcentaje de área detectada': Number(analysisResults?.areaPercentage || 0),
            'PM10': pm10Value,
            'PM2.5': pm25Value,
            'Posibles fuentes contaminantes': taxonomyModel || null,
            'Imagen de entrada': inputImageUrl,
            context,
            sensorEnvironment,
        };

        const result = await collection.insertOne(doc);

        res.status(201).json({
            success: true,
            id: result.insertedId.toString(),
            imageUrl: inputImageUrl,
        });
    } catch (error) {
        console.error('Error in POST /api/experimentos:', error);
        res.status(500).json({
            success: false,
            error: 'Error al guardar el experimento',
            message: error.message,
        });
    }
});

export default router;
