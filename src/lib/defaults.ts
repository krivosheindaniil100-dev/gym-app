import type { Profile } from './types';
import { GOAL_DEFAULT_PROTEIN, GOAL_DEFAULT_RATE } from './nutrition';

export const DEFAULT_PROFILE: Profile = {
  name: '',
  sex: 'male',
  birthYear: 1995,
  heightCm: 178,
  goal: 'cut',
  weeklyRatePct: GOAL_DEFAULT_RATE.cut,
  activityMode: 'lifestyle',
  activityFactor: 1.35,
  proteinPerKgFfm: GOAL_DEFAULT_PROTEIN.cut,
  fatPerKgBw: 0.8,
  calibrate: false,
  food: { diet: 'omnivore', exclude: [], likes: [], sweetTooth: false, maxCookMinutes: 60, mealsPerDay: 4 },
  training: {
    goal: 'cut',
    experience: 'intermediate',
    daysPerWeek: 3,
    sessionMinutes: 60,
    place: 'gym',
    intensity: 'moderate',
    priority: [],
    avoid: [],
    cardio: 'after',
  },
};

