import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import L from 'leaflet';
import {
    geocode,
    reverseGeocode,
    processAnalysisImage,
    submitExperiment,
    validateSensorImage,
    type ProcessedAnalysis,
} from '../../services/api';
import { POLLUTION_LEVELS } from '../../constants/pollutionLevels';

interface ParticleAnalysisPageProps {
    onOpenMap: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_TITLES: Record<Step, string> = {
    1: 'Fechas',
    2: 'Ubicación',
    3: 'Imagen del sensor',
    4: 'Confirmación del área',
    5: 'Resultados',
};

const TAXONOMY_CATEGORY_DESCRIPTIONS: Record<string, string> = {
    combustion_related:
        'Suele agrupar partículas pequeñas y compactas, compatibles con procesos de combustión. Puede relacionarse con tráfico, humo u otras emisiones por quema.',
    mechanical_non_combustion_particulate:
        'Hace referencia a partículas generadas por desgaste o fricción, no por combustión. Puede incluir polvo mineral, abrasión de materiales o resuspensión mecánica.',
    biological:
        'Incluye formas compatibles con material de origen biológico. Puede estar asociado a polen, restos vegetales, esporas u otras partículas naturales.',
    fibrous_synthetic_materials:
        'Describe partículas alargadas o fibrosas, compatibles con fibras sintéticas. Puede relacionarse con textiles, plásticos u otros materiales manufacturados.',
    industrial:
        'Agrupa partículas con patrones compatibles con procesos industriales. Puede reflejar mezclas complejas asociadas a manufactura, manipulación o emisiones técnicas.',
    mixed_unknown:
        'Indica una mezcla poco definida de rasgos morfológicos. Se usa cuando no hay una afinidad clara con una sola categoría interpretativa.',
};

function getPollutionLevelLabel(concentration: number): string {
    if (!Number.isFinite(concentration) || concentration < 0) {
        return 'Sin clasificar';
    }
    if (concentration <= 10) {
        return 'Nivel de contaminación Muy bueno, menos de 10 μg/m³';
    }
    if (concentration < 20) {
        return 'Nivel de contaminación Bueno, entre 10 y 19 μg/m³';
    }
    if (concentration < 50) {
        return 'Nivel de contaminación Moderado, entre 20 y 49 μg/m³';
    }
    if (concentration < 100) {
        return 'Nivel de contaminación Malo, entre 50 y 99 μg/m³';
    }
    if (concentration < 150) {
        return 'Nivel de contaminación Muy malo, entre 100 y 150 μg/m³';
    }
    return 'Nivel de contaminación Extremo, más de 150 μg/m³';
}

export default function ParticleAnalysisPage({ onOpenMap }: ParticleAnalysisPageProps) {
    const [step, setStep] = useState<Step>(1);
    const [isTestSensor, setIsTestSensor] = useState(false);
    const [sensorEnvironment, setSensorEnvironment] = useState<'indoor' | 'outdoor' | null>(null);
    const [stepFiveView, setStepFiveView] = useState<'results' | 'sources'>('results');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [locationName, setLocationName] = useState('');
    const [selectedLocationName, setSelectedLocationName] = useState('');
    const [markerLocation, setMarkerLocation] = useState<{ lat: number; lon: number } | null>(null);
    const [isResolvingLocation, setIsResolvingLocation] = useState(false);
    const [latitude, setLatitude] = useState<number | null>(null);
    const [longitude, setLongitude] = useState<number | null>(null);
    const [imageBase64, setImageBase64] = useState('');
    const [imagePreview, setImagePreview] = useState('');
    const [imageName, setImageName] = useState('');
    const [photoContext, setPhotoContext] = useState('');
    const [processed, setProcessed] = useState<ProcessedAnalysis | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isValidatingImage, setIsValidatingImage] = useState(false);
    const [isSearchingLocation, setIsSearchingLocation] = useState(false);
    const [showInvalidSensorModal, setShowInvalidSensorModal] = useState(false);
    const experiment = { startDate, endDate, latitude, longitude, imageBase64, photoContext, processed, sensorEnvironment };
    const [savedExperiment, setSavedExperiment] = useState<typeof experiment | null>(null);
    const isSaved = !isTestSensor && savedExperiment !== null &&
        savedExperiment.sensorEnvironment === sensorEnvironment &&
        savedExperiment.startDate === startDate && savedExperiment.endDate === endDate &&
        savedExperiment.latitude === latitude && savedExperiment.longitude === longitude &&
        savedExperiment.imageBase64 === imageBase64 && savedExperiment.photoContext === photoContext &&
        savedExperiment.processed === processed;
    const isBusy = isProcessing || isSubmitting || isValidatingImage || isSearchingLocation;

