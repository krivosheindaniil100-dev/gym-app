/** MET values (Compendium of Physical Activities, 2024, rounded). */
export interface ActivityType {
  id: string;
  name: string;
  met: number;
  group: 'cardio' | 'sport' | 'strength' | 'daily';
}

export const ACTIVITIES: ActivityType[] = [
  { id: 'walk_4', name: 'Ходьба спокойная (4 км/ч)', met: 3.0, group: 'cardio' },
  { id: 'walk_5', name: 'Ходьба (5 км/ч)', met: 3.5, group: 'cardio' },
  { id: 'walk_6', name: 'Быстрая ходьба (6 км/ч)', met: 4.3, group: 'cardio' },
  { id: 'walk_incline', name: 'Ходьба в горку / беговая дорожка с наклоном', met: 6.0, group: 'cardio' },
  { id: 'run_8', name: 'Бег (8 км/ч)', met: 8.3, group: 'cardio' },
  { id: 'run_10', name: 'Бег (10 км/ч)', met: 9.8, group: 'cardio' },
  { id: 'run_12', name: 'Бег (12 км/ч)', met: 11.0, group: 'cardio' },
  { id: 'bike_mod', name: 'Велосипед / велотренажёр умеренно', met: 6.8, group: 'cardio' },
  { id: 'bike_hard', name: 'Велосипед интенсивно', met: 8.8, group: 'cardio' },
  { id: 'elliptical', name: 'Эллипс', met: 5.0, group: 'cardio' },
  { id: 'rower', name: 'Гребной тренажёр', met: 7.0, group: 'cardio' },
  { id: 'stairs', name: 'Степпер / подъём по лестнице', met: 8.8, group: 'cardio' },
  { id: 'swim_mod', name: 'Плавание умеренно', met: 5.8, group: 'cardio' },
  { id: 'swim_hard', name: 'Плавание интенсивно', met: 9.8, group: 'cardio' },
  { id: 'rope', name: 'Скакалка', met: 11.8, group: 'cardio' },
  { id: 'hiit', name: 'HIIT / круговая тренировка', met: 8.0, group: 'cardio' },
  { id: 'strength_light', name: 'Силовая тренировка лёгкая', met: 3.5, group: 'strength' },
  { id: 'strength_mod', name: 'Силовая тренировка средняя', met: 5.0, group: 'strength' },
  { id: 'strength_hard', name: 'Силовая тренировка тяжёлая', met: 6.0, group: 'strength' },
  { id: 'yoga', name: 'Йога / растяжка', met: 2.5, group: 'sport' },
  { id: 'pilates', name: 'Пилатес', met: 3.0, group: 'sport' },
  { id: 'football', name: 'Футбол', met: 7.0, group: 'sport' },
  { id: 'basketball', name: 'Баскетбол', met: 6.5, group: 'sport' },
  { id: 'tennis', name: 'Теннис', met: 7.3, group: 'sport' },
  { id: 'boxing_bag', name: 'Бокс (мешок)', met: 5.5, group: 'sport' },
  { id: 'martial', name: 'Единоборства (спарринг)', met: 10.3, group: 'sport' },
  { id: 'dance', name: 'Танцы', met: 5.0, group: 'sport' },
  { id: 'ski', name: 'Лыжи беговые', met: 9.0, group: 'sport' },
  { id: 'skate', name: 'Коньки', met: 7.0, group: 'sport' },
  { id: 'clean', name: 'Уборка / домашние дела', met: 3.3, group: 'daily' },
  { id: 'garden', name: 'Работа в саду', met: 3.8, group: 'daily' },
];

export const CARDIO_FOR_PLAN = {
  liss: { name: 'Ходьба в горку (LISS)', met: 6.0 },
  bike: { name: 'Велотренажёр умеренно', met: 6.8 },
  hiit: { name: 'Интервалы на велотренажёре', met: 8.0 },
};
