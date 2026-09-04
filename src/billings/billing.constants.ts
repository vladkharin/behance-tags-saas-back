export interface PlanConfig {
  priceRub: number;
  priceUsd: number;
  tags: number;
  label: string;
  envOfferKey: string;
}

export interface FuelConfig {
  priceRub: number;
  priceUsd: number;
  tags: number;
  label: string;
  envOfferKey: string;
}

export const PLANS_CONFIG: Record<string, PlanConfig> = {
  DAILY_FRESH: {
    priceRub: 390,
    priceUsd: 3.99,
    tags: 1500,
    label: 'Daily Fresh Plan',
    envOfferKey: 'LAVA_OFFER_ID_DAILY_FRESH',
  },
  PRO_STREAM: {
    priceRub: 890,
    priceUsd: 8.99,
    tags: 6000,
    label: 'Pro Stream Plan',
    envOfferKey: 'LAVA_OFFER_ID_PRO_STREAM',
  },
};

export const FUEL_CONFIG: Record<string, FuelConfig> = {
  '500': {
    priceRub: 149,
    priceUsd: 1.49,
    tags: 500,
    label: 'Fuel Pack 500',
    envOfferKey: 'LAVA_OFFER_ID_500',
  },
  '2000': {
    priceRub: 390,
    priceUsd: 3.99,
    tags: 2000,
    label: 'Fuel Pack 2000',
    envOfferKey: 'LAVA_OFFER_ID_2000',
  },
};