    const handleBack = () => {
        setErrorMessage('');
        setSuccessMessage('');
        if (step === 5 && stepFiveView === 'sources') {
            setStepFiveView('results');
        } else if (step > 1) {
            setStep((step - 1) as Step);
        }
    };

    const mapContainerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markerRef = useRef<L.Marker | null>(null);

    useEffect(() => {
        if (!markerLocation) return;
        const controller = new AbortController();
        // Wait for the marker to settle; cancel older lookups when it moves again.
        const timer = window.setTimeout(() => {
            void reverseGeocode(markerLocation.lat, markerLocation.lon, controller.signal)
                .then((name) => {
                    if (!controller.signal.aborted) setSelectedLocationName(name);
                })
                .catch(() => {
                    // Keep the new coordinates as the label when no address is available.
                })
                .finally(() => {
                    if (!controller.signal.aborted) setIsResolvingLocation(false);
                });
        }, 500);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [markerLocation]);

    const openNativeDatePicker = (input: HTMLInputElement) => {
        const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
        if (typeof pickerInput.showPicker === 'function') {
            try {
                pickerInput.showPicker();
            } catch {
                // Some browsers restrict showPicker in specific interaction contexts.
            }
        }
    };

    useEffect(() => {
        if (step !== 2 || latitude === null || longitude === null || !mapContainerRef.current) return;

        if (!mapRef.current) {
            mapRef.current = L.map(mapContainerRef.current).setView([latitude, longitude], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
            }).addTo(mapRef.current);

            markerRef.current = L.marker([latitude, longitude], { draggable: true }).addTo(mapRef.current);
            markerRef.current.on('dragend', () => {
                const pos = markerRef.current?.getLatLng();
                if (pos) {
                    setLatitude(pos.lat);
                    setLongitude(pos.lng);
                    setSelectedLocationName(`${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`);
                    setIsResolvingLocation(true);
                    setMarkerLocation({ lat: pos.lat, lon: pos.lng });
                }
            });
            return;
        }

        const currentZoom = mapRef.current.getZoom();
        mapRef.current.setView([latitude, longitude], currentZoom);
        if (markerRef.current) {
            markerRef.current.setLatLng([latitude, longitude]);
        }
    }, [step, latitude, longitude]);

