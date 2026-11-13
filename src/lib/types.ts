// ───────────────────────── Shared domain types ─────────────────────────

export type Sex = 'male' | 'female';

/** Nutrition values per 100 g of product (or per 100 ml for liquids). */
export interface Per100 {
  kcal: number;
  p: number; // protein, g
  f: number; // fat, g
  c: number; // carbohydrates, g
  fiber?: number; // g
}

export type FoodCategory =
  | 'meat'
  | 'poultry'
  | 'fish'
  | 'seafood'
  | 'eggs'
  | 'dairy'
  | 'grains'
  | 'bread'
  | 'pasta'
  | 'legumes'
  | 'vegetables'
  | 'fruits'
  | 'berries'
  | 'nuts'
  | 'oils'
  | 'sweets'
  | 'drinks'
  | 'sauces'
  | 'ready'
  | 'sport'
  | 'other';

/** Diet / allergy flags a product may carry. */
export type DietFlag =
  | 'pork'
  | 'beef'
  | 'meat' // any red meat / poultry
  | 'fish'
  | 'seafood'
  | 'dairy'
  | 'lactose'
  | 'eggs'
  | 'gluten'
  | 'nuts'
  | 'soy'
  | 'sugar'
  | 'alcohol';

export interface FoodUnit {
  /** e.g. "шт", "ст. л.", "стакан", "ломтик" */
  label: string;
  grams: number;
}

