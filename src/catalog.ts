import type { EventKind, MetricKind } from "./types.js";

/** Energy metrics are also stored in kcal. */
export const ENERGY_METRICS = new Set(["dietary_energy", "active_energy", "basal_energy_burned"]);

const SUM = new Set([
  "active_energy",
  "apple_exercise_time",
  "apple_move_time",
  "apple_stand_time",
  "apple_stand_hour",
  "basal_energy_burned",
  "cycling_distance",
  "distance_downhill_snow_sports",
  "swimming_distance",
  "walking_running_distance",
  "wheelchair_distance",
  "flights_climbed",
  "push_count",
  "swimming_stroke_count",
  "step_count",
  "dietary_energy",
  "dietary_water",
  "dietary_sugar",
  "cholesterol",
  "carbohydrates",
  "protein",
  "total_fat",
  "saturated_fat",
  "monounsaturated_fat",
  "polyunsaturated_fat",
  "fiber",
  "sodium",
  "potassium",
  "calcium",
  "iron",
  "magnesium",
  "phosphorus",
  "zinc",
  "copper",
  "manganese",
  "selenium",
  "iodine",
  "chromium",
  "molybdenum",
  "chloride",
  "caffeine",
  "biotin",
  "folate",
  "niacin",
  "pantothenic_acid",
  "riboflavin",
  "thiamin",
  "vitamin_a",
  "vitamin_b6",
  "vitamin_b12",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  "insulin_delivery",
  "mindful_minutes",
  "time_in_daylight",
  "uv_exposure",
  "alcohol_consumption",
  "number_of_times_fallen",
  "inhaler_usage",
]);

const LATEST = new Set([
  "height",
  "weight_body_mass",
  "body_mass",
  "weight",
  "waist_circumference",
  "body_fat_percentage",
  "body_mass_index",
  "lean_body_mass",
  "vo2_max",
  "blood_alcohol_content",
  "six_minute_walk_test_distance",
]);

const MIN_AVG_MAX = new Set([
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "heart_rate_variability_sdnn",
  "recovery_hrv",
  "cardio_recovery",
  "walking_heart_rate_average",
  "atrial_fibrillation_burden",
  "walking_speed",
  "walking_step_length",
  "walking_asymmetry_percentage",
  "walking_double_support_percentage",
  "stair_ascent_speed",
  "stair_descent_speed",
  "running_ground_contact_time",
  "running_stride_length",
  "running_vertical_oscillation",
  "respiratory_rate",
  "forced_expiratory_volume",
  "forced_vital_capacity",
  "oxygen_saturation",
  "blood_oxygen",
  "peripheral_perfusion_index",
  "peak_expiratory_flow_rate",
  "body_temperature",
  "basal_body_temperature",
  "apple_sleeping_wrist_temperature",
  "environmental_audio_exposure",
  "headphone_audio_exposure",
  "underwater_temperature",
  "underwater_depth",
  "electrodermal_activity",
  "cycling_cadence",
  "cycling_power",
  "cycling_speed",
  "cycling_functional_threshold_power",
  "running_power",
  "running_speed",
  "physical_effort",
  "blood_glucose",
  "breathing_disturbances",
]);

const SPECIAL: Record<string, MetricKind> = {
  sleep_analysis: "sleep",
  blood_pressure: "blood_pressure",
  handwashing: "duration_label",
  toothbrushing: "duration_label",
  sexual_activity: "category_count",
};

/** How a stored metric rolls up to one row per day. Unknown names stay `quantity` and are summed. */
export function kindFor(metric: string): MetricKind {
  if (SPECIAL[metric]) return SPECIAL[metric];
  if (SUM.has(metric)) return "sum";
  if (LATEST.has(metric)) return "latest";
  if (MIN_AVG_MAX.has(metric)) return "min_avg_max";
  return "quantity";
}

export function toKcal(qty: number, units: unknown): number {
  return typeof units === "string" && /^kj$/i.test(units.trim()) ? qty / 4.184 : qty;
}

