import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Client as MinioClient } from 'minio';
import router from './experiments.js';

const submit = router.stack.find((layer) => layer.route?.path === '/experimentos').route.stack[0].handle;
const experiment = {
    sensorEnvironment: 'indoor',
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    latitude: 43.26,
    longitude: -2.93,
    pm10Concentration: 12,
    pm25Concentration: 8,
    inputImageB64: 'aW1hZ2U=',
    context: 'Sensor de prueba',
};

async function request(body) {
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    await submit({ body }, response);
    return response;
}

test('test sensors complete without a database connection or any MinIO operations', async () => {
    const calls = ['bucketExists', 'makeBucket', 'putObject'].map((method) =>
        mock.method(MinioClient.prototype, method, () => {
            throw new Error('Test sensors must not access MinIO');
        })
    );
    try {
        // No MongoDB connection is initialized: accessing it would cause a 500 response.
        const response = await request({ ...experiment, isTestSensor: true });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, { success: true, saved: false });
        calls.forEach((call) => assert.equal(call.mock.callCount(), 0));
    } finally {
        mock.restoreAll();
    }
});

test('rejects ambiguous test flags before any persistence', async () => {
    for (const isTestSensor of ['true', 'false', 1, null]) {
        const response = await request({ ...experiment, isTestSensor });
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.success, false);
    }
});

test('test sensors still require valid experiment data', async () => {
    const response = await request({ ...experiment, isTestSensor: true, latitude: null });
    assert.equal(response.statusCode, 400);
});

test('requires an explicit indoor or outdoor choice before persistence', async () => {
    for (const sensorEnvironment of [undefined, null, '', 'other', true, 1]) {
        const response = await request({ ...experiment, sensorEnvironment });
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.error, 'Selecciona si el sensor es de interior o de exterior.');
    }
});

test('accepts both indoor and outdoor test sensors', async () => {
    for (const sensorEnvironment of ['indoor', 'outdoor']) {
        const response = await request({ ...experiment, sensorEnvironment, isTestSensor: true });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, { success: true, saved: false });
    }
});