export interface Food {
  id: string;
  name: string; // Russian
  category: FoodCategory;
  per100: Per100;
  /** Handy household units, e.g. 1 egg = 55 g. */
  units?: FoodUnit[];
  flags?: DietFlag[];
  /** Whether values are for the raw/dry product ("сухой", "сырой") – important for grains/meat. */
  state?: 'raw' | 'cooked' | 'dry' | 'ready';
  brand?: string;
  barcode?: string;
  source?: 'base' | 'custom' | 'off';
  imageUrl?: string;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface RecipeIngredient {
  foodId: string; // must reference a Food.id from the base DB
  grams: number; // for the WHOLE recipe (all servings)
}

export interface Recipe {
  id: string;
  name: string; // Russian
  slots: MealSlot[];
  servings: number;
  minutes: number; // total active+passive cooking time
  ingredients: RecipeIngredient[];
  steps: string[]; // short Russian steps
  tags: string[]; // e.g. 'быстро', 'высокобелковое', 'сладкое', 'без готовки', 'запеканка'
  /** Optional: cooked yield weight of the whole recipe in grams (to show portion size in grams). */
  yieldGrams?: number;
}

export type MuscleGroup =
  | 'chest'
  | 'back' // lats + mid back
  | 'traps'
  | 'shoulders' // front/side delts
  | 'rear_delts'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'abs'
  | 'obliques'
  | 'lower_back'
  | 'glutes'
  | 'quads'
  | 'hamstrings'
  | 'adductors'
  | 'calves';

export type Equipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'pullup_bar'
  | 'bench'
  | 'kettlebell'
  | 'band';

export type MovementPattern =
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'isolation_upper'
  | 'isolation_lower'
  | 'core'
  | 'carry';

export type JointStress = 'knees' | 'lower_back' | 'shoulders' | 'elbows' | 'wrists';

export interface Exercise {
  id: string;
  name: string; // Russian
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
  equipment: Equipment[]; // ALL items required
  pattern: MovementPattern;
  compound: boolean;
  level: 1 | 2 | 3; // 1 = beginner friendly, 3 = advanced technique
  /** Joints noticeably loaded – used to exclude exercises for injuries. */
  stress: JointStress[];
  /** Short technique cue in Russian (one sentence). */
  cue: string;
  /** For unilateral exercises reps are per side. */
  unilateral?: boolean;
  /** Typical starting load in kg for an untrained adult male (0 = bodyweight). Used only as a hint. */
  startKg?: number;
  /** True for timed exercises like plank (reps = seconds). */
  timed?: boolean;
}

// ───────────────────────── User data ─────────────────────────

export interface Measurement {
  id: string;
  /** ISO timestamp */
  date: string;
  source: 'qr' | 'manual';
  weight: number; // kg
  fatPct: number; // %
  fatKg: number; // kg
  /** Skeletal muscle mass, kg */
  smm?: number;
  /** Fat-free mass, kg */
  ffm: number;
  water?: number; // total body water, kg (L)
  visceral?: number; // visceral fat level
  bmr?: number; // device reported BMR
  raw?: string; // raw QR payload
  note?: string;
}

export interface FoodEntry {
  id: string;
  time: string; // ISO
  meal: MealSlot;
  name: string;
  brand?: string;
  foodId?: string;
  grams: number;
  /** Snapshot of nutrition per 100 g at the moment of logging (history must not change later). */
  per100: Per100;
}

export interface ActivityEntry {
  id: string;
  time: string;
  name: string;
  minutes: number;
  met?: number;
  /** Net kcal (above resting) – what is added to expenditure. */
  kcal: number;
  source: 'workout' | 'cardio' | 'manual';
  sessionId?: string;
}

export interface DayActivity {
  steps?: number;
  /** "Active calories" from a watch / Samsung Health, entered manually. */
  watchActiveKcal?: number;
  activities: ActivityEntry[];
}

export type Goal = 'cut' | 'recomp' | 'maintain' | 'bulk';
export type ActivityMode = 'lifestyle' | 'steps' | 'watch';
export type Experience = 'novice' | 'intermediate' | 'advanced';
export type TrainingPlace = 'gym' | 'home_dumbbells' | 'home_bodyweight';

export interface FoodPrefs {
  diet: 'omnivore' | 'no_pork' | 'pescatarian' | 'vegetarian';
  exclude: DietFlag[]; // allergies / dislikes
  likes: FoodCategory[];
  sweetTooth: boolean;
  maxCookMinutes: number;
  mealsPerDay: 3 | 4 | 5;
}

export interface TrainingPrefs {
  goal: Goal;
  experience: Experience;
  daysPerWeek: 2 | 3 | 4 | 5 | 6;
  sessionMinutes: 30 | 45 | 60 | 75 | 90;
  place: TrainingPlace;
  intensity: 'light' | 'moderate' | 'hard';
  priority: MuscleGroup[];
  avoid: JointStress[];
  cardio: 'none' | 'after' | 'separate';
}

export interface Profile {
  name: string;
  sex: Sex;
  birthYear: number;
  heightCm: number;
  goal: Goal;
  /** Desired weekly change as % of body weight (negative = loss). */
  weeklyRatePct: number;
  targetFatPct?: number;
  activityMode: ActivityMode;
  /** NEAT multiplier for lifestyle mode (without workouts). */
  activityFactor: number;
  proteinPerKgFfm: number;
  fatPerKgBw: number;
  calibrate: boolean;
  food: FoodPrefs;
  training: TrainingPrefs;
}

export interface PlannedExercise {
  exerciseId: string;
  sets: number;
  repMin: number;
  repMax: number;
  rir: number;
  restSec: number;
  note?: string;
}

export interface PlannedDay {
  id: string;
  name: string; // "Верх A"
  focus: string; // short description
  exercises: PlannedExercise[];
  cardio?: { name: string; minutes: number; met: number; note: string };
  estMinutes: number;
}

export interface TrainingPlan {
  id: string;
  createdAt: string;
  prefs: TrainingPrefs;
  splitName: string;
  rationale: string[];
  days: PlannedDay[];
  /** weekday index (0=Mon) → day id or 'rest' */
  schedule: (string | 'rest')[];
  weeklySets: Partial<Record<MuscleGroup, number>>;
  tips: string[];
}

export interface LoggedSet {
  weight: number;
  reps: number;
  done: boolean;
}

export interface SessionExercise {
  exerciseId: string;
  sets: LoggedSet[];
}

export interface WorkoutSession {
  id: string;
  date: string; // ISO start
  dayId: string;
  dayName: string;
  minutes: number;
  intensity: 'light' | 'moderate' | 'hard';
  exercises: SessionExercise[];
  kcal: number; // net
  finished: boolean;
}