const HK_QUANTITY: Record<string, string> = {
  DietaryEnergyConsumed: "dietary_energy",
  DietaryProtein: "protein",
  DietaryCarbohydrates: "carbohydrates",
  DietaryFatTotal: "total_fat",
  DietaryFatSaturated: "saturated_fat",
  DietaryFatMonounsaturated: "monounsaturated_fat",
  DietaryFatPolyunsaturated: "polyunsaturated_fat",
  DietaryWater: "dietary_water",
  DietarySugar: "dietary_sugar",
  DietaryCaffeine: "caffeine",
  DietaryCholesterol: "cholesterol",
  DietaryFiber: "fiber",
  DietarySodium: "sodium",
  DietaryPotassium: "potassium",
  DietaryCalcium: "calcium",
  DietaryIron: "iron",
  DietaryVitaminA: "vitamin_a",
  DietaryVitaminB6: "vitamin_b6",
  DietaryVitaminB12: "vitamin_b12",
  DietaryVitaminC: "vitamin_c",
  DietaryVitaminD: "vitamin_d",
  DietaryVitaminE: "vitamin_e",
  DietaryVitaminK: "vitamin_k",
  ActiveEnergyBurned: "active_energy",
  BasalEnergyBurned: "basal_energy_burned",
  StepCount: "step_count",
  BodyMass: "weight_body_mass",
  BodyFatPercentage: "body_fat_percentage",
  BodyMassIndex: "body_mass_index",
  LeanBodyMass: "lean_body_mass",
  Height: "height",
  WaistCircumference: "waist_circumference",
  HeartRate: "heart_rate",
  RestingHeartRate: "resting_heart_rate",
  HeartRateVariabilitySDNN: "heart_rate_variability",
  HeartRateRecoveryOneMinute: "cardio_recovery",
  WalkingHeartRateAverage: "walking_heart_rate_average",
  OxygenSaturation: "oxygen_saturation",
  BloodGlucose: "blood_glucose",
  InsulinDelivery: "insulin_delivery",
  AppleExerciseTime: "apple_exercise_time",
  AppleMoveTime: "apple_move_time",
  AppleStandTime: "apple_stand_time",
  DistanceWalkingRunning: "walking_running_distance",
  DistanceCycling: "cycling_distance",
  DistanceSwimming: "swimming_distance",
  DistanceWheelchair: "wheelchair_distance",
  FlightsClimbed: "flights_climbed",
  RespiratoryRate: "respiratory_rate",
  VO2Max: "vo2_max",
  AppleSleepingWristTemperature: "apple_sleeping_wrist_temperature",
  TimeInDaylight: "time_in_daylight",
  UVExposure: "uv_exposure",
  EnvironmentalAudioExposure: "environmental_audio_exposure",
  HeadphoneAudioExposure: "headphone_audio_exposure",
  PhysicalEffort: "physical_effort",
  BloodPressureSystolic: "blood_pressure",
  BloodPressureDiastolic: "blood_pressure",
};

export function snakeCaseIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function wordsFromIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

const HK_QUANTITY_PREFIX = "HKQuantityTypeIdentifier";

/** Metric name for an HKQuantityTypeIdentifier, or null when `type` is not one. */
export function hkQuantityMetric(type: unknown): string | null {
  const text = String(type || "");
  if (!text.startsWith(HK_QUANTITY_PREFIX)) return null;
  const name = text.slice(HK_QUANTITY_PREFIX.length);
  if (!name) return null;
  return HK_QUANTITY[name] || snakeCaseIdentifier(name);
}

export function hkSide(type: unknown): "systolic" | "diastolic" | null {
  const text = String(type || "");
  if (text.endsWith("BloodPressureSystolic")) return "systolic";
  if (text.endsWith("BloodPressureDiastolic")) return "diastolic";
  return null;
}