    useEffect(() => {
        return () => {
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
                markerRef.current = null;
            }
        };
    }, [step]);

    const handleDatesNext = () => {
        setErrorMessage('');
        if (!sensorEnvironment) {
            setErrorMessage('Selecciona si el sensor es de interior o de exterior.');
            return;
        }
        if (!startDate || !endDate) {
            setErrorMessage('Introduce ambas fechas');
            return;
        }
        if (startDate > endDate) {
            setErrorMessage('La fecha de inicio debe ser anterior a la fecha de retirada');
            return;
        }
        setStep(2);
    };

    const handleSearchLocation = async () => {
        setErrorMessage('');
        const searchLocation = locationName.trim();
        if (!searchLocation) {
            setErrorMessage('Introduce una ubicación');
            return;
        }
        setIsSearchingLocation(true);
        try {
            const coords = await geocode(searchLocation);
            setLatitude(coords.lat);
            setLongitude(coords.lon);
            setSelectedLocationName(searchLocation);
            setMarkerLocation(null);
            setIsResolvingLocation(false);
        } catch {
            setErrorMessage('Localización no encontrada, por favor prueba de nuevo');
        } finally {
            setIsSearchingLocation(false);
        }
    };

    const handleConfirmLocation = () => {
        setErrorMessage('');
        if (latitude === null || longitude === null) {
            setErrorMessage('Confirma una localización válida');
            return;
        }
        setStep(3);
    };

    const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
            setErrorMessage('La imagen es demasiado pesada, por favor usa una menor a 10 MB.');
            event.target.value = '';
            return;
        }

        setErrorMessage('');
        setIsValidatingImage(true);
        const reader = new FileReader();
        reader.onerror = () => {
            setErrorMessage('No se pudo leer la imagen. Inténtalo de nuevo.');
            setIsValidatingImage(false);
            event.target.value = '';
        };
        reader.onload = async () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            setErrorMessage('');
            setSuccessMessage('');

            const nextImageBase64 = result.includes(',') ? result.split(',')[1] : result;

            try {
                const validation = await validateSensorImage(nextImageBase64);
                if (!validation.is_sensor) {
                    event.target.value = '';
                    setShowInvalidSensorModal(true);
                    return;
                }

                setImagePreview(result);
                setImageBase64(nextImageBase64);
                setImageName(file.name);
                setPhotoContext('');
                setProcessed(null);
                setStepFiveView('results');
                setSuccessMessage('');
            } catch (error) {
                event.target.value = '';
                if (error instanceof Error && error.message) {
                    setErrorMessage(error.message);
                } else {
                    setErrorMessage('No se pudo validar la imagen del sensor.');
                }
            } finally {
                setIsValidatingImage(false);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleAnalyzeImage = async () => {
        if (!imageBase64) {
            setErrorMessage('Sube una imagen del sensor');
            return;
        }
        if (photoContext.length === 0) {
            setErrorMessage('Añade un contexto para la fotografía antes de analizarla.');
            return;
        }

        setErrorMessage('');
        if (processed) {
            setStep(4);
            return;
        }
        setIsProcessing(true);

        try {
            const results = await processAnalysisImage(imageBase64);
            setProcessed(results);
            setStepFiveView('results');
            setStep(4);
        } catch (error) {
            console.error(error);
            if (error instanceof Error && error.message) {
                setErrorMessage(error.message);
            } else {
                setErrorMessage('No se ha detectado correctamente el área del sensor o el análisis ha fallado.');
            }
        } finally {
            setIsProcessing(false);
        }
    };

    const handleSubmit = async () => {
        if (latitude === null || longitude === null || !processed) return;
        if (!sensorEnvironment) {
            setErrorMessage('Selecciona si el sensor es de interior o de exterior.');
            return;
        }
        if (isTestSensor) {
            setErrorMessage('');
            setSuccessMessage('');
            setStepFiveView('results');
            setStep(5);
            return;
        }
        if (isSaved) {
            setErrorMessage('');
            setStepFiveView('results');
            setStep(5);
            return;
        }
        if (photoContext.length === 0) {
            setErrorMessage('Añade un contexto para la fotografía antes de guardar el resultado.');
            return;
        }

        const pm10Concentration = Number(
            processed.pollutionData?.PM10?.concentration_standard ??
            processed.pollutionData?.concentration_standard_pm10 ??
            0
        );
        const pm25Concentration = Number(
            processed.pollutionData?.PM25?.concentration_standard ??
            processed.pollutionData?.concentration_standard_pm25 ??
            0
        );
        const pollutionLevelPM10 = getPollutionLevelLabel(pm10Concentration);
        const pollutionLevelPM25 = getPollutionLevelLabel(pm25Concentration);
        const selectedModelType =
            processed.pollutionData?.selected_model_type === 'PM25' ? 'PM25' : 'PM10';
        const legacyConcentration =
            selectedModelType === 'PM25' ? pm25Concentration : pm10Concentration;
        const legacyPollutionLevel =
            selectedModelType === 'PM25' ? pollutionLevelPM25 : pollutionLevelPM10;

        setIsSubmitting(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            await submitExperiment({
                sensorEnvironment,
                startDate,
                endDate,
                latitude,
                longitude,
                pm10Concentration,
                pm25Concentration,
                concentration: legacyConcentration,
                pollutionLevel: legacyPollutionLevel,
                inputImageB64: imageBase64,
                context: photoContext,
                analysisResults: {
                    numContours: Number(processed.analysisResults?.num_contours || 0),
                    areaPercentage: Number(processed.analysisResults?.area_percentage || 0),
                },
                taxonomyModel: processed.taxonomyModel,
            });
            setSavedExperiment(experiment);
            setSuccessMessage('Resultado guardado correctamente.');
            setStepFiveView('results');
            setStep(5);
        } catch (error) {
            console.error(error);
            if (error instanceof Error && error.message) {
                setErrorMessage(error.message);
            } else {
                setErrorMessage('No se pudo guardar el experimento.');
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const pm10Concentration = Number(
        processed?.pollutionData?.PM10?.concentration_standard ??
        processed?.pollutionData?.concentration_standard_pm10 ??
        0
    );
    const pm25Concentration = Number(
        processed?.pollutionData?.PM25?.concentration_standard ??
        processed?.pollutionData?.concentration_standard_pm25 ??
        0
    );
    const areaPercentageRoundedUp = (
        Math.ceil(Number(processed?.analysisResults?.area_percentage || 0) * 1000) / 1000
    ).toFixed(3);
    const taxonomyRanking = processed?.taxonomyModel?.ranked_categories ?? [];
    const taxonomyTopCategory = processed?.taxonomyModel?.top_category_label ?? '';
    const taxonomyNote =
        processed?.taxonomyModel?.note ??
        'Este modelo probabilístico ofrece una estimación orientativa basada en compatibilidad con categorías posibles.';

    return (
        <div className="container mx-auto px-4 py-6">
            {showInvalidSensorModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
                        <h2 className="text-xl font-bold text-ami-azul">Imagen no válida</h2>
                        <p className="mt-3 text-sm leading-6 text-gray-700">
                            La imagen subida no parece corresponder a un sensor. Por favor, selecciona una foto real del sensor para continuar.
                        </p>
                        <div className="mt-5 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setShowInvalidSensorModal(false)}
                                className="rounded-lg bg-ami-azul px-4 py-2 text-white"
                            >
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-4xl mx-auto bg-white rounded-xl shadow-sm p-6">
                <div className="mb-4 space-y-2 text-center">
                    <h1 className="text-2xl font-bold text-ami-azul">
                        Herramienta Digital De Contaminación - Análisis De La Calidad Del Aire
                    </h1>
                    <p className="text-sm text-gray-700">
                        Bienvenido a la web de análisis de datos del proyecto AmIAire
                    </p>
                    <p className="text-sm text-gray-700">
                        En esta sencilla web de cinco pasos podrás:
                    </p>
                    <div className="inline-block text-left text-sm text-gray-700">
                        <p>1) Introducir las fechas del experimento</p>
                        <p>2) Seleccionar la ubicación exacta dónde estaba colocado el sensor</p>
                        <p>3) Subir la foto de tu sensor de vaselina</p>
                        <p>4) Validar si detectamos bien la zona del sensor a analizar</p>
                        <p>
                            5) Ver los resultados del análisis a nivel de concentración de material
                            particulado en el aire y explorar los datos en un mapa
                        </p>
                    </div>
                </div>

                <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div className="mb-3 flex items-center justify-between">
                        <p className="text-sm font-medium text-gray-700">
                            Progreso del registro: paso {step} de 5
                        </p>
                        <p className="text-sm font-semibold text-ami-azul">{STEP_TITLES[step]}</p>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                        <div
                            className="h-full rounded-full bg-ami-azul transition-all"
                            style={{ width: `${(step / 5) * 100}%` }}
                        />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-700 sm:grid-cols-5">
                        {(Object.entries(STEP_TITLES) as Array<[string, string]>).map(([stepNumber, label]) => {
                            const numericStep = Number(stepNumber);
                            const isCurrent = numericStep === step;
                            const isCompleted = numericStep < step;
                            return (
                                <p
                                    key={stepNumber}
                                    className={`${isCurrent ? 'font-semibold text-ami-azul' : ''} ${isCompleted ? 'text-emerald-700' : ''}`}
                                >
                                    {numericStep}. {label}
                                </p>
                            );
                        })}
                    </div>
                </div>

                {isTestSensor && (
                    <div className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        Sensor de prueba: podrás ver el análisis completo sin guardar los datos ni la imagen.
                    </div>
                )}

                {errorMessage && <div className="mb-4 rounded bg-red-100 text-red-800 px-3 py-2">{errorMessage}</div>}
                {successMessage && <div className="mb-4 rounded bg-green-100 text-green-800 px-3 py-2">{successMessage}</div>}

                {step > 1 && (
                    <button
                        type="button"
                        onClick={handleBack}
                        disabled={isBusy}
                        className="mb-4 rounded border border-gray-300 px-4 py-2 disabled:opacity-50"
                    >
                        {step === 5 && stepFiveView === 'sources' ? 'Volver a resultados' : 'Volver al paso anterior'}
                    </button>
                )}

                {step === 1 && (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleDatesNext();
                        }}
                    >
                        <h2 className="font-semibold text-lg">Paso 1. ¿Cuándo se hizo el experimento?</h2>
                        <fieldset>
                            <legend className="text-sm font-medium mb-2">Ubicación del sensor (obligatorio)</legend>
                            <div className="grid grid-cols-2 gap-2">
                                {(['indoor', 'outdoor'] as const).map((environment) => (
                                    <label
                                        key={environment}
                                        className={`flex items-center justify-center gap-2 rounded border px-3 py-3 cursor-pointer ${sensorEnvironment === environment ? 'border-ami-azul bg-ami-azul text-white' : 'border-gray-300 bg-white text-gray-800'}`}
                                    >
                                        <input
                                            type="radio"
                                            name="sensor-environment"
                                            value={environment}
                                            checked={sensorEnvironment === environment}
                                            onChange={() => setSensorEnvironment(environment)}
                                            required
                                            className="h-4 w-4 accent-ami-azul"
                                        />
                                        {environment === 'indoor' ? 'Sensor de interior' : 'Sensor de exterior'}
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <label className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                checked={isTestSensor}
                                onChange={(e) => setIsTestSensor(e.target.checked)}
                                aria-describedby="test-sensor-description"
                                className="h-5 w-5 accent-ami-azul"
                            />
                            <span className="font-medium">Sensor de prueba</span>
                        </label>
                        <p id="test-sensor-description" className="text-sm text-gray-700">
                            Marca esta opción para realizar todo el proceso y ver los resultados sin guardar
                            el sensor ni su imagen. Si la dejas sin marcar, el resultado se guardará al confirmar el área.
                        </p>
                        <div>
                            <label className="block text-sm mb-1">Fecha de colocación</label>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                onFocus={(e) => openNativeDatePicker(e.currentTarget)}
                                onClick={(e) => openNativeDatePicker(e.currentTarget)}
                                className="w-full border border-gray-300 rounded px-3 py-2"
                            />
                        </div>
                        <div>
                            <label className="block text-sm mb-1">Fecha de retirada</label>
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                onFocus={(e) => openNativeDatePicker(e.currentTarget)}
                                onClick={(e) => openNativeDatePicker(e.currentTarget)}
                                className="w-full border border-gray-300 rounded px-3 py-2"
                            />
                        </div>
                        <button
                            type="submit"
                            className="px-4 py-2 rounded bg-ami-azul text-white"
                        >
                            Siguiente
                        </button>
                    </form>
                )}

                {step === 2 && (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void handleSearchLocation();
                        }}
                    >
                        <h2 className="font-semibold text-lg">Paso 2. ¿Dónde se hizo el experimento?</h2>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={locationName}
                                onChange={(e) => setLocationName(e.target.value)}
                                placeholder="Ej.: Bilbao"
                                className="flex-1 border border-gray-300 rounded px-3 py-2"
                            />
                            <button
                                type="submit"
                                disabled={isSearchingLocation}
                                className="px-4 py-2 rounded bg-ami-azul text-white disabled:opacity-50"
                            >
                                {isSearchingLocation ? 'Buscando...' : 'Buscar'}
                            </button>
                        </div>
                        {latitude !== null && longitude !== null && (
                            <>
                                <p className="text-sm text-gray-600">
                                    Si el lugar buscado es aproximado, arrastra el marcador para fijar la posición exacta.
                                </p>
                                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                                    <p>
                                        <strong>Lugar seleccionado:</strong> {selectedLocationName || 'Ubicación buscada'}
                                    </p>
                                    {isResolvingLocation && (
                                        <p role="status">Buscando el nombre de la ubicación...</p>
                                    )}
                                    <p>
                                        <strong>Coordenadas:</strong> {latitude.toFixed(6)}, {longitude.toFixed(6)}
                                    </p>
                                </div>
                                <div ref={mapContainerRef} className="h-[400px] rounded border border-gray-200" />
                                <button
                                    type="button"
                                    onClick={handleConfirmLocation}
                                    disabled={isSearchingLocation}
                                    className="px-4 py-2 rounded bg-green-600 text-white disabled:opacity-50"
                                >
                                    Confirmar ubicación
                                </button>
                            </>
                        )}
                    </form>
                )}

                {step === 3 && (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void handleAnalyzeImage();
                        }}
                    >
                        <h2 className="font-semibold text-lg">Paso 3. Carga la imagen del sensor</h2>
                        <p className="text-sm text-gray-700">
                            El análisis calcula automáticamente PM10 y PM2.5.
                        </p>
                        <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium">Cómo debe verse la foto del sensor</p>
                                    <p>Sube una imagen donde se vea el sensor completo, con buena iluminación, pocos reflejos y el módulo del sensor bien definido.</p>
                                    <p className="mt-2 text-xs text-blue-800">Ejemplo orientativo: el sensor entra completo en el encuadre y el módulo se distingue bien.</p>
                                    <p className="mt-1">Formatos aceptados: JPG, JPEG, PNG y WEBP.</p>
                                </div>
                                <div className="shrink-0 self-start rounded-lg border border-blue-200 bg-white/80 p-2">
                                    <img
                                        src="/sensor-ejemplo.png"
                                        alt="Ejemplo de foto válida del sensor"
                                        className="h-28 w-28 rounded border border-gray-300 bg-white object-contain"
                                    />
                                </div>
                            </div>
                        </div>
                        <input type="file" accept="image/*" onChange={handleImageChange} disabled={isProcessing || isValidatingImage} />
                        {imageName && <p className="text-sm text-gray-600">Imagen seleccionada: {imageName}</p>}
                        {isValidatingImage && (
                            <p className="text-sm text-gray-600">
                                Validando que la imagen corresponda a un sensor...
                            </p>
                        )}
                        {imagePreview && (
                            <>
                                <img
                                    src={imagePreview}
                                    alt="Vista previa"
                                    className="max-h-[320px] rounded border border-gray-200"
                                />
                                <div>
                                    <label htmlFor="photo-context" className="block text-sm font-medium text-gray-800">
                                        Contexto de la fotografía <span className="text-red-600">*</span>
                                    </label>
                                    <p className="mt-1 text-sm leading-6 text-gray-700">
                                        ¿Quieres añadir algo de contexto sobre la foto? Por ejemplo: si hubo mucho sol,
                                        si el sensor estaba mojado o manchado, o si la cantidad de partículas te pareció
                                        mayor o menor de lo esperado.
                                    </p>
                                    <textarea
                                        id="photo-context"
                                        value={photoContext}
                                        onChange={(e) => setPhotoContext(e.target.value)}
                                        required
                                        rows={4}
                                        className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                                        placeholder="Escribe aquí tus observaciones"
                                    />
                                </div>
                            </>
                        )}
                        <button
                            type="submit"
                            disabled={isProcessing || isValidatingImage || (Boolean(imageBase64) && photoContext.length === 0)}
                            className="px-4 py-2 rounded bg-ami-azul text-white disabled:opacity-50"
                        >
                            {isProcessing ? 'Analizando...' : processed ? 'Continuar con el análisis anterior' : 'Analizar imagen'}
                        </button>
                    </form>
                )}

                {step === 4 && processed && (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void handleSubmit();
                        }}
                    >
                        <h2 className="font-semibold text-lg">Paso 4. Confirmación del área detectada del sensor</h2>
                        <p className="text-sm text-gray-700">
                            Verifica que el recorte del sensor incluya toda la zona útil y que no falten bordes importantes.
                            Si no es correcto, vuelve al paso anterior y sube otra imagen.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {processed.contourImageB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Detección de la región</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.contourImageB64}`}
                                        alt="Contour"
                                        className="rounded border border-gray-200"
                                    />
                                </div>
                            )}
                            {processed.roiImageB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Área recortada del sensor</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.roiImageB64}`}
                                        alt="Área recortada del sensor"
                                        className="rounded border border-gray-200"
                                    />
                                </div>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleBack}
                                disabled={isSubmitting}
                                className="px-4 py-2 rounded border border-gray-300 disabled:opacity-50"
                            >
                                No, reintentar
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className="px-4 py-2 rounded bg-green-600 text-white disabled:opacity-50"
                            >
                                {isSubmitting ? 'Guardando...' : isTestSensor ? 'Sí, ver resultados de prueba' : isSaved ? 'Volver a resultados' : 'Sí, guardar resultado'}
                            </button>
                        </div>
                    </form>
                )}

                {step === 5 && processed && stepFiveView === 'results' && (
                    <div className="space-y-4">
                        <h2 className="font-semibold text-lg">Resultados del análisis</h2>

                        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                            <p className="text-sm leading-6 text-gray-700">
                                A partir de la imagen del sensor, el sistema detecta el área del sensor,
                                extrae las partículas visibles, genera una máscara binaria para aislarlas y
                                calcula métricas que permiten estimar los niveles de PM10 y PM2.5.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {processed.contourImageB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Detección de la región</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.contourImageB64}`}
                                        alt="Contour"
                                        className="w-full h-64 object-contain rounded border border-gray-200 bg-white"
                                    />
                                </div>
                            )}
                            {processed.roiImageB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Área recortada del sensor</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.roiImageB64}`}
                                        alt="Área recortada del sensor"
                                        className="w-full h-64 object-contain rounded border border-gray-200 bg-white"
                                    />
                                </div>
                            )}
                            {processed.binaryB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Máscara binaria de partículas</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.binaryB64}`}
                                        alt="Binary"
                                        className="w-full h-64 object-contain rounded border border-gray-200 bg-white"
                                    />
                                </div>
                            )}
                            {processed.overlayB64 && (
                                <div>
                                    <h3 className="font-medium mb-2">Superposición final con contornos detectados</h3>
                                    <img
                                        src={`data:image/png;base64,${processed.overlayB64}`}
                                        alt="Overlay"
                                        className="w-full h-64 object-contain rounded border border-gray-200 bg-white"
                                    />
                                </div>
                            )}
                        </div>

                        <div className="bg-gray-50 rounded p-4 border border-gray-200 text-sm">
                            <p><strong>Concentración PM10:</strong> {pm10Concentration.toFixed(2)} μg/m³</p>
                            <p><strong>Concentración PM2.5:</strong> {pm25Concentration.toFixed(2)} μg/m³</p>
                            <p>
                                <strong>Número de contornos detectados </strong>
                                <strong>(en verde en la última imagen)</strong>
                                : {Number(processed.analysisResults?.num_contours || 0)}
                            </p>
                            <p><strong>Porcentaje de área detectada:</strong> {areaPercentageRoundedUp}%</p>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm border border-gray-200">
                                <thead className="bg-gray-100">
                                    <tr>
                                        <th className="text-left p-2 border-b">Nivel de Contaminación</th>
                                        <th className="text-left p-2 border-b">Concentración μg/m³</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {POLLUTION_LEVELS.map((level, index) => (
                                        <tr key={level.name}>
                                            <td className={`p-2 ${index < POLLUTION_LEVELS.length - 1 ? 'border-b' : ''}`}>
                                                <span className="inline-flex items-center gap-2">
                                                    <span
                                                        className="inline-block h-4 w-4 rounded border border-gray-800"
                                                        style={{ backgroundColor: level.color }}
                                                        aria-label={`Color ${level.name}`}
                                                        title={level.name}
                                                    />
                                                    <span>{level.name}</span>
                                                </span>
                                            </td>
                                            <td className={`p-2 ${index < POLLUTION_LEVELS.length - 1 ? 'border-b' : ''}`}>
                                                {level.range}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 px-4 py-4">
                            <p className="text-lg font-semibold text-emerald-900">
                                {isTestSensor ? 'Análisis de prueba completado. No se han guardado los datos ni la imagen.' : 'Resultado guardado con éxito.'}
                            </p>
                            <p className="mt-1 text-sm text-emerald-900">
                                Puedes seguir con la interpretación del análisis revisando las posibles fuentes contaminantes.
                            </p>
                        </div>

                        {taxonomyRanking.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => setStepFiveView('sources')}
                                className="px-4 py-2 rounded bg-ami-azul text-white"
                            >
                                Ver posibles fuentes contaminantes
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={onOpenMap}
                                className="px-4 py-2 rounded bg-ami-azul text-white"
                            >
                                Ver mapa de AmiAire
                            </button>
                        )}
                    </div>
                )}

                {step === 5 && processed && stepFiveView === 'sources' && taxonomyRanking.length > 0 && (
                    <div className="space-y-4">
                        <h2 className="font-semibold text-lg">Posibles fuentes contaminantes</h2>

                        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                <div>
                                    <h3 className="text-lg font-semibold text-amber-950">
                                        Compatibilidad estimada por categorías
                                    </h3>
                                    <p className="mt-1 text-sm leading-6 text-amber-900">
                                        La categoría con mayor compatibilidad en esta imagen es{' '}
                                        <strong>{taxonomyTopCategory}</strong>.
                                    </p>
                                </div>
                            </div>

                            <p className="mt-3 text-sm leading-6 text-amber-900">
                                {taxonomyNote}
                            </p>

                            <div className="mt-4 space-y-3">
                                {taxonomyRanking.map((item) => (
                                    <div key={item.category} className="rounded-lg border border-amber-100 bg-white p-3">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="relative group max-w-[80%]">
                                                <div className="flex items-center gap-2">
                                                    <p className="text-sm font-medium text-slate-900">
                                                        {item.label}
                                                    </p>
                                                    {TAXONOMY_CATEGORY_DESCRIPTIONS[item.category] && (
                                                        <span
                                                            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-[11px] font-semibold text-amber-900 cursor-help"
                                                            aria-label={`Información sobre ${item.label}`}
                                                            title={TAXONOMY_CATEGORY_DESCRIPTIONS[item.category]}
                                                        >
                                                            i
                                                        </span>
                                                    )}
                                                </div>
                                                {TAXONOMY_CATEGORY_DESCRIPTIONS[item.category] && (
                                                    <div className="pointer-events-none absolute left-0 top-full z-10 mt-2 hidden w-72 rounded-lg border border-amber-200 bg-white p-3 text-xs leading-5 text-slate-700 shadow-lg group-hover:block">
                                                        {TAXONOMY_CATEGORY_DESCRIPTIONS[item.category]}
                                                    </div>
                                                )}
                                            </div>
                                            <p className="text-sm font-semibold text-amber-900">
                                                {item.percentage.toFixed(1)}%
                                            </p>
                                        </div>
                                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-amber-100">
                                            <div
                                                className="h-full rounded-full bg-amber-500"
                                                style={{ width: `${Math.max(2, Math.min(100, item.percentage))}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <p className="mt-4 text-xs leading-5 text-amber-800">
                                Este reparto porcentual expresa compatibilidad relativa entre categorías
                                posibles. No identifica con certeza el contaminante real ni sustituye
                                una validación experta o química.
                            </p>
                        </div>

                        <div className="flex flex-wrap gap-3">
                            <button
                                type="button"
                                onClick={() => setStepFiveView('results')}
                                className="px-4 py-2 rounded border border-gray-300"
                            >
                                Volver a resultados
                            </button>
                            <button
                                type="button"
                                onClick={onOpenMap}
                                className="px-4 py-2 rounded bg-ami-azul text-white"
                            >
                                Ver mapa de AmiAire
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