const WORKOUT_ACTIVITIES: Record<number, string> = {
  1: "AmericanFootball",
  13: "Cycling",
  20: "FunctionalStrengthTraining",
  24: "Hiking",
  35: "Rowing",
  37: "Running",
  46: "Swimming",
  50: "TraditionalStrengthTraining",
  52: "Walking",
  57: "Yoga",
  63: "HighIntensityIntervalTraining",
  3000: "Other",
};

export function hkWorkoutName(type: unknown): string {
  if (typeof type === "number" && Number.isFinite(type)) {
    return wordsFromIdentifier(WORKOUT_ACTIVITIES[type] || `Workout${type}`);
  }
  const text = String(type ?? "").trim();
  if (/^\d+$/.test(text)) return hkWorkoutName(Number(text));
  const name = text.startsWith("HKWorkoutActivityType") ? text.slice("HKWorkoutActivityType".length) : text;
  return wordsFromIdentifier(name) || "Workout";
}

const SYMPTOMS = new Set([
  "AbdominalCramps",
  "Bloating",
  "Constipation",
  "Diarrhea",
  "Heartburn",
  "Nausea",
  "Vomiting",
  "AppetiteChanges",
  "Chills",
  "Dizziness",
  "Fainting",
  "Fatigue",
  "Fever",
  "GeneralizedBodyAche",
  "BodyAche",
  "HotFlashes",
  "ChestTightnessOrPain",
  "Coughing",
  "RapidPoundingOrFlutteringHeartbeat",
  "ShortnessOfBreath",
  "SkippedHeartbeat",
  "Wheezing",
  "LowerBackPain",
  "Headache",
  "MemoryLapse",
  "MoodChanges",
  "LossOfSmell",
  "LossOfTaste",
  "RunnyNose",
  "SoreThroat",
  "SinusCongestion",
  "BreastPain",
  "PelvicPain",
  "VaginalDryness",
  "Acne",
  "DrySkin",
  "HairLoss",
  "NightSweats",
  "SleepChanges",
  "BladderIncontinence",
]);

const CYCLE = new Set([
  "CervicalMucusQuality",
  "Contraceptive",
  "InfrequentMenstrualCycles",
  "IntermenstrualBleeding",
  "IrregularMenstrualCycles",
  "Lactation",
  "MenstrualFlow",
  "OvulationTestResult",
  "PersistentIntermenstrualBleeding",
  "Pregnancy",
  "PregnancyTestResult",
  "ProgesteroneTestResult",
  "ProlongedMenstrualPeriods",
  "SexualActivity",
]);

const CATEGORY_PREFIX = "HKCategoryTypeIdentifier";

export function categorySuffix(type: unknown): string | null {
  const text = String(type || "");
  if (!text.startsWith(CATEGORY_PREFIX)) return null;
  const name = text.slice(CATEGORY_PREFIX.length);
  return name || null;
}

export function categoryEventKind(suffix: string): EventKind | null {
  if (SYMPTOMS.has(suffix)) return "symptom";
  if (CYCLE.has(suffix) && suffix !== "SexualActivity") return "cycle";
  if (suffix === "HighHeartRateEvent" || suffix === "LowHeartRateEvent" || suffix === "IrregularHeartRhythmEvent") {
    return "heart_rate_notification";
  }
  return null;
}

export function sleepLabel(value: string): string {
  const text = value.replace(/^HKCategoryValueSleepAnalysis/, "");
  const labels: Record<string, string> = {
    InBed: "In Bed",
    AsleepUnspecified: "Asleep",
    Asleep: "Asleep",
    Awake: "Awake",
    AsleepCore: "Core",
    AsleepDeep: "Deep",
    AsleepREM: "REM",
    Unspecified: "Unspecified",
  };
  return labels[text] || wordsFromIdentifier(text);
}

/** Summary fields filled from the metric registry. */
export const SUMMARY_METRICS = {
  dietary_energy: "dietary_kcal",
  protein: "protein_g",
  carbohydrates: "carbs_g",
  total_fat: "fat_g",
  active_energy: "active_kcal",
  basal_energy_burned: "basal_kcal",
  step_count: "steps",
} as const;
